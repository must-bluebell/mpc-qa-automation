import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { RUNS_DIR, config } from '../lib/env.mjs'
import { publicSummary, opaqueId, groupChecks, tally, CHECK_ICONS, redactValue } from '../lib/safe-output.mjs'
import { formatRate } from '../lib/quality-rates.mjs'

function settings(options) {
  return { stateDir:RUNS_DIR, token:process.env.SLACK_BOT_TOKEN, channel:process.env.SLACK_CHANNEL_ID,
    owner:process.env.QA_OWNER_SLACK_ID, fetchImpl:fetch, now:Date.now(), reportBase:process.env.QA_REPORT_BASE_URL,
    allureBase:process.env.QA_ALLURE_BASE_URL, runUrl:process.env.QA_GITHUB_RUN_URL, ...options }
}
function load(o) {
  const path=join(o.stateDir,'slack-bot-state.json')
  if (!existsSync(path)) return {messages:[],runs:{},incidents:{}}
  return JSON.parse(readFileSync(path,'utf8')) // corrupt state must never silently reset deduplication
}
function save(o,state) {
  const path=join(o.stateDir,'slack-bot-state.json'), tmp=`${path}.${process.pid}.tmp`
  writeFileSync(tmp,JSON.stringify(state,null,2),{mode:0o600});renameSync(tmp,path)
}
async function locked(o,work) {
  mkdirSync(o.stateDir,{recursive:true,mode:0o700})
  const lock=join(o.stateDir,'.slack-bot.lock')
  try { writeFileSync(lock,String(process.pid),{flag:'wx',mode:0o600}) }
  catch(error) {
    if(error.code!=='EEXIST') throw error
    const pid=Number(readFileSync(lock,'utf8'))
    try { process.kill(pid,0);return {results:[{ok:false,code:'delivery_busy'}],outbox:[]} }
    catch(e) { if(e.code!=='ESRCH') return {results:[{ok:false,code:'delivery_busy'}],outbox:[]} }
    rmSync(lock);return locked(o,work)
  }
  try {return await work(load(o))} finally {rmSync(lock,{force:true})}
}
function clientId(id) {
  const h=createHash('sha256').update(id).digest('hex').slice(0,32)
  return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20)}`
}
function safeBase(value) {
  try {
    const url=new URL(value)
    return url.protocol!=='https:'||url.username||url.password||url.search||url.hash?null:url.href.replace(/\/$/,'')
  }catch{return null}
}
/** CI runs link to their GitHub Actions page (job summary + sanitized artifact); anything but an exact run URL is dropped. */
function githubRun(value) {
  try {
    const url=new URL(value)
    return url.protocol==='https:'&&url.hostname==='github.com'&&!url.port&&!url.username&&!url.password&&!url.search&&!url.hash
      &&/^\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+$/.test(url.pathname)?url.href:null
  }catch{return null}
}
function reportLink(o,s) {
  const id=encodeURIComponent(s.runId), base=o.reportBase&&safeBase(o.reportBase)
  const run=githubRun(o.runUrl)
  const lines=[!o.reportBase&&run?`Report: <${run}|GitHub run and sanitized report>`
    :!o.reportBase?'Report: retained locally; shared hosting is not configured.'
    :base?`Report: <${base}/${id}.md|Sanitized results>`:'Report: retained locally (invalid report base URL).']
  if(o.allureBase&&s.allureReport){
    const allure=safeBase(o.allureBase)
    lines.push(allure?`Allure: <${allure}/${id}/index.html|Allure report>`:'Allure: retained locally (invalid Allure base URL).')
  }
  return lines.join('\n')
}
const duration=ms=>ms>=60_000?`${Math.floor(ms/60_000)}m ${Math.round(ms%60_000/1000)}s`:`${Math.round(ms/1000)}s`
function triggerText(s) {
  const {trigger,scheduleId}=s.pipeline
  if(s.reportOnly)return '📄 Recorded results preview'
  if(trigger==='scheduled'&&scheduleId==='run-now')return '▶️ Manual run via scheduler'
  if(trigger==='scheduled'){
    const cron=config.schedules().schedules.find(x=>x.id===scheduleId)?.cron
    return `⏰ Scheduled · ${scheduleId||'schedule'}${cron?` (${cron}, ${config.schedules().timezone})`:''}`
  }
  return trigger==='manual'?'▶️ Manual run':trigger
}
function comparisonText(c) {
  if(!c.previousRunId&&!c.newFailures.length&&!c.recovered.length)return 'first recorded run for this suite; nothing to compare'
  return `${c.newFailures.length} new failure${c.newFailures.length===1?'':'s'} · ${c.persisting.length+c.newVariants.length} still failing · ${c.recovered.length} recovered${c.previousRunId?` (vs ${c.previousRunId})`:''}`
}
/** One line per pipeline stage, so every scheduled report shows how the result was produced. */
function renderPipeline(s,{actionable,recovered,owner}) {
  const p=s.pipeline,e=p.environment,ok=v=>v?'✅':'❌',c=s.counts
  const env=[`${e.name} (${e.isolated?'isolated stack':'shared target'})`,
    e.health?`health probe ${e.health.ok?'OK':'failed'}${e.health.httpStatus?` (HTTP ${e.health.httpStatus})`:''}`:'health probe not recorded',
    ...(e.stack?[`${e.stack.services-e.stack.unhealthy}/${e.stack.services} Docker services healthy`]:[]),
    ...(e.load?['load allowed']:[])].join(' · ')
  const td=e.testData,mark={ready:'✓',created:'✓ new',skipped:'–',failed:'✗'}
  const data=!td?'test data: not prepared (environment not ready)'
    :`test data: ${td.status}${td.steps.length?` — ${td.steps.map(x=>`${x.name} ${mark[x.status]??x.status}`).join(' · ')}`:''}`
  const envOk=e.health?.ok!==false&&e.stack?.healthy!==false&&td?.status!=='failed'
  const steps=p.steps.length?p.steps.map(x=>`      ${x.timedOut||x.errors?'⚠️':'•'} ${x.adapter}${x.target?`/${x.target}`:''} (${x.suite}) — ${x.tests} tests in ${duration(x.durationMs)}${x.timedOut?' · timed out':''}${x.errors?` · ${x.errors} step error(s)`:''}`).join('\n'):'      • no suite step ran (environment not ready)'
  const ev=p.evidence,stored=[`private run folder runs/${s.runId}/`,`${ev.logs} step log(s)`,...(ev.htmlReports?[`${ev.htmlReports} Playwright HTML report(s)`]:[]),...(ev.allure?['Allure report']:[]),...(ev.loadSummary?['k6 load summary']:[]),'sanitized summary']
  const cmp=p.comparison
  const lines=[`*Pipeline stages*${s.reportOnly?' _(recorded in the source run)_':''}`,
    `1️⃣ *Environment & test data* ${ok(envOk)}\n      ${env}\n      ${data}`,
    `2️⃣ *Suites run through adapters* ${ok(p.steps.length&&p.steps.every(x=>!x.timedOut&&!x.errors))}\n${steps}`,
    `3️⃣ *Explicit assertions* ${c.passed+c.failed+c.skipped+c.blocked?ok(!c.failed):'❌'}\n      ${c.passed+c.failed+c.skipped+c.blocked} checks asserted: ${c.passed} passed · ${c.failed} failed · ${c.skipped} skipped · ${c.blocked} blocked${p.coverage?`\n      critical requirements passing: ${p.coverage.criticalPassed}/${p.coverage.criticalTotal}`:''}`,
    `4️⃣ *Reports & evidence stored* ✅\n      ${stored.join(' · ')}`,
    `5️⃣ *Compared with previous runs* ${cmp?.newFailures.length?'⚠️':'✅'}\n      ${cmp?comparisonText(cmp):'comparison not recorded'}${cmp?.newFailures.length?`\n      New: ${cmp.newFailures.slice(0,10).join(', ')}`:''}${cmp?.persisting.length?`\n      Still failing: ${cmp.persisting.slice(0,10).join(', ')}`:''}${cmp?.recovered.length?`\n      Recovered: ${cmp.recovered.slice(0,10).join(', ')}`:''}`,
    `6️⃣ *Slack notifications* ✅\n      summary + test cases + diagnostics posted · failure alert: ${actionable?(/^U[A-Z0-9]+$/.test(owner??'')?'owner mentioned':'raised (no owner configured)'):'none (no new failures)'} · recovery update: ${recovered.length?`${recovered.length} recovered`:'none'}`]
  return lines.join('\n')
}
/** Why a run produced no trustworthy result, from allowlisted health data only. */
function infraProblem(s) {
  if(!['infra-failed','crashed','timeout','blocked'].includes(s.status))return null
  const e=s.pipeline.environment,parts=[]
  if(e.health&&!e.health.ok)parts.push(`app health probe failed${e.health.httpStatus?` (HTTP ${e.health.httpStatus})`:''}`)
  if(e.stack&&!e.stack.healthy)parts.push(`${e.stack.unhealthy} of ${e.stack.services} Docker services down or unhealthy`)
  if(e.testData?.status==='failed')parts.push('test data preparation failed')
  if(s.status==='timeout')parts.push('suite timed out')
  return parts.length?`${parts.join(' · ')}. Not a product defect.`:`run ${s.status}. Not a confirmed product defect.`
}
const badge=status=>status==='passed'?'🟢':status==='failed'?'🔴':'🟡'
const SUITE_LABELS={'combined-report':'Combined report',regression:'Web regression',api:'API',load:'Load',uat:'UAT',smoke:'Smoke',full:'Full suite'}
function renderSummary(s,groups,critical,o,{actionable,recovered,newFailures}) {
  const c=s.counts,total=c.passed+c.failed+c.skipped+c.blocked
  const rows=s.sections.length?s.sections.map(r=>({label:r.label,status:r.status,counts:r.counts}))
    :groups.map(([label,checks])=>({label,status:checks.some(t=>t.status==='failed')?'failed':checks.some(t=>t.status==='passed')?'passed':'blocked',
      counts:Object.fromEntries(['passed','failed','skipped','blocked'].map(k=>[k,checks.filter(t=>t.status===k).length]))}))
  const row=r=>{const n=r.counts.passed+r.counts.failed+r.counts.skipped+r.counts.blocked
    return `${badge(r.status)} *${r.label}* — ${r.counts.passed}/${n} passed${r.counts.failed?` · ${r.counts.failed} failed`:''}${r.counts.skipped?` · ${r.counts.skipped} skipped`:''}${r.counts.blocked?` · ${r.counts.blocked} blocked`:''}`}
  return [`${badge(s.status)} *MPC QA — ${SUITE_LABELS[s.suite]??s.suite} · ${s.status.toUpperCase()}*`,
    ...(s.reportOnly?['_Recorded results preview — previous execution, not a fresh run._']:[]),
    `Version: ${s.applicationVersion} · ${s.finishedAt}`,
    `Trigger: ${triggerText(s)} · Env: ${s.pipeline.environment.name}`,'',
    `*Overall:* ${c.passed} passed · ${c.failed} failed · ${c.skipped} skipped · ${c.blocked} blocked${total?` (${total} checks, ${formatRate(s.quality.passRate)} test pass rate; ${formatRate(s.quality.executionRate)} executed)`:''}`,'',
    ...(rows.length?[...rows.map(row),'']:[]),
    ...(s.pipeline.comparison?[`*Vs previous run:* ${comparisonText(s.pipeline.comparison)}`]:[]),
    ...(infraProblem(s)?[`⚠️ *Execution problem:* ${infraProblem(s)}`]:[]),
    ...(actionable?[`🚨 *Failure alert:* ${newFailures?`${newFailures} new failure${newFailures===1?'':'s'} need attention`:'the suite could not run; investigate the environment'}${/^U[A-Z0-9]+$/.test(o.owner??'')?` <@${o.owner}>`:''}.`]:[]),
    ...(recovered.length?[`✅ *Recovered:* ${recovered.slice(0,5).join(', ')}${recovered.length>5?` and ${recovered.length-5} more`:''}`]:[]),
    `*Critical:* ${critical.length?`confirmed defects mapped to ${critical.join(', ')}`:'No confirmed critical defects'}`,
    reportLink(o,s),
    ...(total?['🧵 Every test case and its result is in the thread.']:[])].join('\n')
}
/** Every check, grouped by category; a reason shared by all of a category's failures is printed once. Split to stay readable in Slack. */
function renderCases(groups) {
  const blocks=groups.map(([category,checks])=>{
    const failing=checks.filter(t=>t.status!=='passed'),reasons=new Set(failing.map(t=>t.reason))
    const shared=failing.length>1&&reasons.size===1&&!/^(SLO breached|Breached)/.test(failing[0].reason??'')?failing[0].reason:null
    const lines=checks.map(t=>{
      const note=t.status==='passed'?t.detail:shared?null:t.reason
      return `${CHECK_ICONS[t.status]??'•'} ${t.name}${t.critical?' *(critical)*':''}${note?`\n      ↳ ${note}`:''}`
    })
    return [`*${category}* — ${tally(checks)}`,...lines,...(shared?[`↳ _Reason (all ${failing.length} ${failing.every(t=>t.status==='failed')?'failed':'not passed'})_: ${shared}`]:[])].join('\n')
  })
  const messages=[]
  for(const block of blocks){
    const last=messages.at(-1)
    if(last&&last.length+block.length<3500)messages[messages.length-1]=`${last}\n\n${block}`
    else messages.push(block)
  }
  return messages.map((m,i)=>i?m:`*Test cases*\n\n${m}`)
}
function queueRun(state,run,o) {
  const runKey=`${o.channel}:${run.runId}`
  if(state.runs[runKey])return
  const s=publicSummary(run), scope=`${o.channel}:${opaqueId(`${run.env}:${run.suite}:${run.seededDefect??''}`)}`
  const incidents=state.incidents[scope]??={}
  const notes=[],failureGroups=new Map(),recovered=[];let actionable=false
  for(const [i,t] of (run.tests??[]).entries()) {
    const key=opaqueId(t.key),check=s.checks[i],previous=incidents[key]
    if(t.status==='failed') {
      const fp=opaqueId(t.fingerprint??t.key)
      const fresh=!previous||previous.fingerprint!==fp
      if(fresh){actionable=true;incidents[key]={fingerprint:fp,since:run.runId}}
      const groupKey=`${fresh?'new':'recurring'}:${opaqueId(t.signature??t.fingerprint??t.key)}`
      const group=failureGroups.get(groupKey)??{fresh,checks:[],requirements:new Set(),classification:check.classification,critical:false}
      group.checks.push(key);for(const id of check.requirementIds)group.requirements.add(id);group.critical||=check.critical
      failureGroups.set(groupKey,group)
    }else if(t.status==='passed'&&previous){recovered.push(check.name);notes.push(`Recovered: ${check.name}; failing since ${previous.since}.`);delete incidents[key]}
  }
  for(const group of failureGroups.values())notes.push(`${group.fresh?'New':'Recurring'} failure group: ${group.checks.length} check(s) [${[...group.requirements].join(', ')||'unmapped'}] — ${group.classification}${group.critical?' (critical)':''}. Evidence IDs: ${group.checks.slice(0,3).join(', ')}.`)
  if(['infra-failed','crashed','timeout','blocked'].includes(run.status)) {
    if(!incidents._infrastructure){actionable=true;incidents._infrastructure={since:run.runId}}
    notes.push(`Execution ${s.status}; investigate the runner/environment. This is not a confirmed product defect.`)
  }else if(run.status==='passed'&&incidents._infrastructure){notes.push('Recovered: suite execution is healthy again.');delete incidents._infrastructure}
  const c=s.counts
  const critical=[...new Set(s.checks.filter(t=>t.critical).flatMap(t=>t.requirementIds))]
  const groups=groupChecks(s.checks)
  const newFailures=s.checks.filter(t=>t.status==='failed').length&&actionable?(s.pipeline.comparison?.newFailures.length||failureGroups.size):0
  const summary=renderSummary(s,groups,critical,o,{actionable,recovered,newFailures})
  const load=s.loadMetrics
  const metrics=load?`\n\n*Load metrics*\n${load.totalRequests??'unavailable'} requests · ${load.throughputRps??'unavailable'} requests/s · functional check rate ${load.checkPassRate===null?'unavailable':`${(load.checkPassRate*100).toFixed(1)}%`}\n${load.endpoints.map(r=>`• ${r.name}: p95 ${r.p95Ms??'unavailable'}ms · error rate ${r.errorRate===null?'unavailable':`${(r.errorRate*100).toFixed(2)}%`}`).join('\n')}`:''
  const sources=s.sections.map(r=>`• ${r.label}: source ${r.sourceRunId} · ${r.finishedAt}`).join('\n')
  const details=`*Incidents & diagnostics*\n${notes.slice(0,35).join('\n')||'No new actionable failures or recoveries.'}${notes.length>35?'\nAdditional checks are in the sanitized report.':''}${metrics}${sources?`\n\n*Source runs*\n${sources}`:''}`
  const thread=[['pipeline',renderPipeline(s,{actionable,recovered,owner:o.owner})],...renderCases(groups).map((text,i)=>[`cases-${i+1}`,text]),['details',details]]
  const parentId=`${runKey}:summary`
  state.runs[runKey]={queuedAt:o.now}
  for(const [kind,text,parent] of [['summary',summary,null],...thread.map(([kind,text])=>[kind,text,parentId])]) {
    const id=`${runKey}:${kind}`
    state.messages.push({id,kind,runId:run.runId,channel:o.channel,text,parent,clientId:clientId(id),createdAt:o.now,status:'pending',attempts:0,nextAttemptAt:0})
  }
  save(o,state)
}
async function api(o,method,body) {
  const response=await o.fetchImpl(`https://slack.com/api/${method}`,{method:'POST',headers:{Authorization:`Bearer ${o.token}`,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15_000)})
  if(!response.ok)return {ok:false,error:`http_${response.status}`,retryAfter:Number(response.headers?.get?.('retry-after'))||60,ambiguous:response.status>=500}
  const data=await response.json()
  return {...data,ambiguous:['internal_error','fatal_error','service_unavailable'].includes(data.error)}
}
async function reconcile(o,item,parentTs) {
  let cursor
  for(let page=0;page<20;page++) {
    const method=parentTs?'conversations.replies':'conversations.history'
    const result=await api(o,method,{channel:item.channel,...(parentTs?{ts:parentTs}:{oldest:String((item.createdAt-300_000)/1000)}),limit:100,include_all_metadata:true,...(cursor?{cursor}:{})})
    if(!result.ok)return {found:false,complete:false,code:result.error}
    const found=(result.messages??[]).find(m=>m.client_msg_id===item.clientId||m.metadata?.event_payload?.delivery_id===item.clientId)
    if(found)return {found:true,ts:found.ts}
    cursor=result.response_metadata?.next_cursor
    if(!cursor&&!result.has_more)return {found:false,complete:true}
    if(!cursor)return {found:false,complete:false,code:'history_incomplete'}
  }
  return {found:false,complete:false,code:'history_incomplete'}
}
async function flush(state,o) {
  const results=[]
  const configError=!o.token?'not_configured':!o.token.startsWith('xoxb-')?'invalid_bot_token':!/^C[A-Z0-9]+$/.test(o.channel??'')?'invalid_channel':null
  if(configError)return {results:[{ok:false,code:configError}],outbox:[]}
  for(const item of state.messages.filter(m=>m.status!=='sent'&&m.status!=='permanent-failure'&&m.channel===o.channel)) {
    if(item.nextAttemptAt>o.now)continue
    const parent=item.parent&&state.messages.find(m=>m.id===item.parent)
    if(parent&&parent.status!=='sent')continue
    try {
      if(item.status==='sending'||item.status==='uncertain') {
        const lookup=await reconcile(o,item,parent?.ts)
        if(lookup.found){item.status='sent';item.ts=lookup.ts;save(o,state);results.push({kind:item.kind,ok:true,code:'reconciled'});continue}
        if(!lookup.complete){item.status='uncertain';item.nextAttemptAt=o.now+60_000;save(o,state);results.push({kind:item.kind,ok:false,code:`reconciliation_${lookup.code??'pending'}`});continue}
        // Wait for Slack history to settle before interpreting absence as a failed delivery.
        if(o.now-(item.lastAttemptAt??item.createdAt)<60_000){item.nextAttemptAt=o.now+60_000;save(o,state);continue}
      }
      item.status='sending';item.attempts++;item.lastAttemptAt=o.now;save(o,state)
      const response=await api(o,'chat.postMessage',{channel:item.channel,text:item.text,client_msg_id:item.clientId,
        metadata:{event_type:'mpc_qa_delivery',event_payload:{delivery_id:item.clientId}},unfurl_links:false,unfurl_media:false,...(parent?{thread_ts:parent.ts}:{})})
      if(response.ok&&response.ts){item.status='sent';item.ts=response.ts}
      else {
        const repairable=['http_429','ratelimited','invalid_auth','token_revoked','account_inactive','missing_scope','not_in_channel','channel_not_found','is_archived'].includes(response.error)
        item.status=response.ambiguous||response.ok?'uncertain':repairable?'pending':'permanent-failure'
        item.nextAttemptAt=o.now+(response.retryAfter??60)*1000
      }
      item.code=response.ok?'ok':response.error
      results.push({kind:item.kind,ok:item.status==='sent',code:item.code})
    }catch {item.status='uncertain';item.code='network_or_timeout';item.nextAttemptAt=o.now+60_000;results.push({kind:item.kind,ok:false,code:item.code})}
    save(o,state)
  }
  return {results,outbox:state.messages.filter(m=>m.status!=='sent').map(m=>({kind:m.kind,status:m.status,runId:m.runId}))}
}
export async function notifyBotRun(run,options={}) {
  const o=settings(options)
  return locked(o,async state=>{queueRun(state,run,o);return {...await flush(state,o),queued:true}})
}
/** Daily reports share durable delivery, without creating tests or changing incidents. */
export async function notifyHealthSummary(reportId,text,options={}) {
  if(!/^[\w-]{1,100}$/.test(reportId))throw new Error('Invalid health report ID')
  const o=settings(options)
  return locked(o,async state=>{
    const id=`${o.channel}:health:${reportId}`
    if(!state.messages.some(m=>m.id===id)) {
      state.messages.push({id,kind:'health',runId:reportId,channel:o.channel,text:redactValue(text),parent:null,
        clientId:clientId(id),createdAt:o.now,status:'pending',attempts:0,nextAttemptAt:0})
      save(o,state)
    }
    return {...await flush(state,o),queued:true}
  })
}
export async function flushBotOutbox(options={}) {
  const o=settings(options)
  return locked(o,state=>flush(state,o))
}
export async function checkBot(options={}) {
  const o=settings(options)
  if(!o.token?.startsWith('xoxb-'))return {ok:false,error:'missing_or_invalid_bot_token'}
  try {
    const result=await api(o,'auth.test',{})
    return {ok:result.ok===true,error:result.error,teamId:result.team_id,botUserId:result.user_id,channel:o.channel,owner:o.owner}
  }catch{return {ok:false,error:'network_or_timeout'}}
}

/** A single explicit dashboard test; never retries an uncertain send automatically. */
export async function sendBotTest(options={}) {
  const o=settings(options)
  if(!o.token?.startsWith('xoxb-'))return {ok:false,code:'missing_or_invalid_bot_token',attempts:0}
  if(!/^C[A-Z0-9]+$/.test(o.channel??''))return {ok:false,code:'missing_or_invalid_channel',attempts:0}
  try {
    const r=await api(o,'chat.postMessage',{channel:o.channel,text:'[TEST] MPC QA dashboard: Slack bot delivery works. No test run was started.'})
    return {ok:r.ok===true,code:r.ok?'ok':r.error||'slack_error',attempts:1}
  }catch{return {ok:false,code:'network_or_timeout',attempts:1}}
}
