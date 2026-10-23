import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { acquireLock } from '../lib/lock.mjs'
import { RUNS_DIR } from '../lib/env.mjs'
import { authorize, validateTarget, agentSettings } from './policy.mjs'

const digest = value => createHash('sha256').update(value).digest('hex').slice(0,32)
const iso = now => new Date(now).toISOString()
const same = (a,b) => ['team','channel','user','thread'].every(k => a[k] === b[k])
const dated = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
function validRecord(r,id) {
  if(!r||r.id!==id)return false
  if(r.type==='event')return ['handling','handled'].includes(r.status)&&dated(r.at)
  if(r.type==='reply')return (!r.identity||(r.identity.channel===r.payload?.channel&&r.identity.thread===r.payload?.thread_ts))
    &&['sending','sent','pending','uncertain'].includes(r.status)&&typeof r.key==='string'
    &&r.payload&&typeof r.payload.text==='string'&&dated(r.updatedAt)
  if(r.type!=='rerun'||!['pending','queued','scheduled','completed','cancelled','expired','rejected'].includes(r.status))return false
  if(!/^T[A-Z0-9]+$/.test(r.team)||!/^\w+$/.test(r.channel)||!/^\w+$/.test(r.user)||!/^\d+\.\d+$/.test(r.thread)
    ||!/^[-\w]{1,50}$/.test(r.suite)||!/^[-\w]{1,50}$/.test(r.env)||!dated(r.createdAt)||!dated(r.expiresAt)
    ||Date.parse(r.expiresAt)!==Date.parse(r.createdAt)+300000||!Array.isArray(r.audit)
    ||r.audit.some(a=>!a||typeof a.action!=='string'||!dated(a.at)))return false
  if(['queued','scheduled','completed'].includes(r.status)&&(!dated(r.confirmedAt)
    ||Date.parse(r.confirmedAt)<Date.parse(r.createdAt)||Date.parse(r.confirmedAt)>=Date.parse(r.expiresAt)))return false
  if(['scheduled','completed'].includes(r.status)&&r.runId!==`slack-${id}`)return false
  return true
}
export class AgentStore {
  constructor(directory = join(RUNS_DIR,'slack-agent')) { this.directory = directory; mkdirSync(directory,{recursive:true,mode:0o700}) }
  locked(work) {
    const lock = acquireLock(`agent-state-${process.pid}`,'state',{directory:this.directory})
    try { return work() } finally { lock.release() }
  }
  get(id) {
    if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('Invalid request identity.')
    try {
      const record=JSON.parse(readFileSync(join(this.directory,`${id}.json`),'utf8'))
      if(!validRecord(record,id))throw new Error('Invalid saved record')
      return record
    }
    catch(error) { if(error.code === 'ENOENT') return null; throw new Error('Slack agent record is unreadable; operator repair is required.') }
  }
  write(record) {
    if (!/^[a-f0-9]{32}$/.test(record.id)) throw new Error('Invalid request identity.')
    const temp=join(this.directory,`${record.id}.${randomUUID()}.tmp`)
    writeFileSync(temp,JSON.stringify(record,null,2),{mode:0o600})
    renameSync(temp,join(this.directory,`${record.id}.json`))
    return record
  }
  list() { return readdirSync(this.directory).filter(f=>/^[a-f0-9]{32}\.json$/.test(f)).map(f=>this.get(f.slice(0,-5))) }
  expirePending(now) {
    for(const r of this.list().filter(r=>r.type==='rerun'&&r.status==='pending'&&now>=Date.parse(r.expiresAt)))
      this.write({...r,status:'expired',audit:[...r.audit,{action:'expired',at:iso(now)}]})
  }
  propose(eventId, identity, suite, env, settings, now=Date.now()) {
    if(!authorize(identity,settings,true)) throw new Error('You are not authorized to request reruns.')
    validateTarget(suite,env,settings)
    if(!/^\d+\.\d+$/.test(identity.thread)||typeof eventId!=='string'||!eventId||eventId.length>200) throw new Error('Invalid Slack event.')
    return this.locked(()=>{
      this.expirePending(now)
      const id=digest(`request:${identity.team}:${eventId}`), prior=this.get(id)
      if(prior) { if(!same(prior,identity)||prior.suite!==suite||prior.env!==env) throw new Error('Request does not match.'); return prior }
      if(this.list().filter(r=>r.type==='rerun'&&r.user===identity.user&&['pending','queued','scheduled'].includes(r.status)).length>=3)
        throw new Error('Three rerun requests are already outstanding; wait for completion or cancel a pending request.')
      return this.write({id,type:'rerun',...identity,suite,env,status:'pending',createdAt:iso(now),expiresAt:iso(now+300000),audit:[{action:'requested',user:identity.user,at:iso(now)}]})
    })
  }
  decide(id,identity,action,settings,now=Date.now()) {
    if(!authorize(identity,settings,true)) throw new Error('You are not authorized to confirm reruns.')
    return this.locked(()=>{
      const r=this.get(id)
      if(!r||r.type!=='rerun'||!same(r,identity)) throw new Error('Confirmation does not match the request.')
      validateTarget(r.suite,r.env,settings)
      if(action==='confirm'&&['queued','scheduled','completed'].includes(r.status)) return r
      if(action==='cancel'&&r.status==='cancelled') return r
      if(r.status!=='pending') throw new Error(`Request is already ${r.status}.`)
      if(now>=Date.parse(r.expiresAt)) { this.write({...r,status:'expired'}); throw new Error('Confirmation expired; request a new rerun.') }
      if(!['confirm','cancel'].includes(action)) throw new Error('Unknown confirmation action.')
      r.status=action==='confirm'?'queued':'cancelled'
      if(action==='confirm') r.confirmedAt=iso(now)
      r.audit.push({action,user:identity.user,at:iso(now)})
      return this.write(r)
    })
  }
  // Persist the claim before network I/O. A crash/timeout is ambiguous and is never blindly resent.
  async deliver(key,payload,post,now=Date.now(),identity) {
    const id=digest(`reply:${key}`)
    const claimed=this.locked(()=>{
      const prior=this.get(id)
      if(prior&&(!['pending'].includes(prior.status)||(prior.nextAttemptAt||0)>now)) return false
      this.write({id,type:'reply',key,payload:prior?.payload||payload,identity:prior?.identity||identity,status:'sending',updatedAt:iso(now)})
      return true
    })
    if(!claimed) return false
    let result
    try {
      const response=await post(this.get(id).payload)
      result={status:'sent',ts:response.ts||null}
    } catch(error) {
      // Only explicit rate-limit rejection is safe to retry automatically.
      const retry=error.code==='slack_webapi_rate_limited_error'
      result={status:retry?'pending':'uncertain',nextAttemptAt:retry?now+Math.max(1,Number(error.retryAfter)||60)*1000:null}
    }
    this.locked(()=>this.write({...this.get(id),...result,updatedAt:iso(now)}))
    return result.status==='sent'
  }
}

