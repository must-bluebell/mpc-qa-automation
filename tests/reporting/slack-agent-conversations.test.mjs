import test from 'node:test'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { agentSettings, authorize, validateSettings } from '../../pipeline/slack-agent/policy.mjs'
import { createAgent } from '../../pipeline/slack-agent/agent.mjs'
import { AgentStore, consumeRequests } from '../../pipeline/slack-agent/store.mjs'
import { completeJob } from '../../pipeline/scheduler.mjs'
import { answerQuestion } from '../../pipeline/slack-agent/answers.mjs'
const now=Date.parse('2026-10-23T08:00:00Z')
const env={QA_SLACK_AGENT_ENABLED:'1',QA_SLACK_TEAM_ID:'T123',SLACK_CHANNEL_ID:'C123',QA_SLACK_ALLOWED_USER_IDS:'U123',QA_SLACK_ALLOWED_CHANNEL_IDS:'*',QA_SLACK_ALLOW_DMS:'1'}
const identity=(channel='D123')=>({team:'T123',channel,user:'U123',thread:'123.456'})
function fixture(t,configuration=env) {
  const directory=mkdtempSync(join(tmpdir(),'qa-conversations-'));t.after(()=>rmSync(directory,{recursive:true,force:true}))
  const store=new AgentStore(directory),settings=agentSettings(configuration),posts=[]
  const agent=createAgent({store,settings:()=>settings,now:()=>now,post:async p=>{posts.push(p);return {ts:'123.999'}},
    answer:async()=> 'Source: example-run; 3 passed.',read:()=>null,jobs:()=>({jobs:[]})})
  return {store,settings,posts,agent}
}
function event(channel,type='message',id='EvDirect',extra={}) {return {team_id:'T123',event_id:id,event:{type,channel,channel_type:channel.startsWith('D')?'im':'channel',user:'U123',text:'help',ts:'123.456',...extra}}}

test('explicit channel lists, all invited channels and DMs keep workspace and rerun-user boundaries',()=>{
  const cfg=agentSettings(env)
  for(const channel of ['C123','C999','G123','D123'])assert.equal(authorize(identity(channel),cfg),true)
  assert.equal(authorize({...identity(),team:'T999'},cfg),false)
  assert.equal(authorize({...identity(),user:'U999'},cfg,true),false)
  assert.equal(authorize(identity('invalid'),cfg),false)
  const limited=agentSettings({...env,QA_SLACK_ALLOWED_CHANNEL_IDS:'C123,G123',QA_SLACK_ALLOW_DMS:'0'})
  assert.equal(authorize(identity('G123'),limited),true)
  assert.equal(authorize(identity('C999'),limited),false)
  assert.equal(authorize(identity(),limited),false)
  assert.throws(()=>validateSettings(agentSettings({...env,QA_SLACK_ALLOWED_CHANNEL_IDS:'*,C123'})),/channel/i)
})

test('DM-only configuration works without a reporting channel',()=>{
  const cfg=agentSettings({...env,SLACK_CHANNEL_ID:'',QA_SLACK_ALLOWED_CHANNEL_IDS:''})
  assert.doesNotThrow(()=>validateSettings(cfg))
  assert.equal(authorize(identity(),cfg),true)
  assert.equal(authorize(identity('C123'),cfg),false)
})

test('mentions in multiple channels and plain DMs reply only in their originating conversation',async t=>{
  const {agent,posts}=fixture(t)
  await agent.mention(event('C999','app_mention','EvChannel'))
  await agent.mention(event('G123','app_mention','EvPrivate'))
  await agent.mention(event('D123'))
  assert.deepEqual(posts.map(p=>p.channel),['C999','G123','D123'])
  assert.ok(posts.every(p=>p.thread_ts==='123.456'))
  await agent.mention(event('D123'))
  assert.equal(posts.length,3)
})

test('a claim left by a crash is answered on redelivery without waiting for stale expiry',async t=>{
  const {store,posts,agent}=fixture(t)
  const id=createHash('sha256').update('event:T123:EvFresh').digest('hex').slice(0,32)
  store.write({id,type:'event',status:'handling',at:new Date(now-60000).toISOString()})
  await agent.mention(event('D123','message','EvFresh'))
  assert.equal(posts.length,1)
  const staleId=createHash('sha256').update('event:T123:EvStale').digest('hex').slice(0,32)
  store.write({id:staleId,type:'event',status:'handling',at:new Date(now-11*60000).toISOString()})
  await agent.mention(event('D123','message','EvStale'))
  assert.equal(posts.length,2)
  await agent.mention(event('D123','message','EvStale'))
  assert.equal(posts.length,2)
})

