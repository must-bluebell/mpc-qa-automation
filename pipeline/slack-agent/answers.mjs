import { readIndex, readRun } from '../lib/run-store.mjs'
import { readLock } from '../lib/lock.mjs'
import { config } from '../lib/env.mjs'
import { publicSummary, safeText, dashboardRunUrl } from '../lib/safe-output.mjs'
import { explainEvidence } from './explain.mjs'
import { answerPullRequest } from './pr-evidence.mjs'
import { runStatus } from '../lib/run-status.mjs'

export const plain = value => safeText(value).replace(/[<>&`]/g,'').slice(0,2800)
const help = 'Ask about my testing capabilities, reporting repository, latest test results, failed cases, last passing run, evidence, testing schedules, or the last tested/merged PR. For example: “what can you do?”, “how did the tests go?”, or “who merged the code?”. To request a rerun: “rerun api” (also smoke, regression, uat, load, full). A rerun requires authorization and confirmation.'
const capabilities = `I am MPC QA Agent. My role is testing:
1. Request reruns of browser, API, regression, UAT, and load tests.
2. Show the latest results: passed, failed, skipped, and blocked checks.
3. Report failures and share recorded test evidence.
4. Find the last passing test run.
5. Show testing schedules and scheduler status.
6. Show the last tested PR and its QA check results.
7. Show the last merged PR, who merged it, and recorded merge details.

Test reruns require authorization and confirmation. Ask “show the latest report” for results or “rerun api” to request a test run.`
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
  if(has(/\b(?:pr|pull request)\b/)
    ||(has(/\b(?:who|how)\b/)&&has(/\b(?:merged?|landed|integrated)\b/)&&has(/\bcode\b/))) {
    if(has(/\b(?:merged?|landed|integrated)\b/))return simple('pr-merged')
    if(has(/\b(?:test(?:ed|ing)?|check(?:ed)?|verified|validated|fail(?:ed|ures?)?|last|latest|recently)\b/))return simple('pr-tested')
  }
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
    ai=false,explain=explainEvidence,prEvidence=answerPullRequest}=options
  const parsed=parseRequest(question)
  if(parsed.kind==='capabilities') return `${capabilities}\n\n${repositoryScope(environment)}`
  if(parsed.kind==='repositories') return repositoryScope(environment)
  if(parsed.kind.startsWith('pr-'))return prEvidence(parsed.kind.slice(3),{repository:environment.QA_SLACK_PR_REPOSITORY})
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
  const chosen=parsed.kind==='last-pass'?relevant.find(r=>passingEvidence(r,parsed.suite)):relevant[0]
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
