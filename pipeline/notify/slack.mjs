import { readEvents, appendEvent } from '../lib/run-store.mjs'
import { RUNS_DIR } from '../lib/env.mjs'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { notifyBotRun } from './slack-bot.mjs'

/**
 * Slack delivery for the QA pipeline. Mirrors the WEB MPC alert contract
 * (src/platform/integrations/slack/server/alert.ts): a channel-neutral SystemAlert rendered to Block Kit,
 * strict webhook URL validation, and a narrow result code instead of throwing. Delivery failure never
 * fails a run: the message is kept in runs/slack-outbox.jsonl and retried before the next run's alerts.
 */
const SEVERITY_EMOJI = { info: ':large_green_circle:', warning: ':warning:', critical: ':rotating_light:' }

export function isSlackWebhookUrl(value, { allowLoopback = false } = {}) {
  let url
  try { url = new URL(value) } catch { return false }
  if (allowLoopback && url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)) return true
  return url.protocol === 'https:' && ['hooks.slack.com', 'hooks.slack-gov.com'].includes(url.hostname)
    && /^\/services\/[^/]+\/[^/]+\/[^/]+$/.test(url.pathname) && !url.search && !url.hash && !url.username && !url.password
}

const esc = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const clip = (text, n) => (text.length > n ? `${text.slice(0, n - 1)}…` : text)

export function renderSlackAlert(alert) {
  const prefix = alert.test ? '[TEST] ' : ''
  const title = clip(`${prefix}${alert.title}`, 150)
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `${alert.severity === 'critical' ? '🚨' : alert.severity === 'warning' ? '⚠️' : '✅'} ${title}`, emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text: clip(alert.summary, 2900) } },
  ]
  if (alert.facts?.length) {
    blocks.push({ type: 'section', fields: alert.facts.slice(0, 10).map(f => ({ type: 'mrkdwn', text: clip(`*${esc(f.label)}*\n${esc(f.value)}`, 1900) })) })
  }
  for (const extra of alert.sections ?? []) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: clip(extra, 2900) } })
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: clip(`${SEVERITY_EMOJI[alert.severity] ?? ''} ${alert.severity} · \`${esc(alert.key)}\` · ${esc(alert.environment ?? 'unknown env')} · ${(alert.occurredAt ?? new Date()).toISOString()}`, 2900) }] })
  return { text: clip(`${prefix}${alert.title}: ${alert.summary.replace(/[*_`]/g, '')}`, 3000), blocks }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

/** POSTs one payload with retries on network errors, 429 and 5xx. Returns a narrow result; never throws. */
export async function deliver(payload, { webhookUrl = process.env.SLACK_ALERT_WEBHOOK_URL, fetchImpl = fetch, timeoutMs = 10_000, retries = 3, backoffMs = 1_000 } = {}) {
  const allowLoopback = process.env.QA_SLACK_ALLOW_LOOPBACK === '1'
  if (!webhookUrl) return { ok: false, code: 'not_configured', attempts: 0 }
  if (!isSlackWebhookUrl(webhookUrl, { allowLoopback })) return { ok: false, code: 'invalid_webhook_url', attempts: 0 }
  const started = Date.now()
  let code = 'unknown'
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetchImpl(webhookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs) })
      if (res.ok) return { ok: true, code: 'ok', attempts: attempt, latencyMs: Date.now() - started, sentAt: new Date().toISOString() }
      code = `slack_http_${res.status}`
      if (res.status !== 429 && res.status < 500) break
      const retryAfter = Number(res.headers.get?.('retry-after'))
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 30_000) : backoffMs * 3 ** (attempt - 1))
    } catch (error) {
      code = error?.name === 'TimeoutError' ? 'timeout' : 'network'
      if (attempt < retries) await sleep(backoffMs * 3 ** (attempt - 1))
    }
  }
  return { ok: false, code, attempts: retries, latencyMs: Date.now() - started }
}

function dashboardLink(run, anchor = '') {
  const base = process.env.QA_DASHBOARD_URL || 'http://127.0.0.1:4500'
  return `<${base}/#/runs/${run.runId}${anchor}|${run.runId}>`
}

