import 'server-only'
import { isSlackWebhookUrl } from './webhook-url'

/**
 * Channel-neutral alert contract. Detection rules produce this shape; notification channels only
 * decide how to render and deliver it. Keep secrets and personal data out of `summary` and `facts`
 * because provider responses, screenshots, and channel history can retain message content.
 */
export type AlertSeverity = 'info' | 'warning' | 'critical'

export interface AlertFact {
  label: string
  value: string | number | boolean
}

export interface SystemAlert {
  /** Stable machine name, for example `gasless_claim_failure_rate`. */
  key: string
  severity: AlertSeverity
  title: string
  summary: string
  facts?: readonly AlertFact[]
  environment?: string
  occurredAt?: Date
  /** Adds a visible `[TEST]` prefix. Reserved for standalone operator test commands. */
  test?: boolean
}

export interface SlackTextObject {
  type: 'plain_text' | 'mrkdwn'
  text: string
  emoji?: boolean
}

export type SlackBlock =
  | { type: 'header'; text: SlackTextObject }
  | { type: 'section'; text?: SlackTextObject; fields?: SlackTextObject[] }
  | { type: 'context'; elements: SlackTextObject[] }
  | { type: 'divider' }

export interface SlackAlertPayload {
  /** Plain-text fallback used by notifications and accessibility clients. */
  text: string
  blocks: SlackBlock[]
}

export type AlertDeliveryFailure =
  | 'not_configured'
  | 'invalid_webhook_url'
  | 'timeout'
  | 'network'
  | `slack_http_${number}`

export type AlertDeliveryResult =
  | { ok: true; channel: 'slack' }
  | { ok: false; channel: 'slack'; reason: AlertDeliveryFailure }

export interface SlackAlertOptions {
  /** Defaults to `SLACK_ALERT_WEBHOOK_URL`. Injection exists for tests, not per-alert routing. */
  webhookUrl?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 10_000
const MAX_HEADER_LENGTH = 150
const MAX_SECTION_LENGTH = 3_000
const MAX_FIELD_LENGTH = 2_000
const MAX_FACTS = 40
const FACTS_PER_SECTION = 10

const SEVERITY_ICON: Record<AlertSeverity, string> = {
  info: 'ℹ️',
  warning: '⚠️',
  critical: '🚨',
}

/**
 * Produces one Slack Block Kit payload from the shared alert contract. It is pure so rule tests can
 * assert the exact message without a webhook, database, network, or blockchain.
 */
export function renderSlackAlert(alert: SystemAlert): SlackAlertPayload {
  const environment = cleanPlainText(alert.environment || runtimeEnvironment(), 80)
  const key = cleanPlainText(alert.key, 100)
  const occurredAt = (alert.occurredAt ?? new Date()).toISOString()
  const testPrefix = alert.test ? '[TEST] ' : ''
  const heading = cleanPlainText(`${testPrefix}${SEVERITY_ICON[alert.severity]} ${alert.title}`, MAX_HEADER_LENGTH)
  const summary = escapeSlackMrkdwn(cleanPlainText(alert.summary, MAX_SECTION_LENGTH))
  const fallback = cleanPlainText(`${heading} — ${alert.summary}`, MAX_SECTION_LENGTH)

  const blocks: SlackBlock[] = [
    { type: 'header', text: { type: 'plain_text', text: heading, emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text: summary } },
  ]

  const facts = (alert.facts ?? []).slice(0, MAX_FACTS)
  for (let offset = 0; offset < facts.length; offset += FACTS_PER_SECTION) {
    blocks.push({
      type: 'section',
      fields: facts.slice(offset, offset + FACTS_PER_SECTION).map((fact) => ({
        type: 'mrkdwn',
        text: `*${escapeSlackMrkdwn(cleanPlainText(fact.label, 100))}*\n${escapeSlackMrkdwn(
          cleanPlainText(String(fact.value), MAX_FIELD_LENGTH),
        )}`,
      })),
    })
  }

  blocks.push(
    { type: 'divider' },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `*${alert.severity.toUpperCase()}* · ${escapeSlackMrkdwn(environment)} · ${escapeSlackMrkdwn(key)} · ${occurredAt}`,
        },
      ],
    },
  )

  return { text: fallback, blocks }
}

/**
 * Sends an alert to the configured Slack Incoming Webhook. Expected delivery failures are returned
 * as narrow codes and never throw, so alerting cannot turn the monitored operation into a failure.
 * The Slack response body is deliberately ignored because it may reflect message content.
 */
export async function sendSlackAlert(
  alert: SystemAlert,
  options: SlackAlertOptions = {},
): Promise<AlertDeliveryResult> {
  const webhookUrl = options.webhookUrl ?? process.env.SLACK_ALERT_WEBHOOK_URL
  if (!webhookUrl) return { ok: false, channel: 'slack', reason: 'not_configured' }
  if (!isSlackWebhookUrl(webhookUrl)) {
    return { ok: false, channel: 'slack', reason: 'invalid_webhook_url' }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), positiveTimeout(options.timeoutMs))

  try {
    const response = await (options.fetchImpl ?? fetch)(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(renderSlackAlert(alert)),
      signal: controller.signal,
    })
    return response.ok
      ? { ok: true, channel: 'slack' }
      : { ok: false, channel: 'slack', reason: `slack_http_${response.status}` }
  } catch (error) {
    return {
      ok: false,
      channel: 'slack',
      reason: error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'network',
    }
  } finally {
    clearTimeout(timer)
  }
}

function runtimeEnvironment(): string {
  return process.env.VERCEL_ENV || process.env.NODE_ENV || 'unknown'
}

function positiveTimeout(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_TIMEOUT_MS
}

function cleanPlainText(value: string, maxLength: number): string {
  const clean = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim()
  if (clean.length <= maxLength) return clean
  return `${clean.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`
}

function escapeSlackMrkdwn(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}
