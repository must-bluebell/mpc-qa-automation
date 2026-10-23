import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startAgent, checkConfiguration } from '../../pipeline/slack-agent/server.mjs'
import { readLock } from '../../pipeline/lib/lock.mjs'

const env={QA_SLACK_AGENT_ENABLED:'1',QA_SLACK_TEAM_ID:'T123',SLACK_CHANNEL_ID:'C123',QA_SLACK_ALLOWED_USER_IDS:'U123',SLACK_APP_TOKEN:'xapp-fake',SLACK_BOT_TOKEN:'xoxb-fake'}
test('missing app credentials fail before connecting and expose only configuration names',()=>{
  assert.throws(()=>checkConfiguration({...env,SLACK_APP_TOKEN:''}),/SLACK_APP_TOKEN/)
  assert.throws(()=>checkConfiguration({...env,QA_SLACK_TEAM_ID:''}),/QA_SLACK_TEAM_ID/)
})
test('Socket Mode acknowledges actions before work, holds one listener lock and shuts down cleanly',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'qa-socket-'));t.after(()=>rmSync(directory,{recursive:true,force:true}))
  const handlers={},calls=[];let options
  class FakeApp {
    constructor(o){options=o;this.client={chat:{postMessage:async()=>({ts:'1.1'})},auth:{test:async()=>({team_id:'T123',user_id:'UAPP'})}}}
    event(name,fn){handlers[name]=fn}
    action(name,fn){handlers[name]=fn}
    error(fn){handlers.error=fn}
    async start(){calls.push('start')}
    async stop(){calls.push('stop')}
  }
  const agent={mention:async()=>calls.push('mention'),action:async()=>calls.push('action'),poll:async()=>calls.push('poll')}
  const service=await startAgent({AppClass:FakeApp,env,lockDirectory:directory,agent,pollMs:60000})
  t.after(()=>service.stop())
  assert.equal(options.socketMode,true)
  assert.equal(options.appToken,'xapp-fake')
  assert.equal(options.clientOptions.rejectRateLimitedCalls,true)
  assert.equal(options.clientOptions.retryConfig.retries,0)
  await handlers.qa_rerun_confirm({body:{},ack:async()=>calls.push('ack')})
  assert.ok(calls.indexOf('ack')<calls.indexOf('action'))
  await assert.rejects(startAgent({AppClass:FakeApp,env,lockDirectory:directory,agent}),/in progress/)
  await service.stop()
  assert.equal(readLock('slack-agent',{directory}),null)
  assert.equal(calls.filter(c=>c==='stop').length,1)
})
