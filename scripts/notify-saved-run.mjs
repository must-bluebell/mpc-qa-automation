import { pathToFileURL } from 'node:url'
import { readRun, saveRun } from '../pipeline/lib/run-store.mjs'
import { notifyRun } from '../pipeline/notify/slack.mjs'
import { redactValue } from '../pipeline/lib/safe-output.mjs'

export async function notifySavedRun(run, { notify = notifyRun, save = saveRun } = {}) {
  if (!run || !run.finishedAt || run.status === 'running') throw new Error('A completed QA run is required for delivery')
  try {
    const delivery = await notify(run)
    run.notifications = delivery.results
    run.outboxRetries = delivery.outbox
  } catch (error) {
    run.notifications = [{kind:'delivery',ok:false,code:'notification_error',reason:String(error.message).slice(0,400)}]
  }
  save(redactValue(run))
  return run.notifications.every(result => result.ok)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const ok = await notifySavedRun(readRun(process.argv[2]))
    console.log(ok ? 'Slack delivery completed.' : 'Slack delivery pending or failed; saved test outcomes are unchanged.')
    if (!ok) process.exitCode = 1
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
