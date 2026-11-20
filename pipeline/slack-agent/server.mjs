#!/usr/bin/env node
import { App } from '@slack/bolt'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { acquireLock, readLock } from '../lib/lock.mjs'
import { agentSettings, validateSettings } from './policy.mjs'
import { createAgent } from './agent.mjs'

export function checkConfiguration(env=process.env) {
  const settings=agentSettings(env)
  validateSettings(settings)
  if(!env.SLACK_APP_TOKEN?.startsWith('xapp-'))throw new Error('Configure SLACK_APP_TOKEN with connections:write.')
  if(!env.SLACK_BOT_TOKEN?.startsWith('xoxb-'))throw new Error('Configure SLACK_BOT_TOKEN for the existing QA app.')
  return settings
}
// SDK diagnostics may contain payloads or tokens. Emit fixed operational messages only.
const logger={debug(){},info(){},warn(){console.error('Slack agent transport warning.')},error(){console.error('Slack agent transport error.')},
  setLevel(){},getLevel(){return 'error'},setName(){}}
export async function startAgent({AppClass=App,env=process.env,lockDirectory,agent,pollMs=15000}={}) {
  const settings=checkConfiguration(env)
  const lock=acquireLock(`slack-agent-${process.pid}`,'slack-agent',lockDirectory?{directory:lockDirectory}:{})
  let app,timer,stopped=false,polling=false
  const stop=async()=>{
    if(stopped)return
    stopped=true;clearInterval(timer)
    try {await app?.stop()}finally{lock.release()}
  }
  try {
    app=new AppClass({token:env.SLACK_BOT_TOKEN,appToken:env.SLACK_APP_TOKEN,socketMode:true,logger,
      // Retrying network/5xx errors after Slack accepted a message could duplicate it.
      clientOptions:{retryConfig:{retries:0},rejectRateLimitedCalls:true,timeout:10000}})
    const auth=await app.client.auth.test()
    if(auth.team_id!==settings.team) throw new Error('Slack token workspace does not match QA_SLACK_TEAM_ID.')
    const controller=agent||createAgent({settings:()=>agentSettings(env),post:payload=>app.client.chat.postMessage(payload)})
    const guarded=async work=>{try{await work()}catch{console.error('Slack agent request failed; check private inbox state.')}}
    app.event('app_mention',({body})=>guarded(()=>controller.mention(body)))
    app.event('message',({body})=>guarded(()=>controller.mention(body)))
    for(const action of ['qa_rerun_confirm','qa_rerun_cancel']) app.action(action,async({body,ack})=>{
      await ack()
      await guarded(()=>controller.action(body))
    })
    app.error(async()=>{console.error('Slack agent event delivery failed.')})
    await app.start()
    const poll=async()=>{
      if(polling||stopped)return
      polling=true
      try{await guarded(()=>controller.poll())}finally{polling=false}
    }
    timer=setInterval(poll,pollMs);timer.unref()
    await poll()
    return {app,stop}
  }catch(error){await stop();throw error}
}
async function main() {
  const args=process.argv.slice(2)
  if(args.includes('--check-config')) {checkConfiguration();console.log('Slack agent configuration is present; workspace installation and scopes still require a live connection.');return}
  if(args.includes('--status')) {
    const lock=readLock('slack-agent')
    console.log(JSON.stringify({enabled:agentSettings().enabled,running:!!lock&&!lock.stale,pid:lock&&!lock.stale?lock.pid:null},null,2));return
  }
  const service=await startAgent()
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{service.stop().catch(()=>{process.exitCode=1})})
  console.log('MPC QA conversational listener connected; Socket Mode enabled.')
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{
  if(process.argv.includes('--check-config')) { console.error(error.message); process.exitCode=1; return }
  console.error('Slack agent could not start. Check --check-config, credentials, workspace, app scopes and listener lock.');process.exitCode=1
})
