import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgent } from '../../pipeline/slack-agent/agent.mjs'
import { AgentStore, consumeRequests } from '../../pipeline/slack-agent/store.mjs'
import { agentSettings } from '../../pipeline/slack-agent/policy.mjs'
const now=Date.parse('2026-10-23T05:00:00Z')
function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'qa-conversation-'));t.after(()=>rmSync(dir,{recursive:true,force:true}))
  const store=new AgentStore(dir),posts=[]
  const settings=agentSettings({QA_SLACK_AGENT_ENABLED:'1',QA_SLACK_TEAM_ID:'T123',SLACK_CHANNEL_ID:'C123',QA_SLACK_ALLOWED_USER_IDS:'U123'})
  const agent=createAgent({store,settings:()=>settings,now:()=>now,post:async p=>{posts.push(p);return {ts:'123.999'}},answer:async()=> 'Source: test-run; 3 passed.',read:()=>null,index:()=>[]})
  return {agent,store,posts,settings}
}
function mention(text,event_id='Ev1',user='U123') {return {team_id:'T123',event_id,event:{type:'app_mention',user,channel:'C123',text,ts:'123.456'}}}
function action(id,user='U123',action_id='qa_rerun_confirm') {return {team:{id:'T123'},user:{id:user},channel:{id:'C123'},message:{ts:'123.999',thread_ts:'123.456'},actions:[{action_id,value:id}]}}

test('read-only questions reply in the originating thread once across duplicate events',async t=>{
  const {agent,posts}=fixture(t)
  await agent.mention(mention('what failed?'));await agent.mention(mention('what failed?'))
  assert.equal(posts.length,1);assert.equal(posts[0].thread_ts,'123.456');assert.match(posts[0].text,/Source: test-run/)
})

test('untrusted workspace/channel and bot events are ignored; unauthorized users cannot propose runs',async t=>{
  const {agent,posts,store}=fixture(t)
  for(const body of [{...mention('rerun api'),team_id:'T999'},{...mention('hi'),event:{...mention('hi').event,bot_id:'B123'}},
    {...mention('hi'),event:{...mention('hi').event,channel:'C999'}}]) await agent.mention(body)
  assert.equal(posts.length,0)
  await agent.mention(mention('rerun api','Ev2','U999'))
  assert.match(posts[0].text,/not authorized/i)
  assert.equal(store.list().filter(r=>r.type==='rerun').length,0)
})

test('rerun requires an explicit matching confirmation and cancellation never queues work',async t=>{
  const {agent,posts,store,settings}=fixture(t)
  await agent.mention(mention('rerun api'))
  const request=store.list().find(r=>r.type==='rerun')
  assert.equal(request.status,'pending');assert.equal(posts[0].blocks.at(-1).elements.length,2)
  await agent.action(action(request.id,'U999'))
  assert.equal(store.get(request.id).status,'pending')
  await agent.action(action(request.id));await agent.action(action(request.id))
  assert.equal(store.get(request.id).status,'queued')
  const state={jobs:[]};consumeRequests(state,{store,settings,now,persist:()=>{}})
  assert.equal(state.jobs.length,1)
  await agent.mention(mention('rerun uat','Ev3'))
  const cancel=store.list().find(r=>r.type==='rerun'&&r.suite==='uat')
  await agent.action(action(cancel.id,'U123','qa_rerun_cancel'))
  assert.equal(store.get(cancel.id).status,'cancelled')
})

test('timeout after sending a reply never causes a blind duplicate on retry',async t=>{
  const {store}=fixture(t);let calls=0
  const post=async()=>{calls++;throw new Error('network timeout after acceptance')}
  await store.deliver('uncertain',{channel:'C123',text:'safe'},post,now)
  await store.deliver('uncertain',{channel:'C123',text:'safe'},post,now+5000)
  assert.equal(calls,1)
  assert.equal(store.list().find(r=>r.type==='reply').status,'uncertain')
})

test('explicit Slack rate-limit rejection is retried only after its retry window',async t=>{
  const {store}=fixture(t);let calls=0
  const post=async()=>{calls++;if(calls===1)throw {code:'slack_webapi_rate_limited_error',retryAfter:10};return {ts:'1.1'}}
  await store.deliver('rate',{text:'safe'},post,now)
  await store.deliver('rate',{text:'safe'},post,now+9000)
  assert.equal(calls,1)
  await store.deliver('rate',{text:'safe'},post,now+10000)
  assert.equal(calls,2)
})

test('completion polling links the original run and never reposts a recorded completion',async t=>{
  const {store,settings,posts}=fixture(t)
  const identity={team:'T123',channel:'C123',user:'U123',thread:'123.456'}
  const request=store.propose('finish',identity,'api','local-docker',settings,now)
  store.decide(request.id,identity,'confirm',settings,now)
  consumeRequests({jobs:[]},{store,settings,now,persist:()=>{}})
  const runId=store.get(request.id).runId
  const agent=createAgent({store,settings:()=>settings,now:()=>now,post:async p=>{posts.push(p);return {ts:'2.2'}},
    read:id=>({runId:id,suite:'api',status:'infra-failed',finishedAt:'2026-10-23T05:01:00Z',counts:{passed:0,failed:0,blocked:0,skipped:0}}),index:()=>[]})
  await agent.poll();await agent.poll()
  assert.equal(posts.length,1);assert.equal(posts[0].thread_ts,'123.456')
  assert.match(posts[0].text,new RegExp(runId));assert.match(posts[0].text,/infra-failed/)
  assert.equal(store.get(request.id).status,'completed')
})

test('only one advisory model explanation runs at a time while status questions remain available',async t=>{
  const {store,settings,posts}=fixture(t);settings.ai=true
  let release,calls=0
  const pending=new Promise(resolve=>{release=resolve})
  const agent=createAgent({store,settings:()=>settings,now:()=>now,post:async p=>{posts.push(p);return {ts:'2.2'}},
    answer:async(question)=>{calls++;if(question==='explain this pattern')await pending;return 'Recorded evidence.'}})
  const first=agent.mention(mention('explain this pattern','EvModel1'))
  await agent.mention(mention('explain another pattern','EvModel2'))
  assert.equal(calls,1)
  await agent.mention(mention('is the scheduler running?','EvStatus'))
  assert.equal(calls,2)
  release();await first
  assert.ok(posts.some(p=>/already.*progress/i.test(p.text)))
})
