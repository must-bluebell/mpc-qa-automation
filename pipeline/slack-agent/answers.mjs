import { readIndex, readRun } from '../lib/run-store.mjs'
import { readLock } from '../lib/lock.mjs'
import { config } from '../lib/env.mjs'
import { publicSummary, safeText, dashboardRunUrl } from '../lib/safe-output.mjs'
import { explainEvidence } from './explain.mjs'

export const plain = value => safeText(value).replace(/[<>&`]/g,'').slice(0,2800)
const help = 'Ask about the latest API/UAT/load run, failures, last pass, evidence, or testing schedule. To request a rerun: “rerun api” (also smoke, regression, uat, load, full). A rerun requires authorization and confirmation.'
export function parseRequest(value) {
  const text=String(value||'').replace(/^\s*<@[A-Z0-9]+>\s*/, '').trim().slice(0,1200)
  const command=text.match(/^(?:please )?rerun (smoke|api|regression|uat|load|full)(?: (?:on|in) ([\w-]+))?[.!?]?$/i)
  if(command) return {kind:'rerun',suite:command[1].toLowerCase(),env:command[2]?.toLowerCase()||'local-docker'}
  if(/\b(?:rerun|execute|run again)\b/i.test(text)) return {kind:'invalid-rerun'}
  const suite=/\bapi\b/i.test(text)?'api':/\buat\b/i.test(text)?'uat':/\bload\b/i.test(text)?'load':/\b(?:web|browser|regression)\b/i.test(text)?'regression':/\bnightly\b/i.test(text)?'nightly-regression':null
  const match=text.match(/\b(?:report|run|evidence)(?: for)? ([A-Za-z0-9][\w-]{0,99})[?.!]?$/i)
  const runId=match&&!['latest','last','api','uat','load','full','regression','smoke','nightly'].includes(match[1].toLowerCase())?match[1]:null
  const kind=/\bscheduler\b/i.test(text)?'scheduler':/\bschedul(?:e|es|ed|ing)\b/i.test(text)?'schedule'
    :/\bpass(?:ed)?\b/i.test(text)&&/\b(?:when|last|latest)\b/i.test(text)?'last-pass'
    :/\b(?:fail(?:ed|ures?)?|broken)\b/i.test(text)?'failures'
    :/\b(?:evidence|report|trace|screenshot)\b/i.test(text)?'evidence'
    :/\b(?:latest|last|status)\b/i.test(text)?'latest':/^(?:help|hi|hello)[!?.]?$/i.test(text)?'help':'explain'
  return {kind,suite,runId,text}
}
export function reportLink(id, environment=process.env) {
  try {
    const base=new URL(environment.QA_REPORT_BASE_URL)
    if(base.protocol==='https:'&&!base.username&&!base.password&&!base.search&&!base.hash)
      return `<${base.href.replace(/\/$/,'')}/${encodeURIComponent(id)}.md|Sanitized report>`
  } catch { /* local evidence still available */ }
  return `<${dashboardRunUrl(id)}|Local dashboard (scheduler host; private session required)>`
}
function suiteTests(run,suite) {
  if(!suite||run.suite===suite) return run.tests||[]
  const names=new Set((run.steps||[]).filter(s=>s.fromSuite===suite).map(s=>s.name))
  return (run.tests||[]).filter(t=>names.has(t.step)||(suite==='api'&&t.project==='api')||(suite==='uat'&&t.project==='uat')||(suite==='load'&&t.adapter==='k6')||(suite==='regression'&&t.project==='chromium'))
}
export async function answerQuestion(question, options={}) {
  const {index=readIndex,read=readRun,scheduler=()=>readLock('scheduler'),schedules=config.schedules,environment=process.env,
    ai=false,explain=explainEvidence}=options
  const parsed=parseRequest(question)
  if(['help','invalid-rerun','rerun'].includes(parsed.kind)) return help
  if(parsed.kind==='scheduler') {
    const lock=scheduler()
    return lock&&!lock.stale?'Scheduler is running. This describes the worker process; it does not prove the application stack is healthy.':'Scheduler is stopped or its process lock is stale.'
  }
  if(parsed.kind==='schedule') {
    const spec=schedules()
    return `Testing schedules (${plain(spec.timezone)}):\n${spec.schedules.filter(s=>s.enabled).map(s=>`${plain(s.suite)}: ${plain(s.cron)}`).join('\n')}\nCron fields: minute, hour, day of month, month, day of week.`
  }
  const runs=index().slice(-100).reverse().map(r=>read(r.runId)).filter(r=>r&&r.finishedAt&&r.status!=='running'&&!r.seededDefect&&!r.reportOnly)
  const relevant=runs.filter(r=>(!parsed.runId||r.runId===parsed.runId)&&(!parsed.suite||r.suite===parsed.suite||suiteTests(r,parsed.suite).length))
  const chosen=parsed.kind==='last-pass'?relevant.find(r=>{
    const tests=suiteTests(r,parsed.suite)
    return tests.length>0&&tests.every(t=>t.status==='passed')&&!['infra-failed','crashed','timed-out'].includes(r.status)
  }):relevant[0]
  if(parsed.kind==='explain') {
    if(!ai) return `${help}\nAI explanations are disabled; recorded facts are available through the questions above.`
    const evidence=relevant.slice(0,5).map(r=>{
      const s=publicSummary(r)
      return {runId:s.runId,suite:s.suite,environment:s.environment,status:s.status,finishedAt:s.finishedAt,counts:s.counts,
        health:s.pipeline.environment.health,stack:s.pipeline.environment.stack,checks:s.checks.slice(0,20)}
    })
    if(!evidence.length) return 'No recorded evidence is available for that question.'
    try {
      const result=await explain({question:plain(parsed.text).slice(0,800),runs:evidence})
      if(!result||typeof result.answer!=='string'||!result.answer.trim()||result.answer.length>2000||!Array.isArray(result.runIds)||!result.runIds.length
        ||result.runIds.some(id=>!evidence.some(r=>r.runId===id))) throw new Error('Unvalidated explanation')
      return `Advisory explanation (suspected causes require investigation):\n${plain(result.answer).replace(/https?:\/\/\S+/g,'[link omitted]')}\n${result.runIds.map(id=>`Source: ${id} · ${reportLink(id,environment)}`).join('\n')}`
    } catch {return 'AI explanation is unavailable or could not be validated. Ask for the latest run, failures, or evidence to see recorded results.'}
  }
  if(!chosen) return 'No matching recorded run or passing evidence was found in the latest 100 runs.'
  const summary=publicSummary(chosen),subset=parsed.suite&&chosen.suite!==parsed.suite?suiteTests(chosen,parsed.suite):null
  const c=subset?Object.fromEntries(['passed','failed','skipped','blocked'].map(status=>[status,subset.filter(t=>t.status===status).length])):summary.counts
  const lines=[`Source: ${summary.runId} · ${summary.suite} · ${summary.environment} · ${summary.status}`,
    `${summary.finishedAt} · ${c.passed} passed, ${c.failed} failed, ${c.skipped} skipped, ${c.blocked} blocked.`,reportLink(summary.runId,environment)]
  if(subset)lines.push(`Counts and checks shown cover ${parsed.suite} only; ${summary.status} is the overall combined-run status.`)
  if(['failures','evidence'].includes(parsed.kind)) {
    const selected=new Set(subset||chosen.tests||[])
    const checks=summary.checks.filter((t,i)=>selected.has(chosen.tests[i])&&['failed','blocked'].includes(t.status))
    if(!checks.length) lines.push('No failed or blocked assertions were recorded. Infrastructure failure can prevent all assertions from executing.')
    lines.push(...checks.slice(0,12).map(t=>`${t.status}: ${t.name} — ${t.reason||'See source report.'} (${t.classification||'not executed'})`))
    if(checks.length>12) lines.push(`${checks.length-12} additional checks are in the source report.`)
    lines.push('Suspected findings are not confirmed product defects. Raw screenshots, traces and logs remain in the private report.')
  }
  return lines.join('\n')
}
