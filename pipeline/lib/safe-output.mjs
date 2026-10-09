import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { config, knownSecrets, RUNS_DIR } from './env.mjs'

const testNames=JSON.parse(readFileSync(new URL('../config/test-case-names.json',import.meta.url),'utf8'))
export const opaqueId = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 16)
export const REPORT_CATEGORIES=[{suite:'regression',label:'Web automation regression testing'},{suite:'api',label:'API testing'},{suite:'load',label:'Load testing'}]
export function safeText(value) {
  let text = String(value ?? '')
  for (const secret of knownSecrets()) text = text.split(secret).join('[REDACTED]')
  return text.replace(/xox[baprs]-[\w-]+|xapp-[\w-]+|sk-[\w-]+/g, '[REDACTED]')
    .replace(/https:\/\/hooks\.slack(?:-gov)?\.com\/services\/[^\s"<>]+/g, '[REDACTED]')
    .replace(/(?:authorization|cookie|password|secret|token|seed phrase)\s*[:=][^\n]*/gi, '[REDACTED]')
    .replace(/0x[\da-f]{40,}/gi, '[ADDRESS]')
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[EMAIL]')
}
export function redactValue(value) {
  if(typeof value==='string')return safeText(value)
  if(Array.isArray(value))return value.map(redactValue)
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,redactValue(v)]))
  return value
}
export function kstTime(date) {
  return `${new Intl.DateTimeFormat('en-GB', { timeZone:'Asia/Seoul', year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23' }).format(new Date(date))} KST`
}
function diagnosticReason(test) {
  const raw=[...(test.errors??[]),test.skipReason??''].join('\n').replace(/\u001b\[[0-9;]*m/g,'')
  if(/ECONNREFUSED|ERR_CONNECTION_REFUSED/.test(raw))return 'Target app unreachable (connection refused).'
  if(/ECONNRESET|ERR_CONNECTION_RESET|socket hang up/.test(raw))return 'Connection to the target app was interrupted (the app dropped the request).'
  const button=raw.match(/getByRole\('button', \{ name: '(Join Unity|Join the waitlist|Sign in|Switch network)'/)
  if(button&&/Timeout/.test(raw))return `Timed out waiting for button "${button[1]}". The expected control was not available.`
  if(/Expected:.*BNB Smart Chain Testnet/.test(raw)&&/Received:.*Local Anvil/.test(raw))return 'Network name mismatch: test expected BNB Smart Chain Testnet; local app displayed Local Anvil.'
  if(/name: 'Digging'/.test(raw)&&/toBeVisible/.test(raw))return 'The legacy Digging heading was not found. Current local app uses the My Mine activity tab and requires membership.'
  if(/Recorded journey requires a My Mine certificate/.test(raw))return 'Recorded journey requires a My Mine certificate for the test wallet.'
  if(/QA_SEED_PHRASE.*not set/.test(raw))return 'Wallet signing fixture is not configured.'
  if(/toHaveText|toHaveAccessibleName/.test(raw))return 'UI text did not match the expected application copy.'
  if(/toBeVisible/.test(raw))return 'Expected UI control was not visible before the assertion timeout.'
  if(/Timeout|timed out/i.test(raw))return 'Test step exceeded its time limit.'
  return ['skipped','blocked'].includes(test.status)?'Prerequisite not met; see private local execution evidence.':'Assertion failed; see private local execution evidence.'

}
const STATUS_ORDER=['failed','blocked','skipped','passed']
export const CHECK_ICONS={passed:'✅',failed:'❌',skipped:'⏭️',blocked:'⛔'}
/** Report category for a test; matches REPORT_CATEGORIES labels so plain runs and combined previews group alike. */
function categoryOf(t,run) {
  const suite=(run.steps??[]).find(s=>s.name===t.step)?.fromSuite
  const label=REPORT_CATEGORIES.find(c=>c.suite===suite)?.label??(suite==='uat'?'UAT scenarios':null)
  if(label)return label
  if(t.adapter==='k6')return 'Load testing'
  if(t.adapter==='playwright')return t.project==='api'?'API testing':'Web automation regression testing'
  if(t.adapter==='webmpc-scenarios')return 'UAT scenarios'
  return 'Other checks'
}
const LOAD_BREACH=/^(no requests recorded|p95 \d+ms > \d+ms|error rate [\d.]+% > [\d.]+%|p95 regressed -?\d+% vs baseline \d+ms|error rate rose -?[\d.]+ points vs baseline)$/
/** Load checks are named from allowlisted config (endpoint keys in thresholds.json), never from raw output. */
function loadCheck(t,run,thresholds) {
  const name=(t.key??'').split(':').slice(2).join(':'),pct=v=>`${(v*100).toFixed(2)}%`
  if(Object.hasOwn(thresholds.endpoints,name)) {
    const row=run.load?.endpoints?.[name],slo=thresholds.endpoints[name]
    const detail=Number.isFinite(row?.p95Ms)?`p95 ${Math.round(row.p95Ms)} ms (limit ${slo.p95Ms} ms) · errors ${Number.isFinite(row.errorRate)?pct(row.errorRate):'n/a'} (limit ${pct(slo.maxErrorRate)})`:null
    // Breach strings come from fixed templates in adapters/k6.mjs; publish only exact template matches.
    const breaches=(row?.breaches??[]).filter(b=>LOAD_BREACH.test(b))
    return {name:`${name} — p95 & error-rate SLO`,detail,breaches}
  }
  if(name==='throughput')return {name:`Throughput ≥ ${thresholds.minThroughputRps} req/s`,detail:Number.isFinite(run.load?.throughputRps)?`${run.load.throughputRps.toFixed(2)} req/s`:null}
  if(name==='checks')return {name:'Functional checks hold under load',detail:Number.isFinite(run.load?.checkPassRate)?`${(run.load.checkPassRate*100).toFixed(1)}% checks passed`:null}
  return null
}
// Publication is allowlisted. Raw errors, test titles, URLs, attachments and screenshots stay private.
export function publicSummary(run) {
  const approved=new Set(config.requirements().filter(r=>r.approved).map(r=>r.id))
  const count = n => Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0
  const field = value => safeText(value).replace(/[<>&`\n\r]/g,'').slice(0,120)
  const fraction=value=>Number.isFinite(value)&&value>=0&&value<=1?value:null
  const metric = value => Number.isFinite(value)&&value>=0?Number(value.toFixed(2)):null
  const thresholds=config.thresholds()
  const summary={ runId:field(run.runId), suite:field(run.suite), environment:field(run.env),status:field(run.status),
    reportOnly:run.reportOnly===true, allureReport:run.allure?.generated===true,
    sections:(run.reportSections??[]).filter(s=>REPORT_CATEGORIES.some(c=>c.suite===s.suite)).map(s=>({
      label:REPORT_CATEGORIES.find(c=>c.suite===s.suite).label,status:field(s.status),sourceRunId:field(s.sourceRunId),finishedAt:kstTime(s.finishedAt),
      counts:Object.fromEntries(['passed','failed','skipped','blocked'].map(k=>[k,count(s.counts?.[k])]))})),
    loadMetrics:run.load?{totalRequests:metric(run.load.totalRequests),throughputRps:metric(run.load.throughputRps),checkPassRate:fraction(run.load.checkPassRate),
      endpoints:Object.entries(run.load.endpoints??{}).filter(([name])=>Object.hasOwn(config.thresholds().endpoints,name)).map(([name,row])=>({name,p95Ms:metric(row.p95Ms),errorRate:fraction(row.errorRate)}))}:null,
    finishedAt:kstTime(run.finishedAt), applicationVersion:field(run.versions?.app?.id || 'unspecified'),
    counts:Object.fromEntries(['passed','failed','skipped','blocked'].map(k=>[k,count(run.counts?.[k])])),
    checks:(run.tests??[]).map(t=>{
      const annotations=t.annotations??[], confirmation=annotations.find(a=>a.type==='defect-confirmed')
      const requirementId=confirmation?.description?.match(/^([A-Z]+-\d+):/)?.[1]
      const confirmed=t.status==='failed'&&approved.has(requirementId)
      const load=t.adapter==='k6'?loadCheck(t,run,thresholds):null
      return {id:opaqueId(t.key),name:load?.name??testNames[(t.title??'').split(' > ').at(-1)?.match(/^([WAPMC]\d{2}) - /)?.[1]]??`Check ${opaqueId(t.key)}`,status:field(t.status),
        category:categoryOf(t,run),detail:load?.detail??null,
        reason:['failed','blocked','skipped'].includes(t.status)?(load?.detail&&t.status==='failed'?`${load.breaches?.length?`Breached: ${load.breaches.join('; ')}. Measured`:'SLO breached'}: ${load.detail}`:diagnosticReason(t)):null,
        requirementIds:(t.requirementIds??[]).filter(id=>approved.has(id)),
        classification:t.status==='failed'?(confirmed?'confirmed':'suspected'):annotations.some(a=>a.type==='usability-related')?'usability-related':null,
        critical:confirmed&&annotations.some(a=>a.type==='severity'&&a.description==='critical')}
    }),
    aiStatus:field(run.ai?.status || 'not-requested') }
  summary.pipeline=pipelineStages(run,summary.checks,{field,count})
  return summary
}

/**
 * Allowlisted view of each pipeline stage (environment → adapters → assertions → evidence → comparison) for Slack.
 * Comparison entries reuse the checks' public names; raw titles and fingerprints never leave the run record.
 */
function pipelineStages(run,checks,{field,count}) {
  const profile=config.environments()[run.env]??{},stack=run.health?.stack
  const names=new Map((run.tests??[]).map((t,i)=>[t.key,checks[i]?.name]))
  const named=list=>(list??[]).map(t=>names.get(t.key)).filter(Boolean)
  const cmp=run.comparison
  return {
    trigger:field(run.trigger),scheduleId:field(run.scheduleId??''),
    environment:{name:field(run.env),isolated:profile.isolated===true,writes:profile.allowWrites===true,load:profile.allowLoad===true,
      health:run.health?{ok:run.health.ok===true,httpStatus:count(run.health.status)}:null,
      stack:stack?{healthy:stack.healthy===true,services:count((stack.services?.length??0)+(stack.missingServices?.length??0)),unhealthy:count((stack.missingServices?.length??0)+(stack.unhealthyServices?.length??0))}:null,
      // Step names and statuses only; details can carry wallet or RPC text and stay in the private run record.
      testData:run.testData?{status:field(run.testData.status),steps:(run.testData.steps??[]).map(x=>({name:field(x.name),status:field(x.status)}))}:null},
    steps:(run.steps??[]).map(s=>({adapter:field(s.adapter),suite:field(s.fromSuite??run.suite??''),target:field(s.project??s.script??s.command??''),tests:count(s.testCount),
      durationMs:count(s.durationMs),timedOut:s.timedOut===true,errors:count(s.errors?.length)})),
    coverage:run.coverage?{criticalPassed:count(run.coverage.numerator),criticalTotal:count(run.coverage.denominator)}:null,
    evidence:{htmlReports:(run.steps??[]).filter(s=>s.artifacts?.htmlReport).length,logs:(run.steps??[]).filter(s=>s.artifacts?.log).length,
      allure:run.allure?.generated===true,loadSummary:!!run.load},
    comparison:cmp?{previousRunId:field(cmp.previousRunId??''),newFailures:named(cmp.newFailures),persisting:named(cmp.persisting),
      newVariants:named(cmp.newVariants),recovered:named(cmp.recovered)}:null,
  }
}

export function publishSummary(run) {
  if(!/^[A-Za-z0-9][\w-]{0,99}$/.test(run.runId))throw new Error('Invalid publication run ID')
  const dir=join(RUNS_DIR,'published'),s=publicSummary(run),c=s.counts
  mkdirSync(dir,{recursive:true,mode:0o700})
  const path=join(dir,`${run.runId}.md`)
  writeFileSync(path,[`# MPC QA — ${s.suite} ${s.status}`,'',
    ...(s.reportOnly?['Recorded results preview. These checks ran in the source run; this preview does not execute new tests.','']:[]),
    `Version: ${s.applicationVersion}`,s.finishedAt,
    `${c.passed} passed | ${c.failed} failed | ${c.skipped} skipped | ${c.blocked} blocked`,'',
    ...(s.sections.length?['| Testing | Status | Passed | Failed | Skipped | Blocked |','| --- | --- | ---: | ---: | ---: | ---: |',
      ...s.sections.map(r=>`| ${r.label} | ${r.status} | ${r.counts.passed} | ${r.counts.failed} | ${r.counts.skipped} | ${r.counts.blocked} |`),'',
      ...s.sections.map(r=>`${r.label}: source ${r.sourceRunId}; completed ${r.finishedAt}.`),'']:[]),
    ...(s.loadMetrics?[`Load: ${s.loadMetrics.totalRequests??'unavailable'} requests | ${s.loadMetrics.throughputRps??'unavailable'} requests/s | Functional check rate: ${s.loadMetrics.checkPassRate===null?'unavailable':`${(s.loadMetrics.checkPassRate*100).toFixed(1)}%`}`,'',
      '| Endpoint | p95 (ms) | Error rate |','| --- | ---: | ---: |',...s.loadMetrics.endpoints.map(r=>`| ${r.name} | ${r.p95Ms??'unavailable'} | ${r.errorRate===null?'unavailable':`${(r.errorRate*100).toFixed(2)}%`} |`),'']:[]),
    ...groupChecks(s.checks).flatMap(([category,checks])=>[`## ${category}`,'',`${tally(checks)}`,'','| Result | Test case | Requirements | Reason / measurement |','| --- | --- | --- | --- |',
      ...checks.map(t=>`| ${CHECK_ICONS[t.status]??''} ${t.status}${t.critical?' (critical)':''} | ${t.name} | ${t.requirementIds.join(', ')||'—'} | ${t.reason??t.detail??''} |`),'']),
    'Raw traces, screenshots, credentials and sensitive test data are excluded from this published report.',
  ].join('\n'),{mode:0o600})
  return path
}

/** Checks grouped by category (report order first), each sorted failures-first then by name. */
export function groupChecks(checks) {
  const groups=new Map()
  for(const c of checks)(groups.get(c.category)??groups.set(c.category,[]).get(c.category)).push(c)
  const order=[...REPORT_CATEGORIES.map(c=>c.label),'UAT scenarios','Other checks']
  return [...groups].sort(([a],[b])=>order.indexOf(a)-order.indexOf(b))
    .map(([category,list])=>[category,list.sort((a,b)=>STATUS_ORDER.indexOf(a.status)-STATUS_ORDER.indexOf(b.status)||a.name.localeCompare(b.name,'en',{numeric:true}))])
}
export function tally(checks) {
  const n=status=>checks.filter(c=>c.status===status).length
  return ['passed','failed','skipped','blocked'].filter((k,i)=>i<2||n(k)).map(k=>`${n(k)} ${k}`).join(' · ')
}
