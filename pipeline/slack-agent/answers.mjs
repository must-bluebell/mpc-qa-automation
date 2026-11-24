import { readIndex, readRun } from '../lib/run-store.mjs'
import { readLock } from '../lib/lock.mjs'
import { config, RUNS_DIR } from '../lib/env.mjs'
import { publicSummary, safeText, dashboardRunUrl } from '../lib/safe-output.mjs'
import { explainEvidence } from './explain.mjs'
import { answerPullRequest } from './pr-evidence.mjs'
import { runStatus } from '../lib/run-status.mjs'
import { recentRuns, highPriorityCases, healthReport } from './insights.mjs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const plain = value => safeText(value).replace(/[<>&`]/g,'').slice(0,2800)
const help = 'Ask about my capabilities, recent test runs, latest results, failed or high-priority cases, last passing run, evidence, schedules, system health (for example “system health last 7 days”), or recently tested and merged PRs. To request a rerun: “rerun api” (also smoke, regression, uat, load, full). Reruns and test case drafts require an authorized user; reruns also need confirmation.'
const capabilities = `I am MPC QA Agent. My role is testing:
1. Request reruns of API, browser, regression, UAT, load, and full suites. Authorized users only; each rerun needs confirmation.
2. Show recent test runs: suite, environment, status, pass and fail counts, and how each run was started.
3. Show the latest results: passed, failed, skipped, and blocked checks.
4. List failed and blocked cases, with recorded evidence and report links.
5. Show the last passing test run.
6. List high-priority cases (tests tagged @critical in the test suite).
7. Show system health for a period, for example "system health last 7 days" (1 to 30 days).
8. Show testing schedules and scheduler status.
9. Show recently tested PRs, the last tested PR and its QA checks, and the last merged PR and who merged it.
10. Create draft test cases for authorized users. Drafts are saved to testplans/drafts and are not committed.
11. Answer general QA questions when AI is enabled.

Ask “show the latest report” for results, or “rerun api” to request a test run.`
const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, fourteen: 14, thirty: 30 }
// Health window in days: "last 7 days" → 7, "last week" → 7, default 1 (24 hours). Capped at 30.
function healthWindow(q) {
  const m = q.match(/\b(\d{1,3}|one|two|three|four|five|six|seven|fourteen|thirty)\s*(?:days?|d)\b/)
  if (m) return Math.min(30, Math.max(1, Number(m[1]) || NUMBER_WORDS[m[1]] || 1))
  if (/\b(?:last|past|this) week\b|\bweekly\b/.test(q)) return 7
  if (/\b(?:last|past|this) month\b|\bmonthly\b/.test(q)) return 30
  return 1
}
function schedulerJobs() {
  try { return JSON.parse(readFileSync(join(RUNS_DIR, 'scheduler-state.json'), 'utf8')).jobs ?? [] } catch { return [] }
}
const finishedRuns = (index, read, limit) => index().slice(-limit).reverse().map(r => read(r.runId))
  .filter(r => r && r.finishedAt && r.status !== 'running' && !r.seededDefect && !r.reportOnly)
