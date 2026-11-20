import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentSettings, authorize, validateTarget } from '../../pipeline/slack-agent/policy.mjs'
import { AgentStore, consumeRequests } from '../../pipeline/slack-agent/store.mjs'

export const settings = () => agentSettings({ QA_SLACK_TEAM_ID:'T123', SLACK_CHANNEL_ID:'C123', QA_SLACK_ALLOWED_USER_IDS:'U123', QA_SLACK_AGENT_ENABLED:'1' })
const identity = {team:'T123',channel:'C123',user:'U123',thread:'123.456'}
const now = Date.parse('2026-10-23T05:00:00Z')
function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'qa-agent-'))
  t.after(()=>rmSync(dir,{recursive:true,force:true}))
  return new AgentStore(dir)
}

test('policy denies missing workspace, other channels, bots and unauthorized reruns',()=>{
  assert.equal(authorize(identity,settings()),true)
  assert.equal(authorize({...identity,user:'U999'},settings()),true)
  assert.equal(authorize({...identity,user:'U999'},settings(),true),false)
  for(const change of [{team:'T999'},{channel:'C999'},{user:''},{bot:true}]) assert.equal(authorize({...identity,...change},settings()),false)
  assert.equal(authorize(identity,agentSettings({SLACK_CHANNEL_ID:'C123'})),false)
  assert.throws(()=>validateTarget('load','production',settings()),/isolated|allowed/i)
  assert.throws(()=>validateTarget('api; touch x','local-docker',settings()),/allowed/i)
  assert.throws(()=>validateTarget('api','http://evil.example',settings()),/allowed/i)
})

test('confirmation is bound to requester, channel, workspace and thread and expires at five minutes',t=>{
  const store=fixture(t), request=store.propose('event-one',identity,'api','local-docker',settings(),now)
  assert.equal(request.status,'pending')
  assert.equal(store.propose('event-one',identity,'api','local-docker',settings(),now).id,request.id)
  for(const change of [{user:'U999'},{team:'T999'},{channel:'C999'},{thread:'999.000'}])
    assert.throws(()=>store.decide(request.id,{...identity,...change},'confirm',settings(),now),/authorized|match/i)
  assert.equal(store.get(request.id).status,'pending')
  assert.throws(()=>store.decide(request.id,identity,'confirm',settings(),now+300000),/expired/i)
  assert.equal(store.get(request.id).status,'expired')
})

test('durable confirmations and duplicate clicks yield one queue entry; cancel cannot run',t=>{
  const store=fixture(t), request=store.propose('event-two',identity,'uat','local-docker',settings(),now)
  assert.equal(store.decide(request.id,identity,'confirm',settings(),now).status,'queued')
  assert.equal(new AgentStore(store.directory).decide(request.id,identity,'confirm',settings(),now).status,'queued')
  assert.throws(()=>store.decide(request.id,identity,'cancel',settings(),now),/already/i)
  const cancelled=store.propose('event-three',identity,'api','local-docker',settings(),now)
  store.decide(cancelled.id,identity,'cancel',settings(),now)
  assert.throws(()=>store.decide(cancelled.id,identity,'confirm',settings(),now),/cancelled/i)
  assert.equal(store.list().filter(r=>r.status==='queued').length,1)
})

test('scheduler persists the job before acknowledgment and recovers a crash without duplicating it',t=>{
  const store=fixture(t),r=store.propose('event-four',identity,'api','local-docker',settings(),now)
  store.decide(r.id,identity,'confirm',settings(),now)
  const state={jobs:[]}
  assert.throws(()=>consumeRequests(state,{store,settings:settings(),now,persist:()=>{throw new Error('disk failure')}}),/disk failure/)
  assert.equal(store.get(r.id).status,'queued')
  let durable
  consumeRequests(state,{store,settings:settings(),now,persist:s=>{durable=structuredClone(s)}})
  assert.equal(durable.jobs.length,1)
  assert.equal(durable.jobs[0].scheduleId,'slack-agent')
  assert.equal(durable.jobs[0].ai,true)
  consumeRequests(state,{store,settings:settings(),now,persist:()=>{}})
  assert.equal(state.jobs.length,1)
  assert.equal(store.get(r.id).runId,state.jobs[0].runId)
  assert.equal(store.get(r.id).status,'scheduled')
  assert.match(readFileSync(join(store.directory,`${r.id}.json`),'utf8'),/confirmedAt/)
})

