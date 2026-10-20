#!/usr/bin/env node
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { readIndex, readRun, createRunDir, writeJsonAtomic } from '../pipeline/lib/run-store.mjs'
import { publishSummary, REPORT_CATEGORIES } from '../pipeline/lib/safe-output.mjs'
import { notifyBotRun } from '../pipeline/notify/slack-bot.mjs'

export function combineReport(source) {
  if(!source||!source.finishedAt||['running','crashed'].includes(source.status))throw new Error('A completed source run is required.')
  const sections=REPORT_CATEGORIES.map(({suite,label})=>{
    const steps=(source.steps??[]).filter(s=>s.fromSuite===suite)
    if(!steps.length)throw new Error(`Source run has no ${suite} result.`)
    const names=new Set(steps.map(s=>s.name)),tests=source.tests.filter(t=>names.has(t.step))
    if(!tests.length)throw new Error(`Source run has no recorded ${suite} checks.`)
    const counts={passed:0,failed:0,skipped:0,blocked:0}
    for(const t of tests)if(t.status in counts)counts[t.status]++
    const status=counts.failed?'failed':counts.blocked&&!counts.passed?'blocked':counts.passed?'passed':'skipped'
    return {suite,label,status,counts,sourceRunId:source.runId,finishedAt:source.finishedAt,tests}
  })
  const tests=sections.flatMap(s=>s.tests),counts={passed:0,failed:0,skipped:0,blocked:0,total:tests.length}
  for(const t of tests)if(t.status in counts)counts[t.status]++
  return {...source,runId:`combined-${source.runId}`,suite:'combined-report',trigger:'report-preview',reportOnly:true,
    sourceRunId:source.runId,status:counts.failed?'failed':counts.blocked?'blocked':'passed',counts,tests,
    steps:source.steps.filter(s=>REPORT_CATEGORIES.some(c=>c.suite===s.fromSuite)),
    reportSections:sections.map(({tests,...section})=>section)}
}

async function main() {
  const {values}=parseArgs({options:{source:{type:'string'},'no-send':{type:'boolean'}}})
  let source=values.source&&readRun(values.source)
  if(!values.source) {
    const candidates=readIndex().filter(r=>r.status!=='running'&&!r.seededDefect).reverse()
    for(const row of candidates) {
      const run=readRun(row.runId)
      try {combineReport(run);source=run;break}catch{/* Find the newest run with all three categories. */}
    }
  }
  const report=combineReport(source),dir=createRunDir(report.runId)
  writeJsonAtomic(join(dir,'run.json'),report) // Snapshot only; never add a synthetic test execution to the run index.
  const path=publishSummary(report)
  console.log(`Recorded results preview: ${report.runId}\nSource: ${source.runId}\nReport: ${path}`)
  for(const s of report.reportSections)console.log(`${s.label}: ${s.status}; ${s.counts.passed} passed, ${s.counts.failed} failed, ${s.counts.skipped} skipped, ${s.counts.blocked} blocked`)
  if(!values['no-send']) {
    // A historical layout preview must not create new owner alerts for old failures.
    const delivery=await notifyBotRun(report,{owner:''})
    console.log(JSON.stringify({slack:delivery.results},null,2))
    if(!delivery.queued||delivery.results.some(r=>!r.ok))process.exitCode=1
  }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e.message);process.exitCode=1})
