import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cronMatches } from './scheduler.mjs'
import { RUNS_DIR } from './lib/env.mjs'
import { readIndex, readRun, isRunId, writeJsonAtomic } from './lib/run-store.mjs'
import { kstTime, publicSummary, dashboardRunUrl } from './lib/safe-output.mjs'
import { notifyHealthSummary } from './notify/slack-bot.mjs'
import { executionRecovered } from './lib/run-status.mjs'

const statuses=['passed','failed','skipped','blocked']
const counts=()=>Object.fromEntries(statuses.map(s=>[s,0]))
const safeId=value=>isRunId(value)?value:'unknown'
const safeStatus=value=>['passed','failed','blocked','infra-failed','crashed','timeout','skipped','skipped-overlap'].includes(value)?value:'unknown'
const inWindow=(value,start,end)=>Date.parse(value)>=start&&Date.parse(value)<end

/** Aggregate actual executions, never insert a synthetic test run into history. Rates are fractions. */
export function buildHealthSummary({end,env,schedules=[],runs=[],jobs=[],timezone='Asia/Seoul'}) {
  const cutoff=Date.parse(end),start=cutoff-86_400_000
  if(!Number.isFinite(cutoff))throw new Error('Invalid summary cutoff')
  const eligible=runs.filter(r=>r.env===env&&!r.seededDefect&&!r.reportOnly&&r.status!=='running'&&Date.parse(r.finishedAt)<cutoff)
  const window=eligible.filter(r=>inWindow(r.finishedAt,start,cutoff))
  const categories={api:counts(),uat:counts(),web:counts(),load:counts(),other:counts()},total=counts()
  const failureEvents={new:0,recurring:0,newVariants:0,recovered:0}
  let executionFailures=0
  for(const run of window) {
    if(!['passed','failed','skipped'].includes(run.status)||run.errors?.length)executionFailures++
    for(const [name,key] of Object.entries({new:'newFailures',recurring:'persisting',newVariants:'newVariants',recovered:'recovered'}))failureEvents[name]+=run.comparison?.[key]?.length??0
    for(const t of run.tests??[]) {
      if(!statuses.includes(t.status))continue
      const step=(run.steps??[]).find(s=>s.name===t.step)
      const source=step?.fromSuite??run.suite,project=t.project??step?.project
      const category=project==='api'||/^api(?:-|$)/.test(source)?'api'
        :project==='uat'||/^uat(?:-|$)/.test(source)||t.adapter==='webmpc-scenarios'||step?.adapter==='webmpc-scenarios'?'uat'
        :t.adapter==='k6'||step?.adapter==='k6'||source==='load'?'load'
        :project==='chromium'||source==='regression'?'web':'other'
      categories[category][t.status]++;total[t.status]++
    }
  }
  const scheduled=schedules.filter(s=>s.enabled&&s.env===env&&s.kind!=='summary').map(s=>{
    const slots=[]
    for(let at=Math.ceil(start/60_000)*60_000;at<cutoff;at+=60_000)if(cronMatches(s.cron,new Date(at),timezone))slots.push(at)
    const result={id:safeId(s.id),expected:slots.length,completed:0,missed:0,pending:0,missing:0}
    for(const at of slots) {
      const job=jobs.find(j=>j.scheduleId===s.id&&Date.parse(j.at)===at&&(!j.env||j.env===env))
      const run=job&&eligible.find(r=>r.runId===job.runId)
      if(!job)result.missing++
      else if(run)result.completed++
      else if(job.status==='finished') {
        const finishedAt=runs.find(r=>r.runId===job.runId)?.finishedAt??job.finishedAt
        if(finishedAt&&Date.parse(finishedAt)>=cutoff)result.pending++
        else result.completed++
      }
      else if(['missed','cancelled'].includes(job.status))result.missed++
      else result.pending++
    }
    return result
  })
  const latest=suite=>{
    const run=eligible.filter(r=>r.suite===suite).sort((a,b)=>Date.parse(b.finishedAt)-Date.parse(a.finishedAt))[0]
    return run?{runId:safeId(run.runId),status:safeStatus(run.status),finishedAt:new Date(run.finishedAt).toISOString(),ageHours:(cutoff-Date.parse(run.finishedAt))/3_600_000}:null
  }
  const executed=total.passed+total.failed,checks=executed+total.skipped+total.blocked
  const unresolved=new Map(),adapterFailures=new Map(),infrastructureFailures=new Map()
  const stepKey=s=>JSON.stringify([s.adapter,s.project??null,s.name?.replace(/^\d+-/,''),s.grep??null])
  for(const run of [...eligible].sort((a,b)=>Date.parse(a.finishedAt)-Date.parse(b.finishedAt))) {
    for(const step of run.steps??[]) {
      const tests=(run.tests??[]).filter(t=>t.step===step.name)
      if(step.exitCode!==0||!tests.some(t=>t.status==='passed')||!executionRecovered({status:'passed',steps:[step],tests}))continue
      for(const [key,identity] of adapterFailures)if(identity===stepKey(step)){unresolved.delete(key);adapterFailures.delete(key)}
    }
    const published=publicSummary(run),failedKeys=[]
    for(const [i,t] of (run.tests??[]).entries()) {
      if(!t.key)continue
      const step=(run.steps??[]).find(s=>s.name===t.step)
      const synthetic=step&&t.key.endsWith(':step')&&t.tags?.includes('@pipeline')
      const identity=synthetic?stepKey(step):null,key=synthetic?`${t.key}:${identity}`:t.key
      if(t.status==='failed') {
        failedKeys.push(key)
        unresolved.set(key,{name:published.checks[i].name,sourceRunId:safeId(run.runId),lastFailedAt:new Date(run.finishedAt).toISOString()})
        if(synthetic)adapterFailures.set(key,identity)
      }
      else if(t.status==='passed')unresolved.delete(key)
    }
    const key=`infrastructure:${run.suite}`
    if(['infra-failed','crashed','timeout','blocked'].includes(run.status)) {
      unresolved.set(key,{name:`Suite execution: ${safeId(run.suite)}`,sourceRunId:safeId(run.runId),lastFailedAt:new Date(run.finishedAt).toISOString()})
      infrastructureFailures.set(key,{suite:run.suite,failedKeys,steps:(run.steps??[]).map(stepKey),
        partial:['timeout','crashed','blocked'].includes(run.status)||!!run.errors?.length||(run.steps??[]).some(s=>s.timedOut||s.errors?.length)})
    }
    for(const [key,incident] of infrastructureFailures) {
      const allSteps=run.steps??[],suiteSteps=allSteps.filter(s=>s.fromSuite===incident.suite)
      const wholeSuite=run.suite===incident.suite||suiteSteps.length>0
      const covered=incident.steps.length?incident.steps.every(identity=>allSteps.some(step=>{
        const tests=(run.tests??[]).filter(t=>t.step===step.name)
        return stepKey(step)===identity&&step.exitCode!=null&&tests.some(t=>['passed','failed'].includes(t.status))&&executionRecovered({status:'failed',steps:[step],tests})
      })):wholeSuite&&allSteps.length>0&&allSteps.every(s=>!s.grep)
      const complete=executionRecovered(run)&&covered&&(!incident.partial||wholeSuite)
      const recoveredChecks=complete&&incident.failedKeys.length&&incident.failedKeys.every(k=>!unresolved.has(k))
      const recoveredSuite=complete&&!incident.failedKeys.length
      if(recoveredChecks||recoveredSuite){unresolved.delete(key);infrastructureFailures.delete(key)}
    }
  }
  const unresolvedFailures=[...unresolved.values()]
  const attention=unresolvedFailures.length||executionFailures||total.failed||total.skipped||total.blocked||scheduled.some(s=>s.missed||s.pending||s.missing)
  return {start:new Date(start).toISOString(),end:new Date(cutoff).toISOString(),env:safeId(env),
    runs:{total:window.length,ids:window.map(r=>safeId(r.runId))},categories,counts:total,executionFailures,failureEvents,schedules:scheduled,unresolvedFailures,
    passRate:executed?total.passed/executed:null,executionRate:checks?executed/checks:null,
    latestNightly:latest('nightly-regression'),latestLoad:latest('load'),health:unresolvedFailures.length?'attention':window.length?(attention?'attention':'healthy'):'no-data'}
}
function link(id,base) {
  if(!base)return ` — ${dashboardRunUrl(id)} (local scheduler host)`
  try {
    const url=new URL(base)
    if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)return ''
    return ` — ${url.href.replace(/\/$/,'')}/${encodeURIComponent(id)}.md`
  }catch{return ''}
}
export function renderHealthSummary(report,{reportBase}={}) {
  const rate=value=>value===null?'n/a':`${(100*value).toFixed(1)}%`
  const latest=(name,run)=>`${name}: ${run?`${run.status} · ${kstTime(run.finishedAt)} · ${Math.round(run.ageHours)}h old${link(run.runId,reportBase)}`:'no recorded result'}`
  return [`MPC QA daily health — ${report.health} · ${report.env}`,
    `${kstTime(report.start)} ≤ completion < ${kstTime(report.end)} (24 hours)`,
    `${report.runs.total} actual runs · pass rate ${rate(report.passRate)} · execution coverage ${rate(report.executionRate)}`,
    ...Object.entries(report.categories).map(([name,c])=>`${name==='api'?'API':name==='uat'?'UAT':name}: ${c.passed} passed · ${c.failed} failed · ${c.skipped} skipped · ${c.blocked} blocked`),
    `Execution/infrastructure failures: ${report.executionFailures}`,
    `Unresolved failures: ${(report.unresolvedFailures??[]).length}`,
    ...(report.unresolvedFailures??[]).map(f=>`• ${f.name} · last failed ${kstTime(f.lastFailedAt)} · ${f.sourceRunId}${link(f.sourceRunId,reportBase)}`),
    ...report.schedules.map(s=>`${s.id}: ${s.expected} expected · ${s.completed} completed · ${s.missed} missed · ${s.pending} pending · ${s.missing} absent`),
    `Failure events: ${report.failureEvents.new} new · ${report.failureEvents.recurring} recurring · ${report.failureEvents.newVariants} new variants · ${report.failureEvents.recovered} recovered`,
    latest('Latest nightly',report.latestNightly),latest('Latest load',report.latestLoad),
    ...report.runs.ids.map(id=>`Run ${id}${link(id,reportBase)}`)].join('\n')
}
export async function generateHealthSummary(job,state,spec) {
  const dir=join(RUNS_DIR,'health');mkdirSync(dir,{recursive:true,mode:0o700})
  const path=join(dir,`${job.id}.json`)
  // Reuse the cutoff snapshot after a crash, so delayed notifications cannot rewrite history.
  const report=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):buildHealthSummary({end:job.at,env:job.env,
    schedules:spec.schedules,timezone:spec.timezone,runs:readIndex().map(r=>readRun(r.runId)).filter(Boolean),jobs:state.jobs})
  writeJsonAtomic(path,report)
  const text=renderHealthSummary(report,{reportBase:process.env.QA_REPORT_BASE_URL})
  const published=join(RUNS_DIR,'published');mkdirSync(published,{recursive:true,mode:0o700})
  writeFileSync(join(published,`${job.id}.md`),text,{mode:0o600})
  const delivery=await notifyHealthSummary(job.id,text)
  if(!delivery.queued)throw new Error('Daily health outbox is busy; retry on restart')
  return report
}
