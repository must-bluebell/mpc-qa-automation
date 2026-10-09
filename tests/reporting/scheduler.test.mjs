import test from 'node:test'
import assert from 'node:assert/strict'
import { cronMatches, enqueueDue, nextSlots, completeJob } from '../../pipeline/scheduler.mjs'
import { classifyFailure } from '../../pipeline/lib/classify.mjs'
import { redactValue } from '../../pipeline/lib/safe-output.mjs'

const schedules = [{ id: 'web-30m', suite: 'regression', env: 'local-docker', cron: '*/30 * * * *', graceMinutes: 60, enabled: true }]
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
