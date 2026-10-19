import test from 'node:test'
import assert from 'node:assert/strict'
import { buildHealthSummary, renderHealthSummary } from '../../pipeline/health-summary.mjs'

const end='2026-10-12T00:00:00Z'
const schedules=[
  {id:'critical-30m',suite:'critical-smoke',cron:'*/30 * * * *',env:'local-docker',enabled:true},
  {id:'nightly-api-uat',suite:'nightly-regression',cron:'0 1 * * *',env:'local-docker',enabled:true},
  {id:'weekly-load',suite:'load',cron:'0 3 * * 0',env:'local-docker',enabled:true},
  {id:'daily-health',kind:'summary',cron:'0 9 * * *',env:'local-docker',enabled:true},
]
function run(overrides={}) {
  return {runId:'run-1',env:'local-docker',suite:'critical-smoke',status:'passed',finishedAt:'2026-10-11T23:35:00Z',
    steps:[{name:'api',fromSuite:'api-smoke',project:'api'},{name:'uat',fromSuite:'uat-smoke',project:'uat'}],
    tests:[{key:'a',step:'api',status:'passed'},{key:'u',step:'uat',status:'blocked'}],
    comparison:{newFailures:[],persisting:[],newVariants:[],recovered:[]},...overrides}
}
test('daily health combines API and UAT, excludes synthetic/seeded/other environments and uses a half-open window',()=>{
  const report=buildHealthSummary({end,env:'local-docker',schedules,runs:[run(),run({runId:'seed',seededDefect:'bad'}),run({runId:'preview',reportOnly:true}),run({runId:'other',env:'production'}),run({runId:'next',finishedAt:end})],jobs:[]})
  assert.equal(report.runs.total,1)
  assert.equal(report.categories.api.passed,1)
  assert.equal(report.categories.uat.blocked,1)
  assert.equal(report.passRate,1)
  assert.equal(report.executionRate,0.5)
  assert.equal(report.schedules.find(s=>s.id==='critical-30m').expected,48)
  assert.equal(report.schedules.find(s=>s.id==='nightly-api-uat').expected,1)
  assert.equal(report.schedules.some(s=>s.id==='daily-health'),false)
  assert.equal(report.health,'attention')
})
test('daily health distinguishes completed, missed, pending and absent scheduled executions',()=>{
  const jobs=[{scheduleId:'critical-30m',at:'2026-10-11T23:30:00Z',runId:'run-1',status:'finished'},
    {scheduleId:'critical-30m',at:'2026-10-11T23:00:00Z',status:'missed'},
    {scheduleId:'critical-30m',at:'2026-10-11T22:30:00Z',status:'running'}]
  const r=buildHealthSummary({end,env:'local-docker',schedules,runs:[run()],jobs})
  const smoke=r.schedules.find(s=>s.id==='critical-30m')
  assert.equal(smoke.completed,1)
  assert.equal(smoke.missed,1)
  assert.equal(smoke.pending,1)
  assert.equal(smoke.missing,45)
})
test('daily health reports no-data honestly and carries older weekly load with age and status',()=>{
  const r=buildHealthSummary({end,env:'local-docker',schedules,runs:[run({runId:'last-load',suite:'load',finishedAt:'2026-10-09T00:00:00Z',status:'failed',load:{throughputRps:3}})],jobs:[]})
  assert.equal(r.runs.total,0)
  assert.equal(r.passRate,null)
  assert.equal(r.latestLoad.runId,'last-load')
  assert.equal(r.latestLoad.ageHours,72)
  assert.equal(r.health,'no-data')
  const text=renderHealthSummary(r)
  assert.match(text,/API/)
  assert.match(text,/UAT/)
  assert.match(text,/72h/)
  assert.match(text,/failed/)
  assert.match(text,/n\/a/)
})
test('daily health counts comparison events and flags execution failures with zero assertions',()=>{
  const r=buildHealthSummary({end,env:'local-docker',schedules:[],jobs:[],runs:[run({status:'infra-failed',tests:[],comparison:{newFailures:[{}],persisting:[{}],newVariants:[{}],recovered:[{}]}})]})
  assert.equal(r.health,'attention')
  assert.deepEqual(r.failureEvents,{new:1,recurring:1,newVariants:1,recovered:1})
  assert.equal(r.passRate,null)
})

