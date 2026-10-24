import test from 'node:test'
import assert from 'node:assert/strict'
import { combineReport } from '../../scripts/share-combined-report.mjs'
import { publicSummary } from '../../pipeline/lib/safe-output.mjs'
import { notifyBotRun } from '../../pipeline/notify/slack-bot.mjs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const source={runId:'source-full',env:'local-docker',finishedAt:'2026-10-09T07:39:00Z',versions:{app:{id:'abc123'}},
  steps:[{name:'web',fromSuite:'regression'},{name:'api',fromSuite:'api'},{name:'load',fromSuite:'load'},{name:'uat',fromSuite:'uat'}],
  tests:[{key:'web1',step:'web',status:'failed'},{key:'api1',step:'api',status:'passed'},{key:'k6:baseline:GET /api/home',adapter:'k6',step:'load',status:'failed'},{key:'uat1',step:'uat',status:'passed'}],
  load:{totalRequests:492,throughputRps:7.86,checkPassRate:1,endpoints:{'GET /api/home':{p95Ms:3659,errorRate:0}}}}

test('combined preview includes three recorded categories and excludes UAT from totals',()=>{
  const report=combineReport(source),safe=publicSummary(report)
  assert.equal(report.reportOnly,true)
  assert.equal(report.tests.length,3)
  assert.deepEqual(safe.counts,{passed:1,failed:2,skipped:0,blocked:0})
  assert.deepEqual(safe.sections.map(s=>s.label),['Web automation regression testing','API testing','Load testing'])
  assert.equal(safe.sections[0].sourceRunId,'source-full')
  assert.match(safe.sections[0].finishedAt,/16:39:00 KST/)
  assert.equal(safe.loadMetrics.totalRequests,492)
})
test('missing categories fail rather than inventing a load result',()=>{
  assert.throws(()=>combineReport({...source,steps:source.steps.filter(s=>s.fromSuite!=='load')}),/load/i)
})
test('Slack preview shows all three results in one summary and load metrics in its thread',async()=>{
  const messages=[]
  await notifyBotRun(combineReport(source),{token:'xoxb-test',channel:'C123',owner:'',stateDir:mkdtempSync(join(tmpdir(),'qa-combined-')),
    fetchImpl:async(url,o)=>{messages.push(JSON.parse(o.body));return {ok:true,status:200,json:async()=>({ok:true,ts:`${messages.length}.1`})}}})
  assert.equal(messages.length,7)
  for(const label of ['Web automation regression testing','API testing','Load testing'])assert.ok(messages[0].text.includes(label))
  assert.match(messages[0].text,/Recorded results preview/)
  assert.match(messages.at(-1).text,/System health/)
  assert.match(messages[1].text,/Failed cases/)
  assert.match(messages[1].text,/Web automation regression testing/)
  assert.match(messages[2].text,/API testing/)
  assert.match(messages[3].text,/❌ GET \/api\/home — p95 & error-rate SLO\n.*p95 3659 ms \(limit 1500 ms\)/)
  assert.doesNotMatch(messages[3].text.split("*Load testing*")[1],/Check [0-9a-f]{16}/)
  assert.match(messages[4].text,/492 requests/)
})
test('all regression outcomes precede API and load cases in a mixed-result thread',async()=>{
  const messages=[]
  const report=combineReport({...source,tests:[...source.tests,{key:'web2',step:'web',status:'passed'},{key:'api2',step:'api',status:'failed'}]})
  await notifyBotRun(report,{token:'xoxb-test',channel:'C123',owner:'',stateDir:mkdtempSync(join(tmpdir(),'qa-ordered-')),
    fetchImpl:async(url,o)=>{messages.push(JSON.parse(o.body));return {ok:true,status:200,json:async()=>({ok:true,ts:`${messages.length}.1`})}}})
  const cases=messages.filter(m=>/\*(Failed|Passed|Blocked|Skipped) cases\*/.test(m.text))
  assert.deepEqual(cases.map(m=>m.text.match(/\*(Web automation regression testing|API testing|Load testing)\*/)?.[1]),
    ['Web automation regression testing','Web automation regression testing','API testing','API testing','Load testing'])
  assert.ok(cases.every(m=>m.thread_ts==='1.1'))
  assert.match(messages.at(-1).text,/System health/)
})
test('load failures name the breached rule, including baseline regressions under the absolute limit',()=>{
  const run={...source,steps:[{name:'load',fromSuite:'load'}],tests:[{key:'k6:baseline:GET /api/home',adapter:'k6',step:'load',status:'failed'}],
    load:{endpoints:{'GET /api/home':{p95Ms:778,errorRate:0,breaches:['p95 regressed 30% vs baseline 597ms','<script>leak']}}}}
  const reason=publicSummary(run).checks[0].reason
  assert.equal(reason,'Breached: p95 regressed 30% vs baseline 597ms. Measured: p95 778 ms (limit 1500 ms) · errors 0.00% (limit 1.00%)')
})