function repositoryScope(environment) {
  const repository=environment.QA_SLACK_PR_REPOSITORY
  return /^[\w.-]+\/[\w.-]+$/.test(repository||'')
    ? `Configured QA/PR reporting repository: ${repository}. This is my configured reporting scope; access to other repositories is not verified.`
    : 'A QA/PR reporting repository is not configured. Repository permissions outside this reporting scope are not verified.'
}
// Normalize wording only for read-only questions. Execution commands keep their exact grammar.
function questionWords(text) {
  return text.normalize('NFKC').replace(/<@[A-Z0-9]+(?:\|[^>]*)?>/gi,' ')
    .toLowerCase().replace(/[‘’]/g,"'").replace(/\bwhat's\b/g,'what is')
    .replace(/\b(?:capabilties|capaabilties|capablities)\b/g,'capabilities')
    .replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ')
}
export function parseRequest(value) {
  const text=String(value||'').replace(/^\s*<@[A-Z0-9]+>\s*/, '').trim().slice(0,1200)
  const command=text.match(/^(?:please )?rerun (smoke|api|regression|uat|load|full)(?: (?:on|in) ([\w-]+))?[.!?]?$/i)
  if(command) return {kind:'rerun',suite:command[1].toLowerCase(),env:command[2]?.toLowerCase()||'local-docker'}
  if(/\b(?:rerun|execute|run again)\b/i.test(text)) return {kind:'invalid-rerun'}
  const q=questionWords(text),has=pattern=>pattern.test(q)
  const simple=kind=>({kind,suite:null,runId:null,text})
  if(has(/\b(?:capabilities|capability|capable|abilities)\b/)
    ||has(/\b(?:your|agent(?: s)?) (?:role|skills|purpose|functions)\b/)
    ||has(/\bwhat (?:are you|you are) able to do\b/)
    ||has(/\b(?:introduce yourself|tell me about yourself|who are you|how can you help|what (?:is|s) your purpose)\b/)
    ||has(/\bwhat (?:can|could|does|do|will) (?:you|(?:the )?(?:mpc )?(?:qa )?agent) (?:do|test|check|support|help with)\b/)
    ||has(/\bwhat you (?:can|could|will) (?:do|test|check)\b/)
    ||has(/\b(?:which|what) tests (?:do|can) you (?:support|run|test)\b/))return simple('capabilities')
  if(has(/\b(?:repos?|repositories|repository)\b/)
    &&(has(/\b(?:access|permissions?|connected|scope)\b/)
      ||has(/\b(?:which|what)\b.*\b(?:test|testing|check|support)\b/)))return simple('repositories')
  if(has(/\b(?:create|write|draft|generate|make|add)\b/)&&has(/\b(?:test cases?|test plans?|test scenarios?|test scripts?|test suites?)\b/))
    return simple('create-tests')
  if(has(/\b(?:prs?|pull requests?)\b/)
    ||(has(/\b(?:who|how)\b/)&&has(/\b(?:merged?|landed|integrated)\b/)&&has(/\bcode\b/))) {
    if(has(/\b(?:merged?|landed|integrated)\b/))return simple('pr-merged')
    if(has(/\b(?:prs|pull requests)\b/)&&has(/\b(?:tests?|tested|testing|checks?|checked|qa)\b/)&&!has(/\b(?:last|latest|most recent)\b/))return simple('pr-list')
    if(has(/\b(?:test(?:ed|ing)?|check(?:ed)?|verified|validated|fail(?:ed|ures?)?|last|latest|recently)\b/))return simple('pr-tested')
  }
  if(has(/\b(?:health|healthy|unhealthy|system status|stack status|how is (?:the )?(?:system|stack|qa))\b/))
    return {...simple('health'),days:healthWindow(q)}
  if((has(/\b(?:priority|priorities|p0|p1)\b/)||(has(/\b(?:critical|high)\b/)&&has(/\b(?:cases?|tests?)\b/)))
    &&!has(/\b(?:fail|failed|failing|failure|failures|broken)\b/))return simple('priority')
  // Run listings only when the question does not ask for a result, status, or specific kind of run.
  if(has(/\b(?:recent|past|all|list)\b.*\bruns?\b|\bruns? (?:history|log|list)\b|\blast \d+ runs?\b|\bwho (?:ran|runs|triggered|started|kicked off)\b/)
    &&!has(/\b(?:results?|outcomes?|status|pass(?:ed|ing)?|successful|green|fail(?:ed|ures?)?|evidence|most recent|latest)\b/))
    return simple('runs')
  const suite=has(/\b(?:api|endpoints?)\b/)?'api':has(/\b(?:uat|acceptance)\b/)?'uat'
    :has(/\b(?:load|performance|stress)\b/)?'load':has(/\bnightly\b/)?'nightly-regression'
    :has(/\b(?:web|browser|regression|ui|e2e)\b|\bend to end\b/)?'regression'
    :has(/\bsmoke\b/)?'smoke':has(/\bfull\b/)?'full':null
  const match=text.replace(/\s+(?:please|thanks|thank you)[.!?]?$/i,'').match(/\b(?:report|run|evidence)(?: for)? ([A-Za-z0-9][\w-]{0,99})[?.!]?$/i)
  const runId=match&&!['latest','last','api','uat','load','full','regression','smoke','nightly','please','details','summary','now','results','result','status','outcome','updates'].includes(match[1].toLowerCase())?match[1]:null
  const qaContext=has(/\b(?:qa|tests?|testing|checks?|runs?|results?|failures?|errors?|pattern|trend|performance)\b/)
  const kind=has(/\bscheduler\b|\bis scheduling (?:active|running|enabled)\b/)?'scheduler'
    :has(/\b(?:pass|passed|passing|green|successful)\b/)&&has(/\b(?:when|last|latest|previous|most recent)\b/)?'last-pass'
    :has(/\b(?:schedule|schedules|scheduled|scheduling|timetable|cron)\b/)
      ||(has(/\b(?:when|what time)\b/)&&has(/\b(?:next|run|start|happen)\b/)&&qaContext)?'schedule'
    :has(/\b(?:fail|failed|failing|failure|failures|broken|unsuccessful)\b/)?'failures'
    :has(/\b(?:evidence|reports?|traces?|screenshots?)\b/)?'evidence'
    :has(/\b(?:explain|analyze|analyse|why)\b|\broot cause\b/)&&qaContext?'explain'
    :has(/\b(?:results?|outcomes?|updates?|summary|status)\b/)
      ||(has(/\b(?:latest|last|recent)\b/)&&qaContext)
      ||has(/\bhow did (?:the )?(?:qa |api |uat |load |browser |ui )?(?:tests?|testing|checks?) go\b/)?'latest':'help'
  return {kind,suite,runId,text}
}
const qaScope=text=>/\b(?:qa|quality|tests?|testing|tested|checks?|regressions?|smoke|uat|acceptance|load|performance|stress|api|endpoints?|e2e|browser|ui|playwright|k6|coverage|assertions?|flaky|bugs?|defects?|failures?|failing|scenarios?|automation|fixtures?|runs?|results?|reports?|evidence|traces?|screenshots?|schedules?|scheduler|pr|pull requests?|merged?)\b/i.test(questionWords(String(text||'')))
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
  const steps=new Map((run.steps||[]).map(s=>[s.name,s]))
  return (run.tests||[]).filter(t=>{
    const fromSuite=steps.get(t.step)?.fromSuite
    if(fromSuite) return fromSuite===suite
    return (suite==='api'&&t.project==='api')||(suite==='uat'&&t.project==='uat')||(suite==='load'&&t.adapter==='k6')||(suite==='regression'&&t.project==='chromium')
  })
}
function passingEvidence(run,suite) {
  const tests=suiteTests(run,suite)
  if(!tests.length||!tests.every(t=>t.status==='passed'))return false
  if(!suite||run.suite===suite) {
    return run.status==='passed'&&runStatus({tests,steps:run.steps||[]})==='passed'&&!run.errors?.length
  }
  // A combined run can fail elsewhere. Accept only a fully recorded requested suite:
  // every configured step must have exited successfully, with all its checks attributed.
  if(!['passed','failed','infra-failed','timeout','blocked'].includes(run.status))return false
  const expected=config.suites()[suite]?.steps
  if(!expected?.length)return false
  const names=new Set(tests.map(t=>t.step))
  const steps=(run.steps||[]).filter(s=>s.fromSuite===suite||names.has(s.name))
  if(steps.length!==expected.length||steps.some(s=>s.fromSuite!==suite)
    ||tests.some(t=>!t.step||!steps.some(s=>s.name===t.step)))return false
  const remaining=[...steps]
  for(const spec of expected) {
    const index=remaining.findIndex(s=>s.adapter===spec.adapter&&(s.project||null)===(spec.project||null)
      &&(s.grep||null)===(spec.grep||null))
    if(index<0)return false
    remaining.splice(index,1)
  }
  return steps.every(s=>s.exitCode===0&&!s.timedOut&&!s.errors?.length)
    &&runStatus({tests,steps})==='passed'
}
export async function answerQuestion(question, options={}) {
  const {index=readIndex,read=readRun,scheduler=()=>readLock('scheduler'),schedules=config.schedules,environment=process.env,
    ai=false,explain=explainEvidence,prEvidence=answerPullRequest,jobs=schedulerJobs}=options
  const parsed=parseRequest(question)
  if(parsed.kind==='capabilities') return `${capabilities}\n\n${repositoryScope(environment)}`
  if(parsed.kind==='runs') return recentRuns(finishedRuns(index,read,100))
  if(parsed.kind==='priority') return highPriorityCases()
  if(parsed.kind==='health') return healthReport({runs:finishedRuns(index,read,500),days:parsed.days,schedules:schedules(),jobs:jobs(),
    reportBase:environment.QA_REPORT_BASE_URL})
  // Creating drafts changes the working tree, so only the Slack agent handler runs it after an authorization check.
  if(parsed.kind==='create-tests') return 'Test case drafts can be created only by an authorized QA user. Ask an authorized user to make the request.'
  if(parsed.kind==='repositories') return repositoryScope(environment)
  if(parsed.kind.startsWith('pr-'))return prEvidence(parsed.kind.slice(3),{repository:environment.QA_SLACK_PR_REPOSITORY})
  // Unmatched questions reach AI only when they look like QA; everything else keeps the deterministic help text.
  if(['invalid-rerun','rerun'].includes(parsed.kind)||(parsed.kind==='help'&&(!ai||!qaScope(parsed.text)))) return help
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
  const chosen=parsed.kind==='last-pass'?relevant.find(r=>passingEvidence(r,parsed.suite)):relevant[0]
  if(parsed.kind==='explain'||parsed.kind==='help') {
    if(!ai) return `${help}\nAI explanations are disabled; recorded facts are available through the questions above.`
    const general=parsed.kind==='help'
    const evidence=relevant.slice(0,5).map(r=>{
      const s=publicSummary(r)
      return {runId:s.runId,suite:s.suite,environment:s.environment,status:s.status,finishedAt:s.finishedAt,counts:s.counts,
        health:s.pipeline.environment.health,stack:s.pipeline.environment.stack,checks:s.checks.slice(0,20)}
    })
    if(!evidence.length&&!general) return 'No recorded evidence is available for that question.'
    try {
      const result=await explain({question:plain(parsed.text).slice(0,800),runs:evidence,general})
      if(!result||typeof result.answer!=='string'||!result.answer.trim()||result.answer.length>2000||!Array.isArray(result.runIds)
        ||(!general&&!result.runIds.length)||result.runIds.some(id=>!evidence.some(r=>r.runId===id))) throw new Error('Unvalidated explanation')
      const body=plain(result.answer).replace(/https?:\/\/\S+/g,'[link omitted]')
      const sources=result.runIds.map(id=>`Source: ${id} · ${reportLink(id,environment)}`)
      return general
        ? [`AI QA answer (general guidance is not from recorded runs; cited runs are listed below):`,body,...sources].join('\n')
        : `Advisory explanation (suspected causes require investigation):\n${body}\n${sources.join('\n')}`
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
