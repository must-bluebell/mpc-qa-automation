import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
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
  assert.equal(posts.filter(c=>c.body.thread_ts).length,8) // cases + diagnostics + AI + system health per run
  assert.equal(posts.filter(c=>c.body.text.includes('<@U123>')).length,1)
  assert.match(posts[0].body.text,/KST/)
  assert.match(posts[1].body.text,/Failed cases/)
  assert.match(posts[1].body.text,/❌ Cart assertion|❌ Check /)
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
  assert.equal(calls.filter(c=>c.body.thread_ts==='100.1').length,4)
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


test('workflow threads separate failures and passes, include validated detailed AI, and end in system health',async()=>{
  const {calls,options}=setup(),r=run('detailed')
  r.suite='nightly-regression';r.counts={passed:1,failed:1,skipped:0,blocked:0}
  r.tests.push({key:'A01',title:'A01 - Anonymous session reports no address',status:'passed',project:'api',annotations:[]})
  r.ai={status:'ok',model:'openai/gpt-test'}
  const dir=join(options.stateDir,r.runId);mkdirSync(dir)
  writeFileSync(join(dir,'ai-analysis.json'),JSON.stringify({status:'ok',modelOutputValidated:true,summary:'Observed latency regression.',
    findings:[{title:'Slow response',classification:'suspected',evidenceIds:['F1'],requirementIds:['PERF-01'],rationale:'Measured regression; cause unproven.'}],
    duplicateGroups:[{evidenceIds:['F1','F2'],rationale:'Potential shared contention.'}],
    scenarios:[{title:'Burst test',requirementIds:['PERF-01'],steps:['Send concurrent reads.','Measure p95.'],expectedResult:'Existing limits hold.',validationStatus:'proposed; not an acceptance check'}],
    privateField:'raw-secret-should-never-be-posted'}))
  await notifyBotRun(r,options)
  const posts=calls.filter(c=>c.method==='chat.postMessage')
  assert.match(posts[0].body.text,/Full API & UAT regression/)
  assert.match(posts[1].body.text,/Failed cases/)
  assert.match(posts[2].body.text,/Passed cases/)
  assert.match(posts.at(-1).body.text,/System health/)
  const ai=posts.find(p=>/AI analysis/.test(p.body.text)).body.text
  for(const value of ['Observed latency regression','Slow response','suspected','F1','PERF-01','Measured regression','Potential shared contention','Burst test','Send concurrent reads','Measure p95','Existing limits hold','not an acceptance check'])assert.ok(ai.includes(value),value)
  assert.doesNotMatch(JSON.stringify(posts),/raw-secret-should-never-be-posted/)
  assert.ok(posts.slice(1).every(p=>p.body.thread_ts===posts[1].body.thread_ts))
})
test('long AI reviews are split within Slack limits and escape mentions and credentials',async()=>{
  const {calls,options}=setup(),r=run('large-review');r.ai={status:'ok'}
  mkdirSync(join(options.stateDir,r.runId));writeFileSync(join(options.stateDir,r.runId,'ai-analysis.json'),JSON.stringify({status:'ok',modelOutputValidated:true,
    summary:'<@U999> xoxb-do-not-share',findings:[],duplicateGroups:[],scenarios:Array.from({length:25},(_,i)=>({title:'Scenario '+i,requirementIds:['AUTH-01'],steps:['a'.repeat(400)],expectedResult:'b'.repeat(200)}))}))
  await notifyBotRun(r,options)
  const posts=calls.filter(c=>c.method==='chat.postMessage')
  const ai=posts.filter(p=>p.body.text.startsWith('*AI analysis'))
  assert.ok(ai.length>1);assert.ok(posts.every(p=>p.body.text.length<=3500))
  const text=ai.map(p=>p.body.text).join('\n')
  assert.match(text,/Scenario 24/);assert.match(text,/&lt;@U999&gt;/);assert.doesNotMatch(text,/xoxb-do-not-share|<@U999>/)
})
test('missing validated AI artifact is labelled unavailable, never replaced with an invented review',async()=>{
  const {calls,options}=setup(),r=run('missing-review');r.ai={status:'ok',summary:'Do not promote this partial summary'}
  await notifyBotRun(r,options)
  const ai=calls.find(p=>/AI analysis/.test(p.body.text)).body.text
  assert.match(ai,/unavailable/i);assert.doesNotMatch(ai,/Do not promote/)
})