test('a delayed summary treats executions completed after its cutoff as pending',()=>{
  const future=run({finishedAt:'2026-10-12T00:05:00Z'})
  const r=buildHealthSummary({end,env:'local-docker',schedules,runs:[future],jobs:[
    {scheduleId:'critical-30m',env:'local-docker',at:'2026-10-11T23:30:00Z',status:'finished',finishedAt:future.finishedAt,runId:future.runId},
  ]})
  assert.equal(r.schedules[0].completed,0)
  assert.equal(r.schedules[0].pending,1)
})
test('daily health groups real adapter results without leaking raw diagnostics',()=>{
  const r=buildHealthSummary({end,env:'local-docker',schedules:[],jobs:[],runs:[run({
    steps:[{name:'scenario',fromSuite:'uat',adapter:'webmpc-scenarios'}],
    tests:[{step:'scenario',status:'failed',title:'private user data',errors:['secret']}],
  })]})
  assert.equal(r.categories.uat.failed,1)
  assert.doesNotMatch(JSON.stringify(r)+renderHealthSummary(r),/private user data|secret/)
})

test('execution completion uses the actual result timestamp rather than Slack finalization',()=>{
  for(const status of ['running','notifying','finished']) {
    const r=buildHealthSummary({end,env:'local-docker',schedules,runs:[run()],jobs:[
      {scheduleId:'critical-30m',at:'2026-10-11T23:30:00Z',runId:'run-1',status,finishedAt:'2026-10-12T00:01:00Z'},
    ]})
    assert.equal(r.schedules[0].completed,1,status)
    assert.equal(r.schedules[0].pending,0,status)
  }
})
test('non-minute cutoffs match actual scheduled minute slots within the half-open window',()=>{
  const r=buildHealthSummary({end:'2026-10-12T00:00:15Z',env:'local-docker',schedules,runs:[],jobs:[
    {scheduleId:'critical-30m',at:'2026-10-12T00:00:00Z',status:'running'},
  ]})
  assert.equal(r.schedules[0].expected,48)
  assert.equal(r.schedules[0].pending,1)
})

test('unresolved failures carry over the window, close only on a later explicit pass and expose no raw titles',()=>{
 const older=run({runId:'old-failure',finishedAt:'2026-10-09T00:00:00Z',status:'failed',tests:[{key:'a',title:'private unknown title',status:'failed'},{key:'b',status:'failed'}]})
 const skipped=run({runId:'skip',tests:[{key:'a',status:'skipped'}]})
 const fixed=run({runId:'fixed',finishedAt:'2026-10-11T23:40:00Z',tests:[{key:'b',status:'passed'}]})
 const r=buildHealthSummary({end,env:'local-docker',schedules:[],jobs:[],runs:[fixed,skipped,older]})
 assert.equal(r.unresolvedFailures.length,1)
 assert.equal(r.unresolvedFailures[0].sourceRunId,'old-failure')
 assert.equal(r.health,'attention')
 const text=renderHealthSummary(r,{reportBase:'https://reports.example/qa'})
 assert.match(text,/Unresolved failures: 1/)
 assert.match(text,/old-failure/)
 assert.doesNotMatch(JSON.stringify(r)+text,/private unknown title/)
})

