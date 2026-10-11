import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { notifyBotRun, flushBotOutbox, notifyHealthSummary } from '../../pipeline/notify/slack-bot.mjs'

const run = (id, status = 'failed') => ({ runId:id, suite:'regression', env:'local-docker', status,
  finishedAt:'2026-10-09T00:00:00Z', versions:{app:{id:'abc123'}}, counts:{passed:status==='passed'?1:0,failed:status==='failed'?1:0,skipped:status==='skipped'?1:0,blocked:0},
  tests:[{key:'cart',title:'Cart assertion',status, fingerprint:'fp-1', requirementIds:['AUTH-01'],annotations:[]}], ai:{status:'not-requested'} })
function setup() {
  const calls=[]; let serial=0
  return { calls, options:{stateDir:mkdtempSync(join(tmpdir(),'qa-bot-')),token:'xoxb-test',channel:'C123',owner:'U123',wait:async()=>{},
    fetchImpl:async(url, o)=>{ const body=JSON.parse(o.body); calls.push({method:url.split('/').at(-1),body}); return {ok:true,status:200,json:async()=>({ok:true,ts:`${++serial}.000`}),headers:new Headers()} } } }
}
test('app tokens are rejected without sending; messages remain queued',async()=>{
  const {calls,options}=setup(); options.token='xapp-test'
  const result=await notifyBotRun(run('r1'),options)
  assert.equal(calls.length,0); assert.equal(result.results[0].code,'invalid_bot_token')
})
test('one summary per run, details threaded, owner only on new incidents',async()=>{
  const {calls,options}=setup()
  await notifyBotRun(run('r1'),options); await notifyBotRun(run('r1'),options)
  await notifyBotRun(run('r2'),options)
  const posts=calls.filter(c=>c.method==='chat.postMessage')
  assert.equal(posts.filter(c=>!c.body.thread_ts).length,2)
  assert.equal(posts.filter(c=>c.body.thread_ts).length,6) // pipeline stages + test cases + diagnostics per run
  assert.equal(posts.filter(c=>c.body.text.includes('<@U123>')).length,1)
  assert.match(posts[0].body.text,/KST/)
  assert.match(posts[1].body.text,/Pipeline stages/)
  assert.match(posts[2].body.text,/❌ Cart assertion|❌ Check /)
})
test('skipped runs do not close incidents; explicit pass publishes recovery',async()=>{
  const {calls,options}=setup()
  await notifyBotRun(run('r1'),options); await notifyBotRun(run('r2','skipped'),options)
  await notifyBotRun(run('r3'),options); await notifyBotRun(run('r4','passed'),options)
  assert.equal(calls.filter(c=>c.body.text?.includes('<@U123>')).length,1)
  assert.equal(calls.filter(c=>!c.body.thread_ts&&c.body.text?.includes('✅ *Recovered:* ')).length,1)
  assert.equal(calls.filter(c=>c.body.thread_ts&&c.body.text?.includes('; failing since r1.')).length,1)
})
test('429 retries on a later flush without duplicating the summary',async()=>{
  const {calls,options}=setup(); const good=options.fetchImpl; let first=true
  options.fetchImpl=async(...args)=>{if(first){first=false;return {ok:false,status:429,headers:new Headers({'retry-after':'1'})}} return good(...args)}
  await notifyBotRun(run('r1'),options)
  await flushBotOutbox({...options,now:Date.now()+2000})
  assert.equal(calls.filter(c=>c.method==='chat.postMessage'&&!c.body.thread_ts).length,1)
})
test('timeout after accepting a summary is reconciled before retry',async()=>{
  const {calls,options}=setup(); let accepted
  const good=options.fetchImpl
  options.fetchImpl=async(url,o)=>{
    if(url.endsWith('chat.postMessage')&&!JSON.parse(o.body).thread_ts&&!accepted){accepted=JSON.parse(o.body); throw new Error('socket lost')}
    if(url.endsWith('conversations.history')){calls.push({method:'conversations.history',body:{}});return {ok:true,status:200,json:async()=>({ok:true,messages:[{ts:'100.1',client_msg_id:accepted.client_msg_id}]}),headers:new Headers()}}
    return good(url,o)
  }
  await notifyBotRun(run('r1'),options)
  await flushBotOutbox({...options,now:Date.now()+60_000})
  assert.equal(calls.filter(c=>c.method==='chat.postMessage'&&!c.body.thread_ts).length,0)
  assert.equal(calls.filter(c=>c.body.thread_ts==='100.1').length,3)
})
test('published messages and durable outbox exclude secrets and raw test data',async()=>{
  const {calls,options}=setup(); const r=run('r1')
  r.tests[0].title='Authorization: Bearer sensitive'; r.tests[0].errors=['cookie: secret'];r.versions.app.id='xoxb-very-secret-token'
  await notifyBotRun(r,options)
  const text=JSON.stringify(calls)+readFileSync(join(options.stateDir,'slack-bot-state.json'),'utf8')
  assert.doesNotMatch(text,/sensitive|cookie: secret|xoxb-very-secret-token/)
})
test('repairing Slack permissions retries rejected summaries',async()=>{
  const {calls,options}=setup(),good=options.fetchImpl
  options.fetchImpl=async()=>({ok:true,status:200,json:async()=>({ok:false,error:'not_in_channel'}),headers:new Headers()})
  await notifyBotRun(run('r1'),options)
  options.fetchImpl=good
  await flushBotOutbox({...options,now:Date.now()+120_000})
  assert.equal(calls.filter(c=>c.method==='chat.postMessage'&&!c.body.thread_ts).length,1)
})
test('Allure link appears only when the run generated a report and the base URL is safe',async()=>{
  const {calls,options}=setup(); options.allureBase='https://reports.example/allure/'
  await notifyBotRun(run('r1'),options)
  await notifyBotRun({...run('r2'),allure:{generated:true}},options)
  await notifyBotRun({...run('r3'),allure:{generated:true}},{...options,allureBase:'http://reports.example/allure'})
  const parents=calls.filter(c=>c.method==='chat.postMessage'&&!c.body.thread_ts).map(c=>c.body.text)
  assert.doesNotMatch(parents[0],/Allure/)
  assert.match(parents[1],/Allure: <https:\/\/reports\.example\/allure\/r2\/index\.html\|Allure report>/)
  assert.match(parents[2],/Allure: retained locally \(invalid Allure base URL\)/)
})
test('GitHub CI summaries link to the run without exposing raw artifacts',async()=>{
  const {calls,options}=setup()
  options.runUrl='https://github.com/must-bluebell/mpc-qa-automation/actions/runs/123'
  options.reportBase=''
  await notifyBotRun(run('github-link'),options)
  assert.match(calls[0].body.text,/actions\/runs\/123\|GitHub run and sanitized report/)
  const bad=setup();bad.options.runUrl='https://github.com.attacker.invalid/secret';bad.options.reportBase=''
  await notifyBotRun(run('invalid-link'),bad.options)
  assert.doesNotMatch(bad.calls[0].body.text,/attacker/)
})

test('daily health queues durably once and retries without adding runs or incidents',async()=>{
  const {calls,options}=setup(),good=options.fetchImpl
  options.fetchImpl=async()=>({ok:false,status:429,headers:new Headers({'retry-after':'1'})})
  const result=await notifyHealthSummary('daily-health-1','MPC QA daily health — no-data',options)
  assert.equal(result.queued,true)
  let state=JSON.parse(readFileSync(join(options.stateDir,'slack-bot-state.json'),'utf8'))
  assert.equal(state.messages.length,1)
  assert.equal(state.messages[0].status,'pending')
  assert.deepEqual(state.runs,{})
  assert.deepEqual(state.incidents,{})
  await flushBotOutbox({...options,fetchImpl:good,now:options.now+2000})
  await notifyHealthSummary('daily-health-1','changed text',{...options,fetchImpl:good,now:options.now+3000})
  assert.equal(calls.filter(c=>c.method==='chat.postMessage').length,1)
  assert.match(calls[0].body.text,/no-data/)
})
