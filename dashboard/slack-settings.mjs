import { isSlackWebhookUrl } from '../pipeline/notify/slack.mjs'

/** Match notifyRun's bot-first routing. Return only public configuration flags. */
export function slackStatus(env=process.env) {
  if(env.SLACK_BOT_TOKEN||env.SLACK_CHANNEL_ID) {
    const reason=!env.SLACK_BOT_TOKEN?.startsWith('xoxb-')?'missing or invalid bot token'
      :!/^C[A-Z0-9]+$/.test(env.SLACK_CHANNEL_ID??'')?'missing or invalid channel ID':null
    return {configured:true,valid:!reason,mode:'bot',reason}
  }
  const configured=!!env.SLACK_ALERT_WEBHOOK_URL
  const valid=configured&&isSlackWebhookUrl(env.SLACK_ALERT_WEBHOOK_URL,{allowLoopback:env.QA_SLACK_ALLOW_LOOPBACK==='1'})
  return {configured,valid,mode:configured?'webhook':'none',reason:configured&&!valid?'invalid webhook URL':null}
}