test('daily report supplies working local dashboard links when shared hosting is unconfigured',()=>{
 const r=buildHealthSummary({end,env:'local-docker',schedules:[],jobs:[],runs:[run()]})
 assert.match(renderHealthSummary(r),/http:\/\/127\.0\.0\.1:4500\/#\/runs\/run-1/)
 assert.match(renderHealthSummary(r),/local scheduler host/)
})

test('a completed execution with product failures clears an older infrastructure outage',()=>{
 const step={name:'01-playwright-api',adapter:'playwright',project:'api',grep:null}
 const outage=run({runId:'outage',finishedAt:'2026-10-11T01:00:00Z',status:'infra-failed',steps:[{...step,errors:['runner unavailable']}],tests:[]})
 const product=run({runId:'product',status:'failed',steps:[{...step,exitCode:1,errors:[]}],tests:[{key:'p',step:step.name,status:'failed',classification:{kind:'product'}}]})
 const r=buildHealthSummary({end,env:'local-docker',schedules:[],jobs:[],runs:[outage,product]})
 assert.equal(r.unresolvedFailures.length,1)
 assert.equal(r.unresolvedFailures[0].sourceRunId,'product')
})

test('a recovered adapter resolves its old no-results failure without requiring a synthetic passing test',()=>{
 const step={name:'01-playwright-api',adapter:'playwright',project:'api',grep:null}
 const outage=run({runId:'adapter-outage',status:'infra-failed',finishedAt:'2026-10-11T01:00:00Z',steps:[{...step,exitCode:null,errors:['no results']}],tests:[{key:'playwright:api:step',adapter:'playwright',project:'api',step:step.name,tags:['@pipeline'],status:'failed'}]})
 const healthy=run({runId:'adapter-recovered',steps:[{...step,name:'03-playwright-api',exitCode:0,errors:[],timedOut:false}],tests:[{key:'real-api-test',step:'03-playwright-api',status:'passed'}]})
 const r=buildHealthSummary({end,env:'local-docker',schedules:[],jobs:[],runs:[outage,healthy]})
 assert.equal(r.unresolvedFailures.length,0)
 const partial={...healthy,steps:[{...healthy.steps[0],grep:'@smoke'}]}
 const p=buildHealthSummary({end,env:'local-docker',schedules:[],jobs:[],runs:[outage,partial]})
 assert.ok(p.unresolvedFailures.some(f=>f.sourceRunId==='adapter-outage'))
})

test('a later smoke outage cannot replace the identity of an unresolved full adapter outage',()=>{
 const outage=(id,at,grep)=>run({runId:id,finishedAt:at,status:'infra-failed',steps:[{name:'01-playwright-api',adapter:'playwright',project:'api',grep,errors:['no results']}],tests:[{key:'playwright:api:step',step:'01-playwright-api',tags:['@pipeline'],status:'failed'}]})
 const full=outage('full-outage','2026-10-11T01:00:00Z',null)
 const smoke=outage('smoke-outage','2026-10-11T02:00:00Z','@smoke')
 const recovery=run({runId:'smoke-recovered',steps:[{name:'01-playwright-api',adapter:'playwright',project:'api',grep:'@smoke',exitCode:0,errors:[]}],tests:[{key:'real-api-test',step:'01-playwright-api',status:'passed'}]})
 const r=buildHealthSummary({end,env:'local-docker',schedules:[],jobs:[],runs:[full,smoke,recovery]})
 assert.ok(r.unresolvedFailures.some(f=>f.sourceRunId==='full-outage'))
 assert.ok(!r.unresolvedFailures.some(f=>f.sourceRunId==='smoke-outage'))
})

test('explicit recovery of failed checks in a full suite clears the older child-suite infrastructure marker',()=>{
 const step={name:'02-webmpc-scenarios',adapter:'webmpc-scenarios',project:null,grep:null,fromSuite:'uat'}
 const outage=run({suite:'uat',runId:'child-outage',finishedAt:'2026-10-11T01:00:00Z',status:'infra-failed',steps:[{...step,exitCode:1,errors:[]}],tests:[{key:'scenario',step:step.name,status:'failed',classification:{kind:'infrastructure'}}]})
 const recovery=run({suite:'full',runId:'full-recovery',steps:[{...step,exitCode:0,errors:[]}],tests:[{key:'scenario',step:step.name,status:'passed'}]})
 const r=buildHealthSummary({end,env:'local-docker',schedules:[],jobs:[],runs:[outage,recovery]})
 assert.equal(r.unresolvedFailures.length,0)
 const skipped={...recovery,tests:[{key:'scenario',step:step.name,status:'skipped'}]}
 const s=buildHealthSummary({end,env:'local-docker',schedules:[],jobs:[],runs:[outage,skipped]})
 assert.equal(s.unresolvedFailures.length,2)
})

test('a filtered pass does not resolve a full-suite timeout after only some failures were recorded',()=>{
 const step={name:'01-playwright-uat',adapter:'playwright',project:'uat',grep:null}
 const outage=run({runId:'partial-timeout',suite:'uat',status:'timeout',finishedAt:'2026-10-11T01:00:00Z',steps:[{...step,timedOut:true}],tests:[{key:'A',step:step.name,status:'failed'}]})
 const partial=run({runId:'filtered-pass',suite:'uat',steps:[{...step,grep:'@smoke',exitCode:0,errors:[]}],tests:[{key:'A',step:step.name,status:'passed'}]})
 const r=buildHealthSummary({end,env:'local-docker',schedules:[],jobs:[],runs:[outage,partial]})
 assert.ok(r.unresolvedFailures.some(f=>f.sourceRunId==='partial-timeout'))
})