test('the same capability question gives testing and repository scope in each allowed channel and DM',async t=>{
  const {store,settings}=fixture(t),posts=[]
  settings.ai=true
  const agent=createAgent({store,settings:()=>settings,now:()=>now,
    post:async payload=>{posts.push(payload);return {ts:'123.999'}},
    index:()=>{throw new Error('Capability question must bypass recorded runs')},
    answer:(question,options)=>answerQuestion(question,{...options,environment:{QA_SLACK_PR_REPOSITORY:'globalmpc/mpc-automation'},
      explain:()=>{throw new Error('Capability question must bypass AI')}})})
  for(const channel of ['C123','C999','G123','D123'])
    await agent.mention(event(channel,channel.startsWith('D')?'message':'app_mention',`Ev${channel}`,{
      text:'Hello <@U0C8B0PU4FQ> can you tell me what you are capable of and which repos you have access to?'}))
  assert.deepEqual(posts.map(p=>p.channel),['C123','C999','G123','D123'])
  for(const post of posts){
    assert.match(post.text,/My role is testing/)
    assert.match(post.text,/globalmpc\/mpc-automation/)
    assert.doesNotMatch(post.text,/Advisory|Source:|could not be processed/)
    assert.equal(post.thread_ts,'123.456')
  }
})

test('ordinary channel messages, bot echoes, edited messages and group DMs do not trigger replies',async t=>{
  const {agent,posts}=fixture(t)
  for(const body of [event('C999'),event('G123','message','EvGroup',{channel_type:'mpim'}),
    event('D123','message','EvBot',{bot_id:'B123'}),event('D123','message','EvEdit',{subtype:'message_changed'}),
    {...event('D123','message','EvOtherTeam'),team_id:'T999'}])await agent.mention(body)
  assert.equal(posts.length,0)
})

test('DM rerun confirmation cannot be moved to a channel; scheduler marks its result private',async t=>{
  const {agent,store,settings,posts}=fixture(t)
  await agent.mention(event('D123','message','EvRerun',{text:'rerun api'}))
  const r=store.list().find(r=>r.type==='rerun')
  assert.ok(r)
  const action=channel=>({team:{id:'T123'},user:{id:'U123'},channel:{id:channel},message:{ts:'123.999',thread_ts:'123.456'},actions:[{action_id:'qa_rerun_confirm',value:r.id}]})
  await agent.action(action('C999'));assert.equal(store.get(r.id).status,'pending')
  await agent.action(action('D123'));assert.equal(store.get(r.id).status,'queued')
  const state={jobs:[]};consumeRequests(state,{store,settings,now,persist:()=>{}})
  assert.equal(state.jobs[0].slackPrivate,true)
  let broadcasts=0
  await completeJob(state,state.jobs[0],0,{readRunImpl:()=>({runId:state.jobs[0].runId,status:'passed'}),persistImpl:()=>{},publishImpl:()=>{},notify:async()=>{broadcasts++;return {queued:true}}})
  assert.equal(broadcasts,0)
  assert.equal(state.jobs[0].status,'finished')
  const completed=createAgent({store,settings:()=>settings,now:()=>now,post:async p=>{posts.push(p);return {ts:'124.0'}},jobs:()=>state,
    read:id=>({runId:id,status:'passed',finishedAt:new Date(now).toISOString(),counts:{passed:3}})})
  await completed.poll()
  assert.equal(posts.at(-1).channel,'D123');assert.match(posts.at(-1).text,/3 passed/)
})

test('rate-limited replies retry in their original allowed channel or DM, never the reporting channel',async t=>{
  const {agent,store,posts}=fixture(t)
  for(const channel of ['C999','D123'])await store.deliver(`retry-${channel}`,{channel,thread_ts:'123.456',text:'Recorded result.'},async()=>{throw {code:'slack_webapi_rate_limited_error',retryAfter:1}},now-2000,identity(channel))
  await agent.poll()
  assert.deepEqual(posts.map(p=>p.channel).sort(),['C999','D123'])
})

test('legacy pending replies cannot bypass removal of the reporting channel from conversational access',async t=>{
  const {agent,store,posts}=fixture(t,{...env,QA_SLACK_ALLOWED_CHANNEL_IDS:'C999'})
  await store.deliver('legacy-reporting-reply',{channel:'C123',thread_ts:'123.456',text:'Old recorded result.'},async()=>{throw {code:'slack_webapi_rate_limited_error',retryAfter:1}},now-2000)
  await agent.poll()
  assert.equal(posts.length,0)
})