test('scheduler rechecks revoked authorization and expires old queued requests',t=>{
  const store=fixture(t), r=store.propose('event-five',identity,'api','local-docker',settings(),now)
  store.decide(r.id,identity,'confirm',settings(),now)
  const state={jobs:[]}, revoked={...settings(),allowedUsers:[]}
  consumeRequests(state,{store,settings:revoked,now,persist:()=>{}})
  assert.equal(state.jobs.length,0)
  assert.equal(store.get(r.id).status,'rejected')
  const old=store.propose('event-six',identity,'api','local-docker',settings(),now)
  store.decide(old.id,identity,'confirm',settings(),now)
  consumeRequests(state,{store,settings:settings(),now:now+3600000,persist:()=>{}})
  assert.equal(store.get(old.id).status,'expired')
})

test('Slack jobs survive schedule reconciliation and retain the original reply destination',async t=>{
  const { reconcileSchedules, consumeSlackRequests }=await import('../../pipeline/scheduler.mjs')
  assert.equal(typeof consumeSlackRequests,'function')
  const store=fixture(t),r=store.propose('event-scheduler',identity,'load','local-docker',settings(),now)
  store.decide(r.id,identity,'confirm',settings(),now)
  const state={jobs:[]}
  consumeSlackRequests(state,{store,settings:settings(),now,persist:()=>{}})
  reconcileSchedules(state,{schedules:[],rotation:{enabled:false}})
  assert.equal(state.jobs[0].status,'queued')
  assert.equal(state.jobs[0].slackRequestId,r.id)
  assert.equal(store.get(r.id).thread,'123.456')
})

test('abandoned expired confirmations cannot permanently exhaust the requester limit',t=>{
  const store=fixture(t)
  for(const event of ['abandon-a','abandon-b','abandon-c'])store.propose(event,identity,'api','local-docker',settings(),now)
  const fresh=store.propose('after-expiry',identity,'api','local-docker',settings(),now+300000)
  assert.equal(fresh.status,'pending')
  assert.equal(store.list().filter(r=>r.type==='rerun'&&r.status==='expired').length,3)
})

test('revocation after inbox consumption cancels a queued Slack job before execution',t=>{
  const store=fixture(t),r=store.propose('revoke-after-consume',identity,'api','local-docker',settings(),now)
  store.decide(r.id,identity,'confirm',settings(),now)
  const state={jobs:[]}
  consumeRequests(state,{store,settings:settings(),now,persist:()=>{}})
  consumeRequests(state,{store,settings:{...settings(),allowedUsers:[]},now:now+1000,persist:()=>{}})
  assert.equal(state.jobs[0].status,'cancelled')
})


test('valid JSON with damaged identity or timestamps fails closed rather than accepting stale confirmation',t=>{
  const store=fixture(t),r=store.propose('corrupt-request',identity,'api','local-docker',settings(),now)
  const file=join(store.directory,`${r.id}.json`)
  for(const mutate of [value=>{delete value.expiresAt},value=>{value.id='0'.repeat(32)},value=>{value.status='invented'},value=>{value.audit=null}]) {
    const damaged=structuredClone(r);mutate(damaged)
    writeFileSync(file,JSON.stringify(damaged))
    assert.throws(()=>store.decide(r.id,identity,'confirm',settings(),now+86400000),/unreadable|invalid|corrupt/i)
    writeFileSync(file,JSON.stringify(r))
  }
})

test('unreadable agent state cannot dispatch queued Slack work while ordinary schedules still run',async()=>{
  const {selectQueuedJob}=await import('../../pipeline/scheduler.mjs')
  const state={jobs:[{id:'slack',scheduleId:'slack-agent',status:'queued',at:new Date(now).toISOString(),priority:25,graceMinutes:60},
    {id:'ordinary',scheduleId:'critical',status:'queued',at:new Date(now).toISOString(),priority:30,graceMinutes:60}]}
  assert.equal(selectQueuedJob(state,new Date(now),{excludeSlack:true}).id,'ordinary')
})