export function consumeRequests(state,{store=new AgentStore(),settings=agentSettings(),now=Date.now(),persist}={}) {
  return store.locked(()=>{
    store.expirePending(now)
    for(const r of store.list().filter(r=>r.type==='rerun'&&r.status==='queued')) {
      const id=`slack-${r.id}`,prior=state.jobs.find(j=>j.id===id)
      if(prior) {
        persist(state)
        store.write({...r,status:'scheduled',runId:prior.runId})
        continue
      }
      try {
        if(!authorize(r,settings,true)) throw new Error('Authorization revoked.')
        validateTarget(r.suite,r.env,settings)
        if(!r.confirmedAt||!Number.isFinite(Date.parse(r.confirmedAt))||now-Date.parse(r.confirmedAt)>=3600000) {
          store.write({...r,status:'expired'}); continue
        }
      } catch {store.write({...r,status:'rejected'});continue}
      state.jobs.push({id,runId:id,scheduleId:'slack-agent',suite:r.suite,env:r.env,at:iso(now),ai:true,kind:'test',priority:25,
        graceMinutes:60,status:'queued',slackRequestId:r.id,requestedBy:r.user,slackPrivate:r.channel.startsWith('D')})
      persist(state)
      store.write({...r,status:'scheduled',runId:id,audit:[...r.audit,{action:'scheduled',at:iso(now)}]})
    }
    // Revalidate even after inbox handoff: a queued job must not outlive revoked permission.
    for(const job of state.jobs.filter(j=>j.scheduleId==='slack-agent'&&j.status==='queued')) {
      const r=store.get(job.slackRequestId)
      try {
        if(!r||r.status!=='scheduled'||r.runId!==job.runId||r.suite!==job.suite||r.env!==job.env||!authorize(r,settings,true)
          ||(r.channel.startsWith('D')&&job.slackPrivate!==true))
          throw new Error('Request authorization changed.')
        validateTarget(job.suite,job.env,settings)
      } catch {
        job.status='cancelled';job.reason='Slack rerun authorization or configuration changed before execution.'
        persist(state)
        if(r)store.write({...r,status:'rejected',audit:[...r.audit,{action:'rejected',at:iso(now)}]})
      }
    }
    return state
  })
}
