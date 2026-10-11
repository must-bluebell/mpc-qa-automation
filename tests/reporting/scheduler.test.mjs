import test from 'node:test'
import assert from 'node:assert/strict'
import { cronMatches, enqueueDue, nextSlots, completeJob, enqueueRotation, rotationSlot, reconcileSchedules, selectQueuedJob, completeSummaryJob } from '../../pipeline/scheduler.mjs'
import { classifyFailure } from '../../pipeline/lib/classify.mjs'
import { redactValue } from '../../pipeline/lib/safe-output.mjs'

const schedules = [{ id: 'web-30m', suite: 'regression', env: 'local-docker', cron: '*/30 * * * *', graceMinutes: 60, enabled: true }]
const rotation={id:'qa-rotation',suites:['regression','uat','api','load'],env:'local-docker',gapMinutes:30,enabled:true}
test('rotation starts with web, waits thirty minutes after completion and repeats in order',()=>{
  const state={jobs:[]},start=new Date('2026-10-10T05:00:00Z')
  enqueueRotation(state,rotation,start)
  assert.equal(state.jobs[0].suite,'regression')
  enqueueRotation(state,rotation,start)
  assert.equal(state.jobs.length,1)
  for(const suite of ['uat','api','load','regression']) {
    const last=state.jobs.at(-1)
    last.status='finished';last.finishedAt=new Date(Date.parse(last.at)+10*60_000).toISOString()
    const due=new Date(Date.parse(last.finishedAt)+30*60_000)
    assert.equal(rotationSlot(state,rotation,due).suite,suite)
    enqueueRotation(state,rotation,new Date(due.getTime()-1))
    assert.equal(state.jobs.at(-1),last)
    enqueueRotation(state,rotation,due)
    assert.equal(state.jobs.at(-1).suite,suite)
    assert.equal(state.jobs.at(-1).at,due.toISOString())
  }
})
test('rotation survives restart and never overlaps running or notifying work',()=>{
  const state={jobs:[]},now=new Date('2026-10-10T05:00:00Z')
  enqueueRotation(state,rotation,now)
  for(const status of ['queued','running','notifying']) {
    state.jobs[0].status=status
    const restarted=JSON.parse(JSON.stringify(state))
    enqueueRotation(restarted,rotation,new Date(now.getTime()+86400000))
    assert.equal(restarted.jobs.length,1)
    assert.equal(rotationSlot(restarted,rotation,now),null)
  }
  assert.equal(rotationSlot(state,{...rotation,enabled:false},now),null)
})
test('cron evaluates Korean midnight independent of machine timezone', () => {
  assert.equal(cronMatches('0 1 * * *', new Date('2026-10-09T16:00:00Z'), 'Asia/Seoul'), true)
  assert.equal(cronMatches('0 1 * * *', new Date('2026-10-09T01:00:00Z'), 'Asia/Seoul'), false)
  assert.throws(() => cronMatches('*/0 * * * *', new Date(), 'Asia/Seoul'), /cron/i)
})
test('slots are persisted once; catch-up queues missed slots without overlap', () => {
  const state = { cursor: '2026-10-09T00:00:00Z', jobs: [] }
  enqueueDue(state, schedules, new Date('2026-10-09T01:00:00Z'), 'Asia/Seoul')
  assert.equal(state.jobs.length, 2)
  assert.deepEqual(state.jobs.map(j => j.status), ['queued', 'queued'])
  const restarted = JSON.parse(JSON.stringify(state))
  enqueueDue(restarted, schedules, new Date('2026-10-09T01:00:00Z'), 'Asia/Seoul')
  assert.equal(restarted.jobs.length, 2)
})
test('first start only enqueues current slot and next times are KST', () => {
  const state = { jobs: [] }
  enqueueDue(state, schedules, new Date('2026-10-09T00:10:00Z'), 'Asia/Seoul')
  assert.equal(state.jobs.length, 0)
  const slots = nextSlots(schedules, new Date('2026-10-09T00:10:00Z'), 'Asia/Seoul')
  assert.equal(slots[0].at, '2026-10-09T00:30:00.000Z')
  assert.match(slots[0].local, /09:30/)
})
test('notification crash leaves a recoverable job; restart queues once before finishing',async()=>{
  const state={jobs:[]},job={runId:'r1',status:'running',suite:'regression',env:'local-docker',at:'2026-10-09T00:00:00Z'}
  let savedRun={runId:'r1',status:'passed'},notifications=0
  const options={readRunImpl:()=>savedRun,persistImpl:()=>{},saveRunImpl:r=>savedRun=r,createDirImpl:()=>{},publishImpl:()=>{},notify:async()=>{notifications++;throw new Error('simulated crash')}}
  await assert.rejects(completeJob(state,job,0,options),/simulated crash/)
  assert.equal(job.status,'notifying')
  options.notify=async()=>({queued:true})
  await completeJob(state,job,0,options)
  assert.equal(job.status,'finished');assert.equal(notifications,1)
})
test('dead child finalizes a running record and publishes infrastructure failure',async()=>{
  let saved={runId:'r1',status:'running',errors:[]},published
  const job={runId:'r1',status:'running',suite:'regression',env:'local-docker',at:'2026-10-09T00:00:00Z'}
  await completeJob({jobs:[job]},job,2,{readRunImpl:()=>saved,persistImpl:()=>{},saveRunImpl:r=>saved=r,createDirImpl:()=>{},publishImpl:()=>{},notify:async r=>{published=r;return {queued:true}}})
  assert.equal(saved.status,'crashed');assert.equal(published.status,'crashed');assert.equal(job.status,'finished')
})
test('crash recovery creates a sanitized report before enqueuing its link',async()=>{
  let published=false
  const job={runId:'r1',status:'running',suite:'regression',env:'local-docker',at:'2026-10-09T00:00:00Z'}
  await completeJob({jobs:[job]},job,2,{readRunImpl:()=>null,persistImpl:()=>{},saveRunImpl:()=>{},createDirImpl:()=>{},publishImpl:()=>{published=true},notify:async()=>{assert.equal(published,true);return {queued:true}}})
})
test('wallet setup errors are infrastructure failures, not product defects',()=>{
  const result=classifyFailure({status:'failed',errors:['Error: Wallet address index must be an integer between 0 and 2147483647.']})
  assert.equal(result.kind,'infrastructure')
})
test('nested redaction preserves JSON structure while removing credential values',()=>{
  const data=redactValue({errors:['Authorization: Bearer private'],nested:{value:'xoxb-secret-token'}})
  assert.deepEqual(data,{errors:['[REDACTED]'],nested:{value:'[REDACTED]'}})
})