/** Decides which alerts a finished run produces. Pure, so alert accuracy is unit-testable. */
export function buildRunAlerts(run) {
  const alerts = []
  const product = run.groups.filter(g => g.classification === 'product')
  const infra = run.groups.filter(g => g.classification === 'infrastructure')
  const cmp = run.comparison ?? { newFailures: [], persisting: [], newVariants: [], recovered: [] }
  const persistingKeys = new Set(cmp.persisting.map(p => p.key))
  const variantKeys = new Set(cmp.newVariants.map(p => p.key))
  const c = run.counts
  const statusWord = { passed: 'passed', failed: 'failed', 'infra-failed': 'could not run (infrastructure)', timeout: 'timed out', blocked: 'blocked', crashed: 'crashed' }[run.status] ?? run.status
  const base = { environment: run.env, occurredAt: new Date(run.finishedAt ?? Date.now()), test: !!run.seededDefect }
  const facts = [
    { label: 'Suite', value: `${run.suite}${run.seededDefect ? ` (seeded defect: ${run.seededDefect})` : ''}` },
    { label: 'Trigger', value: `${run.trigger}${run.scheduleId ? ` · ${run.scheduleId}` : ''}` },
    { label: 'Results', value: `${c.passed} passed · ${c.failed} failed · ${c.skipped} skipped · ${c.blocked} blocked` },
    { label: 'Duration', value: `${Math.round((run.durationMs ?? 0) / 1000)}s` },
    { label: 'Critical coverage (this run)', value: run.coverage ? `${run.coverage.numerator}/${run.coverage.denominator}` : 'n/a' },
    { label: 'App version', value: run.versions?.app?.id ?? 'unspecified' },
  ]
  alerts.push({ kind: 'summary', alert: { ...base, key: `qa_run_${run.status}`, severity: run.status === 'passed' ? 'info' : product.some(g => g.critical) ? 'critical' : 'warning',
    title: `MPC QA ${run.suite} ${statusWord} — ${run.env}`, summary: `Run ${dashboardLink(run)}${run.errors?.length ? `\n${esc(clip(run.errors[0], 400))}` : ''}`, facts } })

  if (product.length) {
    const allDuplicate = product.every(g => g.tests.every(t => persistingKeys.has(t.key)))
    const lines = product.slice(0, 8).map(g => {
      const keys = g.tests.map(t => t.key)
      const label = keys.some(k => variantKeys.has(k)) ? ':new: *new failure variant*' : keys.every(k => persistingKeys.has(k)) ? `:repeat: *recurring* since ${cmp.persisting.find(p => keys.includes(p.key))?.since ?? 'earlier run'}` : ':red_circle: *new*'
      const names = g.tests.slice(0, 3).map(t => `• ${esc(clip(t.title, 140))}`).join('\n') + (g.size > 3 ? `\n• …and ${g.size - 3} more with the same error` : '')
      return `${label}${g.critical ? ' · :rotating_light: critical' : ''}${g.requirementIds.length ? ` · ${g.requirementIds.join(', ')}` : ''} · ${g.size} test(s)\n${names}\n> ${esc(clip(g.message || 'assertion failed', 300))}`
    })
    if (product.length > 8) lines.push(`…and ${product.length - 8} more failure groups`)
    alerts.push({ kind: allDuplicate ? 'failure-recurring' : 'failure', alert: { ...base, key: allDuplicate ? 'qa_failure_recurring' : 'qa_failure',
      severity: product.some(g => g.critical) ? 'critical' : 'warning',
      title: allDuplicate ? `Still failing: ${product.reduce((s, g) => s + g.size, 0)} test(s) in ${run.suite} — ${run.env}` : `Product failures in ${run.suite} — ${run.env}`,
      summary: `${product.length} failure group(s), duplicates grouped by error signature. Evidence: ${dashboardLink(run, '/failures')}`, sections: lines } })
  }
  if (infra.length || run.status === 'infra-failed' || run.status === 'crashed') {
    const reasons = [...new Set(infra.map(g => g.reason))].concat(run.status === 'infra-failed' && !infra.length ? ['environment health probe failed'] : [])
    alerts.push({ kind: 'infra', alert: { ...base, key: 'qa_infrastructure', severity: 'warning',
      title: `Infrastructure problem — ${run.suite} on ${run.env} (not a product defect)`,
      summary: `Tests could not exercise the product: ${esc(reasons.join(', ') || run.status)}. Run ${dashboardLink(run)}`,
      sections: infra.slice(0, 5).map(g => `• ${g.size} test(s): ${esc(clip(g.message, 250))}`) } })
  }
  if (cmp.recovered.length) {
    alerts.push({ kind: 'recovery', alert: { ...base, key: 'qa_recovered', severity: 'info',
      title: `Recovered: ${cmp.recovered.length} test(s) passing again — ${run.env}`,
      summary: cmp.recovered.slice(0, 10).map(r => `:white_check_mark: ${esc(clip(r.title, 160))} (failing since ${r.failingSinceRunId})`).join('\n') + `\nRun ${dashboardLink(run)}` } })
  }
  return alerts
}

function outboxPath() { return join(RUNS_DIR, 'slack-outbox.jsonl') }

/** Retries messages that failed earlier. Successful or abandoned (>24h) entries leave the outbox. */
export async function flushOutbox(options = {}) {
  const pending = readEvents('slack-outbox.jsonl')
  if (!pending.length) return []
  const keep = []
  const results = []
  for (const item of pending) {
    const result = await deliver(item.payload, { ...options, retries: 1 })
    results.push({ runId: item.runId, kind: item.kind, ...result, fromOutbox: true })
    if (!result.ok && Date.now() - Date.parse(item.at) < 86_400_000 && result.code !== 'invalid_webhook_url') keep.push(item)
  }
  writeFileSync(outboxPath(), keep.map(i => JSON.stringify(i)).join('\n') + (keep.length ? '\n' : ''))
  return results
}

export async function notifyRun(run, options = {}) {
  if(process.env.SLACK_CHANNEL_ID || process.env.SLACK_BOT_TOKEN) return notifyBotRun(run,options)
  const outbox = await flushOutbox(options)
  const results = []
  for (const { kind, alert } of buildRunAlerts(run)) {
    const payload = renderSlackAlert(alert)
    const result = await deliver(payload, options)
    results.push({ kind, severity: alert.severity, title: alert.title, ...result })
    if (!result.ok && result.code !== 'not_configured') appendEvent('slack-outbox.jsonl', { runId: run.runId, kind, payload })
  }
  return { results, outbox }
}

/** Standalone alert (missed schedule, overlap) through the same renderer and delivery path. */
export async function notifyEvent(alert, options = {}) {
  const payload = renderSlackAlert({ occurredAt: new Date(), ...alert })
  const result = await deliver(payload, options)
  if (!result.ok && result.code !== 'not_configured') appendEvent('slack-outbox.jsonl', { runId: null, kind: alert.key, payload })
  return result
}
