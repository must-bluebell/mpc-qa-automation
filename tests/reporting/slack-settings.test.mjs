import test from 'node:test'
import assert from 'node:assert/strict'
import { slackStatus } from '../../dashboard/slack-settings.mjs'
import { sendBotTest } from '../../pipeline/notify/slack-bot.mjs'

test('bot configuration is recognized without a webhook and exposes no credentials',()=>{
  const s=slackStatus({SLACK_BOT_TOKEN:'xoxb-private',SLACK_CHANNEL_ID:'C123'})
  assert.deepEqual(s,{configured:true,valid:true,mode:'bot',reason:null})
  assert.ok(!JSON.stringify(s).includes('private'))
})
test('partial bot configuration takes precedence over a webhook and shows a useful reason',()=>{
  const s=slackStatus({SLACK_BOT_TOKEN:'xapp-wrong',SLACK_CHANNEL_ID:'C123',SLACK_ALERT_WEBHOOK_URL:'https://hooks.slack.com/services/a/b/c'})
  assert.equal(s.mode,'bot');assert.equal(s.valid,false);assert.match(s.reason,/bot token/)
  assert.equal(slackStatus({SLACK_BOT_TOKEN:'xoxb-private'}).valid,false)
})
test('webhook-only configuration and absent configuration remain supported',()=>{
  assert.equal(slackStatus({SLACK_ALERT_WEBHOOK_URL:'https://hooks.slack.com/services/a/b/c'}).valid,true)
  assert.equal(slackStatus({}).configured,false)
})
test('dashboard bot test uses the configured channel and returns a narrow result',async()=>{
  const r=await sendBotTest({token:'xoxb-test',channel:'C123',fetchImpl:async(url,opts)=>{
    assert.equal(url,'https://slack.com/api/chat.postMessage')
    assert.equal(JSON.parse(opts.body).channel,'C123')
    assert.match(JSON.parse(opts.body).text,/\[TEST\]/)
    return {ok:true,json:async()=>({ok:true,ts:'1.2'})}
  }})
  assert.deepEqual(r,{ok:true,code:'ok',attempts:1})
})
test('missing bot credentials do not send, and Slack errors are reported',async()=>{
  let called=false
  assert.equal((await sendBotTest({token:'xapp-test',channel:'C123',fetchImpl:()=>{called=true}})).ok,false)
  assert.equal(called,false)
  const r=await sendBotTest({token:'xoxb-test',channel:'C123',fetchImpl:async()=>({ok:true,json:async()=>({ok:false,error:'not_in_channel'})})})
  assert.equal(r.code,'not_in_channel')
})
