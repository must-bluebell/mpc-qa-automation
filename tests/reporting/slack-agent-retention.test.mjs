import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentStore, consumeRequests } from '../../pipeline/slack-agent/store.mjs'
import { createAgent } from '../../pipeline/slack-agent/agent.mjs'
import { agentSettings } from '../../pipeline/slack-agent/policy.mjs'
const start=Date.parse('2026-10-23T05:00:00Z'),day=86400000
const settings=agentSettings({QA_SLACK_AGENT_ENABLED:'1',QA_SLACK_TEAM_ID:'T123',SLACK_CHANNEL_ID:'C123',QA_SLACK_ALLOWED_USER_IDS:'U123'})
const identity={team:'T123',channel:'C123',user:'U123',thread:'123.456'}
const id=n=>n.toString(16).padStart(32,'0')
const event=n=>({id:id(n),type:'event',status:'handled',at:new Date(start).toISOString()})
function fixture(t) {
  const directory=mkdtempSync(join(tmpdir(),'qa-retention-'));t.after(()=>rmSync(directory,{recursive:true,force:true}))
  let time=start
  return {directory,store:new AgentStore(directory,{now:()=>time}),advance:()=>{time+=32*day;return time}}
}

test('legacy migration indexes active work and repeated polls never enumerate historical records',async t=>{
  const {directory,store}=fixture(t)
  for(let n=1;n<=200;n++)writeFileSync(join(directory,`${id(n)}.json`),JSON.stringify(event(n)))
  const request=store.propose('legacy-active',identity,'api','local-docker',settings,start)
  store.decide(request.id,identity,'confirm',settings,start)
  store.maintain()
  const restarted=new AgentStore(directory,{now:()=>start})
  let reads=0
  const get=restarted.get.bind(restarted);restarted.get=id=>{reads++;return get(id)}
  restarted.list=()=>{throw new Error('Historical listing on hot path')}
  const state={jobs:[]}
  consumeRequests(state,{store:restarted,settings,now:start,persist:()=>{}})
  const agent=createAgent({store:restarted,settings:()=>settings,now:()=>start,post:async()=>({}),read:()=>null,jobs:()=>state})
  await agent.poll();await agent.poll()
  assert.ok(reads<30,`Read ${reads} records for one active request`)
  assert.equal(state.jobs.length,1)
})

test('retention expires terminal dedupe after 30 days and never removes pending replies or scheduled work',async t=>{
  const {directory,store,advance}=fixture(t)
  store.write(event(1))
  let posts=0
  await store.deliver('retry',{text:'retry'},async()=>{posts++;throw {code:'slack_webapi_rate_limited_error'}},start)
  await store.deliver('sent',{text:'sent'},async()=>{posts++;return {}},start)
  const request=store.propose('scheduled',identity,'api','local-docker',settings,start)
  store.decide(request.id,identity,'confirm',settings,start)
  consumeRequests({jobs:[]},{store,settings,now:start,persist:()=>{}})
  const future=advance()
  store.maintain()
  assert.equal(store.get(id(1)),null)
  assert.equal(store.listActive().find(r=>r.type==='reply').status,'pending')
  assert.equal(store.get(request.id).status,'scheduled')
  const restarted=new AgentStore(directory,{now:()=>future})
  await restarted.deliver('retry',{text:'retry'},async()=>{posts++;return {}},future)
  assert.equal(posts,3)
  assert.equal(restarted.listActive().length,1)
})

test('an interrupted index update recovers legacy records without losing retries',t=>{
  const {directory,store}=fixture(t)
  store.write(event(1))
  const record={id:id(2),type:'reply',key:'pending',payload:{text:'safe'},status:'pending',updatedAt:new Date(start).toISOString()}
  writeFileSync(join(directory,`${record.id}.json`),JSON.stringify(record))
  writeFileSync(join(directory,'active-index.dirty'),'interrupted')
  assert.equal(new AgentStore(directory).listActive()[0].id,record.id)
  assert.equal(existsSync(join(directory,'active-index.dirty')),false)
})

test('corrupt legacy records or index metadata fail closed without pruning evidence',t=>{
  const {directory,store,advance}=fixture(t)
  writeFileSync(join(directory,`${id(1)}.json`),'{')
  assert.throws(()=>store.listActive(),/unreadable|corrupt/i)
  assert.equal(existsSync(join(directory,`${id(1)}.json`)),true)
  writeFileSync(join(directory,`${id(1)}.json`),JSON.stringify(event(1)))
  store.listActive()
  writeFileSync(join(directory,'active-index.json'),'{')
  advance()
  assert.throws(()=>store.maintain(),/unreadable|corrupt/i)
  assert.equal(JSON.parse(readFileSync(join(directory,`${id(1)}.json`))).id,id(1))
})

test('expired notification leaves the active index after a durable rate-limit retry and survives retention',async t=>{
  const {store,advance}=fixture(t)
  const request=store.propose('expires',identity,'api','local-docker',settings,start)
  const agent=createAgent({store,settings:()=>settings,now:()=>start+300000,post:async()=>{throw {code:'slack_webapi_rate_limited_error'}}})
  await agent.poll()
  assert.ok(store.get(request.id).notifiedAt)
  advance();store.maintain()
  assert.equal(store.listActive().length,1)
  assert.equal(store.listActive()[0].status,'pending')
})


test('independent store instances see each other’s index updates and retention preserves in-flight dedupe',async t=>{
  const {directory,store,advance}=fixture(t)
  const other=new AgentStore(directory,{now:()=>start})
  assert.deepEqual(other.listActive(),[])
  const request=store.propose('two-processes',identity,'api','local-docker',settings,start)
  assert.equal(other.listActive()[0].id,request.id)
  other.decide(request.id,identity,'confirm',settings,start)
  consumeRequests({jobs:[]},{store,settings,now:start,persist:()=>{}})
  let calls=0
  await store.deliver(`end:${request.id}`,{text:'complete'},async()=>{calls++;return {}},start)
  advance();store.maintain()
  await store.deliver(`end:${request.id}`,{text:'complete'},async()=>{calls++;return {}},start+32*day)
  assert.equal(calls,1)
  assert.equal(other.listActive()[0].status,'scheduled')
})

test('corrupt retention timestamps cannot be used to delete terminal evidence',t=>{
  const {directory,store,advance}=fixture(t)
  const r=store.write(event(1))
  writeFileSync(join(directory,`${r.id}.json`),JSON.stringify({...r,retainedAt:'broken'}))
  assert.throws(()=>store.get(r.id),/unreadable|corrupt/i)
  advance()
  assert.throws(()=>store.maintain(),/unreadable|corrupt/i)
  assert.ok(existsSync(join(directory,`${r.id}.json`)))
})

test('revoked terminal notices age out while pending confirmations and scheduled reruns stay protected',async t=>{
  const {store,advance}=fixture(t)
  const expired=store.propose('revoked-expired',identity,'api','local-docker',settings,start)
  store.expirePending(start+300000)
  const pending=store.propose('pending-retained',identity,'api','local-docker',settings,start+300000)
  const agent=createAgent({store,settings:()=>({...settings,team:'T999'}),now:()=>start+300000,post:async()=>{throw new Error('must not post')}})
  await agent.poll()
  advance();store.maintain()
  assert.equal(store.get(expired.id),null)
  assert.equal(store.get(pending.id).status,'pending')
  assert.equal(store.listActive().length,1)
})
