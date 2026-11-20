import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { RUNS_DIR } from '../lib/env.mjs'
import { readRun, readIndex } from '../lib/run-store.mjs'
import { agentSettings, authorize, conversationAllowed } from './policy.mjs'
import { AgentStore } from './store.mjs'
import { answerQuestion, parseRequest, plain, reportLink } from './answers.mjs'

const hash=value=>createHash('sha256').update(value).digest('hex').slice(0,32)
const timestamp=value=>/^\d+\.\d+$/.test(value||'')
const HANDLING_STALE_MS=10*60000
function schedulerState() {
  try{return JSON.parse(readFileSync(join(RUNS_DIR,'scheduler-state.json'),'utf8'))}catch{return {jobs:[]}}
}
export function createAgent({store=new AgentStore(),settings=agentSettings,post,now=Date.now,answer=answerQuestion,read=readRun,index=readIndex,jobs=schedulerState}={}) {
  let explaining=false
  const reply=(key,identity,text,blocks)=>store.deliver(key,{
    channel:identity.channel,thread_ts:identity.thread,text,
    unfurl_links:false,unfurl_media:false,...(blocks?{blocks}:{}),
  },post,now(),identity)
  return {
    async mention(body) {
      const event=body.event||{},identity={team:body.team_id,channel:event.channel,user:event.user,thread:event.thread_ts||event.ts,
        bot:!!(event.bot_id||event.subtype)}
      const cfg=settings()
      const direct=event.type==='message'&&/^D[A-Z0-9]+$/.test(event.channel||'')&&(!event.channel_type||event.channel_type==='im')
      const mentioned=event.type==='app_mention'&&/^[CG][A-Z0-9]+$/.test(event.channel||'')
      if((!direct&&!mentioned)||!authorize(identity,cfg)||!timestamp(identity.thread)||!/^Ev[A-Za-z0-9]+$/.test(body.event_id||'')) return
      const eventKey=`${identity.team}:${body.event_id}`,id=hash(`event:${eventKey}`)
      const claimed=store.locked(()=>{
        const prior=store.get(id)
        // A crash after claiming but before replying leaves a handling record. Once it is stale, a redelivery may
        // answer again; the reply is deduplicated by its key, and requests are deduplicated by event id.
        if(prior&&(prior.status!=='handling'||now()-Date.parse(prior.at)<HANDLING_STALE_MS))return false
        store.write({id,type:'event',status:'handling',at:new Date(now()).toISOString()})
        return true
      })
      if(!claimed)return
      let text,blocks
      try {
        if(typeof event.text!=='string'||event.text.length>1200) throw new Error('Keep questions under 1,200 characters.')
        const request=parseRequest(event.text)
        if(request.kind==='rerun') {
          const r=store.propose(body.event_id,identity,request.suite,request.env,cfg,now())
          text=`Confirm rerun: ${r.suite} on ${r.env}. Requested by <@${r.user}>. Confirmation expires in five minutes. Runs share the scheduler worker; repository restrictions remain in force.`
          blocks=[{type:'section',text:{type:'mrkdwn',text}},{type:'actions',elements:[
            {type:'button',text:{type:'plain_text',text:'Confirm rerun'},style:'primary',action_id:'qa_rerun_confirm',value:r.id},
            {type:'button',text:{type:'plain_text',text:'Cancel'},action_id:'qa_rerun_cancel',value:r.id},
          ]}]
        } else if(request.kind==='explain'&&cfg.ai) {
          if(explaining)text='An AI explanation is already in progress. Ask for latest results, failures, or scheduler status while it finishes.'
          else {
            explaining=true
            try{text=await answer(event.text,{index,read,ai:true})}finally{explaining=false}
          }
        } else text=await answer(event.text,{index,read,ai:false})
      } catch(error) {
        const known=/not authorized|not allowed|isolated|characters|outstanding/.test(error.message||'')
        text=known?plain(error.message):'The QA request could not be processed. No unconfirmed rerun was started.'
      }
      await reply(`mention:${eventKey}`,identity,text,blocks)
      store.locked(()=>store.write({...store.get(id),status:'handled'}))
    },
    async action(body) {
      const identity={team:body.team?.id,channel:body.channel?.id,user:body.user?.id,thread:body.message?.thread_ts||body.message?.ts}
      if(!authorize(identity,settings())||!timestamp(identity.thread))return
      const action=body.actions?.[0]
      if(!action||!['qa_rerun_confirm','qa_rerun_cancel'].includes(action.action_id))return
      try {
        const decision=action.action_id==='qa_rerun_confirm'?'confirm':'cancel'
        const r=store.decide(action.value,identity,decision,settings(),now())
        await reply(`decision:${r.id}:${r.status}`,identity,r.status==='cancelled'?'Rerun cancelled.':`Rerun ${r.suite} on ${r.env} is ${r.status}. Request: ${r.id}. Completion will be posted in this thread.`)
      } catch {
        await reply(`denied:${hash(JSON.stringify([action.value,identity,action.action_id]))}`,identity,'Rerun was not accepted: authorization, confirmation identity, expiry, or request state did not match. Request a new rerun if needed.')
      }
    },
    async poll() {
      const cfg=settings()
      if(!cfg.enabled)return
      store.locked(()=>store.expirePending(now()))
      // Retry explicit 429 rejections only. Sending/uncertain records require manual reconciliation.
      for(const r of store.listActive().filter(r=>r.type==='reply'&&r.status==='pending'
        &&(r.identity?authorize(r.identity,cfg):r.payload?.channel===cfg.channel&&conversationAllowed(r.payload.channel,cfg))))
        await store.deliver(r.key,r.payload,post,now(),r.identity)
      const state=jobs()
      for(const r of store.listActive().filter(r=>r.type==='rerun'&&['scheduled','rejected','expired'].includes(r.status))) {
        if(!authorize(r,cfg))continue
        if(r.status!=='scheduled') {
          await reply(`end:${r.id}`,r,`Rerun request ${r.id} ${r.status}; no new test execution will start. Request a new rerun after checking permissions and configuration.`)
          store.locked(()=>store.write({...store.get(r.id),notifiedAt:new Date(now()).toISOString()}))
          continue
        }
        const run=read(r.runId),job=state.jobs.find(j=>j.runId===r.runId)
        if(!run?.finishedAt||run.status==='running') {
          if(!['missed','cancelled'].includes(job?.status))continue
          await reply(`end:${r.id}`,r,`Rerun ${r.runId} was ${job.status} before execution. No passing result is inferred.`)
        } else {
          const count=n=>Number.isFinite(n)&&n>=0?Math.floor(n):0,c=run.counts||{}
          await reply(`end:${r.id}`,r,`Rerun ${plain(r.runId)}: ${plain(run.status)}. Finished ${plain(run.finishedAt)}.\n${count(c.passed)} passed, ${count(c.failed)} failed, ${count(c.skipped)} skipped, ${count(c.blocked)} blocked.\n${reportLink(r.runId)}`)
        }
        store.locked(()=>store.write({...store.get(r.id),status:'completed',completedAt:new Date(now()).toISOString(),audit:[...r.audit,{action:'completed',at:new Date(now()).toISOString()}]}))
      }
    },
  }
}