test('schedule changes cancel obsolete queued jobs without interrupting active work',()=>{
  const state={jobs:[{scheduleId:'qa-rotation',status:'queued'}, {scheduleId:'qa-rotation',status:'running'}, {scheduleId:'qa-rotation',status:'notifying'}]}
  reconcileSchedules(state,{schedules,rotation:{enabled:false}})
  assert.deepEqual(state.jobs.map(j=>j.status),['cancelled','running','notifying'])
})
test('scheduled jobs preserve report kind and priority; stale jobs are missed before selecting work',()=>{
  const now=new Date('2026-10-12T00:00:00Z'),spec=[
    {id:'smoke',suite:'critical-smoke',cron:'*/30 * * * *',env:'local-docker',enabled:true,graceMinutes:10,priority:30},
    {id:'health',kind:'summary',suite:'daily-health',cron:'0 9 * * *',env:'local-docker',enabled:true,priority:0},
  ]
  const state={cursor:'2026-10-11T23:29:00Z',jobs:[]}
  enqueueDue(state,spec,now)
  const selected=selectQueuedJob(state,now)
  assert.equal(selected.kind,'summary')
  assert.equal(selected.scheduleId,'health')
  assert.equal(state.jobs.find(j=>j.scheduleId==='smoke'&&j.at==='2026-10-11T23:30:00.000Z').status,'missed')
})

test('a busy worker still allows summaries and records expired test jobs',()=>{
  const state={jobs:[
    {id:'active',status:'running',suite:'nightly-regression'},
    {id:'stale',status:'queued',at:'2026-10-11T22:00:00Z',graceMinutes:10},
    {id:'test',status:'queued',at:'2026-10-12T00:00:00Z',priority:10},
    {id:'report',kind:'summary',status:'queued',at:'2026-10-12T00:00:00Z',priority:0},
  ]}
  assert.equal(selectQueuedJob(state,new Date('2026-10-12T00:00:00Z'),{summaryOnly:true}).id,'report')
  assert.equal(state.jobs[1].status,'missed')
  assert.equal(state.jobs[0].status,'running')
})
test('configuration assigns API and UAT smoke, nightly without load, and one scheduling owner',async()=>{
  const {config}=await import('../../pipeline/lib/env.mjs')
  const {expandSuite}=await import('../../pipeline/orchestrator.mjs')
  const {readFileSync}=await import('node:fs')
  const spec=config.schedules(),suites=config.suites()
  assert.equal(spec.rotation.enabled,false)
  assert.equal(spec.schedules.length,4)
  const smoke=expandSuite('critical-smoke',suites)
  assert.deepEqual(smoke.map(s=>[s.project,s.grep]),[['api','@smoke'],['uat','@smoke']])
  const nightly=expandSuite('nightly-regression',suites)
  assert.ok(nightly.some(s=>s.project==='api'))
  assert.ok(nightly.some(s=>s.adapter==='webmpc-scenarios'))
  assert.equal(nightly.some(s=>s.adapter==='k6'),false)
  assert.doesNotMatch(readFileSync(new URL('../../.github/workflows/qa-runner.yml',import.meta.url),'utf8'),/^  schedule:/m)
})

test('summary generation retries after a temporary outbox failure without finishing or losing the job',async()=>{
  const job={id:'report',kind:'summary',status:'queued'},state={jobs:[job]}
  let attempts=0
  const options={persistImpl:()=>{},generate:async()=>{if(++attempts===1)throw new Error('outbox busy')}}
  await completeSummaryJob(state,job,{},options)
  assert.equal(job.status,'running')
  assert.equal(job.finishedAt,undefined)
  assert.equal(job.reportError,'Daily health generation or outbox delivery failed; retry pending.')
  await completeSummaryJob(state,job,{},options)
  assert.equal(job.status,'finished')
  assert.equal(job.reportError,undefined)
  assert.equal(attempts,2)
})
