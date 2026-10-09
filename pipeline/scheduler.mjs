#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { parseArgs } from 'node:util'
import { ROOT, RUNS_DIR, config } from './lib/env.mjs'
import { acquireLock, readLock } from './lib/lock.mjs'
import { createRunDir, readRun, saveRun, writeJsonAtomic } from './lib/run-store.mjs'
import { kstTime, opaqueId, publishSummary } from './lib/safe-output.mjs'
import { notifyBotRun, flushBotOutbox, checkBot } from './notify/slack-bot.mjs'

function cronField(text,value,min,max) {
  let matched=false
  for(const part of text.split(',')) {
    if(!/^(\*|\d+(?:-\d+)?)(?:\/\d+)?$/.test(part))throw new Error(`Invalid cron field: ${text}`)
    const [range,stepText]=part.split('/'),step=stepText===undefined?1:Number(stepText)
    const [start,end]=range==='*'?[min,max]:range.includes('-')?range.split('-').map(Number):[Number(range),stepText?max:Number(range)]
    if(step<1||start<min||end>max||start>end)throw new Error(`Invalid cron field: ${text}`)
    if(value>=start&&value<=end&&(value-start)%step===0)matched=true
  }
  return matched
}
export function cronMatches(cron,date,timezone='Asia/Seoul') {
  const fields=cron.trim().split(/\s+/)
  if(fields.length!==5)throw new Error('Invalid cron: expected five fields')
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:timezone,minute:'2-digit',hour:'2-digit',day:'2-digit',month:'2-digit',weekday:'short',hourCycle:'h23'}).formatToParts(date).map(p=>[p.type,p.value]))
  const values=[+parts.minute,+parts.hour,+parts.day,+parts.month,['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(parts.weekday)]
  const limits=[[0,59],[0,23],[1,31],[1,12],[0,6]]
  const matches=fields.map((f,i)=>cronField(f,values[i],...limits[i]))
  const dayMatch=fields[2]!=='*'&&fields[4]!=='*'?matches[2]||matches[4]:matches[2]&&matches[4]
  return matches[0]&&matches[1]&&matches[3]&&dayMatch
}
const minute=value=>Math.floor(new Date(value).getTime()/60_000)*60_000
export function enqueueDue(state,schedules,now=new Date(),timezone='Asia/Seoul') {
  const end=minute(now),start=state.cursor?minute(state.cursor)+60_000:end
  const known=new Set(state.jobs.map(j=>j.id))
  for(const schedule of schedules.filter(s=>s.enabled)) {
    if(!/^[\w-]{1,40}$/.test(schedule.id))throw new Error('Invalid schedule ID')
    cronMatches(schedule.cron,now,timezone)
    const grace=(schedule.graceMinutes??60)*60_000
    // Outages longer than a day are not replayed as a storm of obsolete runs.
    for(let at=Math.max(start,end-86_400_000);at<=end;at+=60_000) {
      if(!cronMatches(schedule.cron,new Date(at),timezone))continue
      const id=`${schedule.id}-${at}`
      if(known.has(id))continue
      state.jobs.push({id,scheduleId:schedule.id,suite:schedule.suite,env:schedule.env,at:new Date(at).toISOString(),
        runId:`sched-${schedule.id}-${at}`,status:end-at>grace?'missed':'queued',graceMinutes:schedule.graceMinutes??60})
      known.add(id)
    }
  }
  state.cursor=new Date(end).toISOString()
  return state
}
export function nextSlots(schedules,now=new Date(),timezone='Asia/Seoul') {
  return schedules.filter(s=>s.enabled).map(s=>{
    cronMatches(s.cron,now,timezone)
    for(let at=minute(now)+60_000;at<minute(now)+8*86_400_000;at+=60_000) {
      if(cronMatches(s.cron,new Date(at),timezone))return {id:s.id,suite:s.suite,env:s.env,at:new Date(at).toISOString(),local:kstTime(at)}
    }
    throw new Error(`No upcoming slot within eight days for ${s.id}`)
  })
}
const statePath=join(RUNS_DIR,'scheduler-state.json')
function loadState() {return existsSync(statePath)?JSON.parse(readFileSync(statePath,'utf8')):{jobs:[]}}
function persist(state){writeJsonAtomic(statePath,state)}
function alive(pid){if(!Number.isInteger(pid)||pid<=0)return false;try{process.kill(pid,0);return true}catch{return false}}

export async function completeJob(state,job,code,{readRunImpl=readRun,saveRunImpl=saveRun,createDirImpl=createRunDir,notify=notifyBotRun,persistImpl=persist,publishImpl=publishSummary}={}) {
  let run=readRunImpl(job.runId)
  if(code===3&&!run){job.status='queued';job.pid=null;persistImpl(state);return}
  if(!run||run.status==='running') {
    run??={runId:job.runId,suite:job.suite,env:job.env,trigger:'scheduled',scheduleId:job.scheduleId,startedAt:job.at,
      counts:{passed:0,failed:0,skipped:0,blocked:1,total:1},tests:[],groups:[],versions:{app:{id:'unspecified'}},errors:[]}
    run.status='crashed';run.finishedAt=new Date().toISOString();run.errors=[...(run.errors??[]),'Scheduler detected an interrupted test worker.']
    createDirImpl(job.runId);saveRunImpl(run)
  }
  // A durable intermediate state closes the crash window between run completion and outbox creation.
  job.status='notifying';job.exitCode=code;job.pid=null;persistImpl(state)
  publishImpl(run)
  const delivery=await notify(run)
  if(!delivery.queued)return
  job.status='finished';job.finishedAt=new Date().toISOString();persistImpl(state)
}

export async function runScheduler({once=false,runNow=null}={}) {
  mkdirSync(RUNS_DIR,{recursive:true,mode:0o700})
  const lock=acquireLock(`scheduler-${process.pid}`,'scheduler'),state=loadState(),spec=config.schedules()
  if(spec.timezone!=='Asia/Seoul')throw new Error('Scheduler timezone must be Asia/Seoul (KST).')
  if(runNow) {
    if(!config.suites()[runNow])throw new Error('Unknown immediate suite')
    const id=`manual-${Date.now()}-${opaqueId(runNow).slice(0,4)}`
    state.jobs.push({id,scheduleId:'run-now',suite:runNow,env:process.env.QA_DEFAULT_ENV||'local-docker',at:new Date().toISOString(),runId:id,status:'queued',graceMinutes:120})
  }
  const finish=async(job,code)=>{
    await completeJob(state,job,code)
    console.log(`${kstTime(Date.now())} ${job.suite}: ${readRun(job.runId)?.status??job.status}; ${job.runId}`)
  }
  let stopped=false
  const stop=()=>{stopped=true}
  process.once('SIGINT',stop);process.once('SIGTERM',stop)
  try {
    console.log(`MPC QA scheduler started (pid ${process.pid}); timezone Asia/Seoul; Slack ${process.env.SLACK_BOT_TOKEN?.startsWith('xoxb-')?'configured':'pending xoxb bot token'}.`)
    while(!stopped) {
      enqueueDue(state,spec.schedules,new Date(),spec.timezone)
      state.pid=process.pid;state.heartbeatAt=new Date().toISOString();persist(state)
      await flushBotOutbox()
      for(const job of state.jobs.filter(j=>j.status==='notifying'))await finish(job,job.exitCode)
      for(const job of state.jobs.filter(j=>j.status==='running'))if(!alive(job.pid))await finish(job,null)
      const pipelineLock=readLock()
      if(!state.jobs.some(j=>j.status==='running')&&pipelineLock&&!pipelineLock.stale) {
        // An interactive pipeline run owns the shared account. Keep queued work for the next tick.
      }else if(!state.jobs.some(j=>j.status==='running')) {
        const now=Date.now()
        for(const job of state.jobs.filter(j=>j.status==='queued'))if(now-Date.parse(job.at)>job.graceMinutes*60_000){job.status='missed';persist(state)}
        const job=state.jobs.find(j=>j.status==='queued')
        if(job) {
          const prior=readRun(job.runId)
          if(prior)await finish(job,null)
          else {
            job.status='running';job.pid=null;persist(state)
            console.log(`${kstTime(now)} starting ${job.suite}; ${job.runId}`)
            const log=openSync(join(RUNS_DIR,`${job.runId}.log`),'a',0o600)
            const child=spawn(process.execPath,[join(ROOT,'pipeline/orchestrator.mjs'),'--suite',job.suite,'--env',job.env,'--trigger','scheduled','--schedule-id',job.scheduleId,'--run-id',job.runId,'--no-notify','--quiet'],{cwd:ROOT,stdio:['ignore',log,log]})
            closeSync(log);job.pid=child.pid;persist(state)
            const code=await new Promise(resolvePromise=>{child.once('error',()=>resolvePromise(2));child.once('exit',resolvePromise)})
            await finish(job,code)
          }
        }
      }
      if(once)break
      await new Promise(r=>setTimeout(r,15_000))
    }
  }finally {lock.release();process.off('SIGINT',stop);process.off('SIGTERM',stop)}
  return state
}
async function main() {
  const {values}=parseArgs({options:{once:{type:'boolean'},'run-now':{type:'string'},'dry-run':{type:'boolean'},'check-slack':{type:'boolean'},status:{type:'boolean'},start:{type:'boolean'},stop:{type:'boolean'}}})
  if(values.stop){const lock=readLock('scheduler');if(!lock||lock.stale){console.log('Scheduler is not running.');return}process.kill(lock.pid,'SIGTERM');console.log(`Stopped scheduler pid ${lock.pid}.`);return}
  if(values['check-slack']){const result=await checkBot();console.log(JSON.stringify(result,null,2));if(!result.ok)process.exitCode=1;return}
  if(values['dry-run']){console.log(JSON.stringify(nextSlots(config.schedules().schedules,new Date(),config.schedules().timezone),null,2));return}
  if(values.status){const state=loadState();console.log(JSON.stringify({lock:readLock('scheduler'),heartbeat:state.heartbeatAt,jobs:state.jobs.slice(-10)},null,2));return}
  if(values.start) {
    const lock=readLock('scheduler');if(lock&&!lock.stale)throw new Error(`Scheduler is already running (pid ${lock.pid}).`)
    mkdirSync(RUNS_DIR,{recursive:true,mode:0o700})
    const out=openSync(join(RUNS_DIR,'scheduler.log'),'a',0o600)
    const child=spawn(process.execPath,[fileURLToPath(import.meta.url),...(values['run-now']?['--run-now',values['run-now']]:[])],{cwd:ROOT,detached:true,stdio:['ignore',out,out]})
    child.unref();closeSync(out);console.log(`Started scheduler pid ${child.pid}; log runs/scheduler.log`);return
  }
  await runScheduler({once:values.once,runNow:values['run-now']})
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e.message);process.exitCode=1})