test('daily health has a concise parent and threaded history details, delivered once',async()=>{
 const {calls,options}=setup()
 const body=['MPC QA daily health — attention','24-hour window','47 actual runs','API: 235 passed','UAT: 42 failed','Execution/infrastructure failures: 22'].join('\n')
 await notifyHealthSummary('threaded-health',body,options);await notifyHealthSummary('threaded-health',body,options)
 const posts=calls.filter(c=>c.method==='chat.postMessage')
 assert.equal(posts.length,2);assert.equal(posts[0].body.thread_ts,undefined)
 assert.doesNotMatch(posts[0].body.text,/UAT: 42 failed/)
 assert.match(posts[1].body.text,/UAT: 42 failed/);assert.equal(posts[1].body.thread_ts,'1.000')
})
test('known application scenarios use readable allowlisted names without publishing unknown raw titles',async()=>{
 const {calls,options}=setup(),r=run('scenario-names','passed')
 r.tests=[{key:'membership',title:'features.spec.ts > new member completes SIWE, community, email and SBT issuance',status:'passed',annotations:[],adapter:'webmpc-scenarios'},
 {key:'unknown',title:'private unknown scenario text',status:'passed',annotations:[],adapter:'webmpc-scenarios'}]
 r.counts.passed=2;await notifyBotRun(r,options)
 const text=calls.map(c=>c.body.text).join('\n')
 assert.match(text,/New member completes SIWE, community, email and SBT issuance/)
 assert.doesNotMatch(text,/private unknown scenario text/)
})

test('scheduled critical smoke suppresses clean runs, groups repeats in the failure thread and alerts on recovery',async()=>{
 const {calls,options}=setup()
 const smoke=(id,status)=>({...run(id,status),suite:'critical-smoke',trigger:'scheduled',scheduleId:'critical-30m'})
 await notifyBotRun(smoke('clean','passed'),options)
 assert.equal(calls.length,0)
 await notifyBotRun(smoke('first','failed'),options)
 const parents=()=>calls.filter(c=>c.method==='chat.postMessage'&&!c.body.thread_ts)
 assert.equal(parents().length,1)
 const parentTs=JSON.parse(readFileSync(join(options.stateDir,'slack-bot-state.json'),'utf8')).messages.find(m=>m.runId==='first'&&m.kind==='summary').ts
 const before=calls.length
 await notifyBotRun(smoke('repeat','failed'),options)
 assert.equal(parents().length,1)
 assert.equal(calls.length,before+1)
 assert.equal(calls.at(-1).body.thread_ts,parentTs)
 assert.match(calls.at(-1).body.text,/Recurring failure group/)
 await notifyBotRun(smoke('recovered','passed'),options)
 assert.equal(parents().length,2)
 assert.match(parents().at(-1).body.text,/Recovered/)
 await notifyBotRun(smoke('healthy-again','passed'),options)
 assert.equal(parents().length,2)
})

test('smoke infrastructure recovery alerts and nightly clean runs always publish',async()=>{
 const {calls,options}=setup()
 const smoke=(id,status)=>({...run(id,status),tests:[],suite:'critical-smoke',trigger:'scheduled',scheduleId:'critical-30m'})
 await notifyBotRun(smoke('infra','infra-failed'),options)
 await notifyBotRun(smoke('infra-recovery','passed'),options)
 const parents=calls.filter(c=>!c.body.thread_ts)
 assert.equal(parents.length,2)
 assert.match(parents[1].body.text,/Recovered/)
 await notifyBotRun({...run('nightly-clean','passed'),suite:'nightly-regression',trigger:'scheduled',scheduleId:'nightly-api-uat'},options)
 assert.equal(calls.filter(c=>!c.body.thread_ts).length,3)
})

test('load report includes numerical comparison with the same workload baseline',async()=>{
 const {calls,options}=setup()
 const r={...run('baseline-comparison','passed'),suite:'load',load:{totalRequests:500,throughputRps:10,checkPassRate:1,baselineAction:'compared',baseline:{runId:'baseline-source',endpoints:{'GET /api/home':{p95Ms:100,errorRate:0}}},endpoints:{'GET /api/home':{p95Ms:120,errorRate:0.01}}}}
 await notifyBotRun(r,options)
 const text=calls.map(c=>c.body.text).join('\n')
 assert.match(text,/baseline-source/)
 assert.match(text,/100ms/)
 assert.match(text,/20(?:\.0)?%/)
})

test('infrastructure recovery is announced when execution resumes but a product assertion fails',async()=>{
 const {calls,options}=setup()
 await notifyBotRun({...run('down'),status:'infra-failed',tests:[]},options)
 await notifyBotRun({...run('product-fails'),steps:[],tests:[{...run('x').tests[0],classification:{kind:'product'}}]},options)
 const parents=calls.filter(c=>!c.body.thread_ts)
 assert.match(parents.at(-1).body.text,/Recovered.*Suite execution/)
})
