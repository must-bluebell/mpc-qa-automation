import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createPublicClient, formatEther, http } from 'viem'
import { RUNS_DIR, config } from './env.mjs'
import { readIndex, writeJsonAtomic } from './run-store.mjs'
import { cronMatches } from '../scheduler.mjs'
import { notifyEvent } from '../notify/slack.mjs'
import { notifyHealthSummary } from '../notify/slack-bot.mjs'

/**
 * Watchdog for the always-on dashboard process. It answers two questions a finished run cannot:
 *  1. Has the scheduler quietly stopped? (A stopped scheduler cannot report its own silence.)
 *  2. Has the test wallet picked up a balance? (It must hold none; see utils/wallet-generator.ts.)
 * Alerts are sent once when a condition starts and once more when it clears, so a long outage is not spammed.
 */
export const SILENCE_MINUTES = 90
const MINUTE = 60_000
const WALLET_CHECK_INTERVAL_MS = 60 * MINUTE

/**
 * Pure rule for scheduler silence. The scheduler must be expected on this host (a host with the scheduler
 * switched off has nothing to be silent about). It is silent when its heartbeat is stale, or when a test
 * schedule fell due in the last window and no scheduled run has been recorded since.
 */
export function evaluateScheduler({ now, heartbeatAt, index = [], schedules = [], timezone = 'Asia/Seoul', expected, windowMinutes = SILENCE_MINUTES }) {
  const nowMs = now.getTime()
  const windowMs = windowMinutes * MINUTE
  const heartbeatMs = heartbeatAt ? Date.parse(heartbeatAt) : NaN
  const heartbeatAgeMinutes = Number.isFinite(heartbeatMs) ? (nowMs - heartbeatMs) / MINUTE : null
  const scheduledActivity = index
    .filter(r => r.trigger === 'scheduled')
    .map(r => Date.parse(r.finishedAt ?? r.startedAt))
    .filter(Number.isFinite)
  const lastScheduledMs = scheduledActivity.length ? Math.max(...scheduledActivity) : null
  const lastScheduledAgeMinutes = lastScheduledMs == null ? null : (nowMs - lastScheduledMs) / MINUTE
  const dueInWindow = schedules.filter(s => s.enabled && s.kind !== 'summary').some(s => {
    for (let at = Math.floor(nowMs / MINUTE) * MINUTE; at > nowMs - windowMs; at -= MINUTE) {
      if (cronMatches(s.cron, new Date(at), timezone)) return true
    }
    return false
  })
  const heartbeatStale = heartbeatAgeMinutes == null || heartbeatAgeMinutes > windowMinutes
  const noRecentRun = lastScheduledMs == null || nowMs - lastScheduledMs > windowMs
  const silent = !!expected && (heartbeatStale || (dueInWindow && noRecentRun))
  return {
    expected: !!expected, silent, heartbeatAgeMinutes, lastScheduledAgeMinutes, dueInWindow,
    reason: !expected ? 'scheduler not enabled on this host'
      : heartbeatStale ? `no scheduler heartbeat for ${heartbeatAgeMinutes == null ? 'any recorded time' : `${Math.round(heartbeatAgeMinutes)} minutes`}`
      : dueInWindow && noRecentRun ? `a scheduled run was due but none was recorded in ${windowMinutes} minutes`
      : 'scheduler reporting',
  }
}

/** Pure rule for the test wallet: any balance above the allowed maximum is a finding. */
export function evaluateWalletBalance({ balanceWei, maxWei = 0n }) {
  return { funded: balanceWei > maxWei, balanceWei: balanceWei.toString(), maxWei: maxWei.toString() }
}

const DEFAULT_RPC = { 56: 'https://bsc-dataseed.bnbchain.org', 97: 'https://data-seed-prebsc-1-s1.bnbchain.org:8545' }

/** Reads the native balance of the test wallet. Any RPC failure returns null: unknown is never reported as funded. */
export async function readWalletBalance({ address, chainId, rpcUrl, timeoutMs = 15_000 }) {
  const url = rpcUrl || DEFAULT_RPC[chainId]
  if (!url) return { ok: false, reason: `no RPC URL for chain ${chainId}; set QA_WALLET_RPC_URL` }
  try {
    const client = createPublicClient({ transport: http(url, { timeout: timeoutMs, retryCount: 1 }) })
    const balanceWei = await client.getBalance({ address })
    return { ok: true, balanceWei, balance: formatEther(balanceWei) }
  } catch (error) {
    return { ok: false, reason: `balance lookup failed (${error.name ?? 'error'})` }
  }
}

function statePath() { return join(RUNS_DIR, 'watchdog.json') }
function readState() {
  try { return JSON.parse(readFileSync(statePath(), 'utf8')) } catch { return {} }
}

/** Sends through the same channel the runs use: the Slack bot when configured, else the webhook. */
async function raise(key, title, summary, severity) {
  if (process.env.SLACK_CHANNEL_ID || process.env.SLACK_BOT_TOKEN) {
    const result = await notifyHealthSummary(`watchdog-${key}-${Date.now()}`, `${title}\n${summary}`)
    return !!result.queued
  }
  const result = await notifyEvent({ key: `qa_watchdog_${key}`, severity, title, summary, environment: process.env.QA_ENVIRONMENT || 'hosted' })
  return result.ok
}

/**
 * One watchdog pass. Dependencies are injectable so the state machine is testable without Slack or RPC.
 * Returns the evaluated facts; persists alert state in runs/watchdog.json.
 */
export async function runWatchdog({
  now = new Date(),
  expectScheduler = process.env.QA_SCHEDULER_ENABLED === '1',
  readHeartbeat = () => { try { return JSON.parse(readFileSync(join(RUNS_DIR, 'scheduler-state.json'), 'utf8')).heartbeatAt ?? null } catch { return null } },
  readIndexImpl = readIndex,
  schedules = config.schedules(),
  balanceReader = readWalletBalance,
  notifyImpl = raise,
  persistImpl = state => writeJsonAtomic(statePath(), state),
} = {}) {
  const state = readState()
  const facts = {}

  const scheduler = evaluateScheduler({ now, heartbeatAt: readHeartbeat(), index: readIndexImpl(), schedules: schedules.schedules, timezone: schedules.timezone, expected: expectScheduler })
  facts.scheduler = scheduler
  if (scheduler.silent && !state.schedulerAlertOpenedAt) {
    if (await notifyImpl('scheduler-silent', 'MPC QA scheduler is not running', `${scheduler.reason}. Scheduled checks are not running until it is restarted.`, 'critical'))
      state.schedulerAlertOpenedAt = now.toISOString()
  } else if (!scheduler.silent && state.schedulerAlertOpenedAt) {
    if (await notifyImpl('scheduler-recovered', 'MPC QA scheduler is running again', `${scheduler.reason}.`, 'info'))
      delete state.schedulerAlertOpenedAt
  }

  const walletAddress = process.env.WALLET_ADDRESS
  const walletDue = !state.walletCheckedAt || now.getTime() - Date.parse(state.walletCheckedAt) >= WALLET_CHECK_INTERVAL_MS
  if (walletAddress && walletDue) {
    const chainId = Number(process.env.QA_WALLET_CHAIN_ID || process.env.QA_CHAIN_ID || 56)
    const read = await balanceReader({ address: walletAddress, chainId, rpcUrl: process.env.QA_WALLET_RPC_URL })
    state.walletCheckedAt = now.toISOString()
    if (read.ok) {
      const maxWei = BigInt(process.env.QA_WALLET_MAX_BALANCE_WEI || '0')
      const wallet = evaluateWalletBalance({ balanceWei: read.balanceWei, maxWei })
      facts.wallet = { funded: wallet.funded, balance: read.balance, chainId }
      if (wallet.funded && !state.walletAlertOpenedAt) {
        if (await notifyImpl('wallet-funded', 'QA test wallet holds a balance', `The test wallet has ${read.balance} native tokens on chain ${chainId}; it must hold none. Move the funds out and check what sent them.`, 'critical'))
          state.walletAlertOpenedAt = now.toISOString()
      } else if (!wallet.funded && state.walletAlertOpenedAt) {
        if (await notifyImpl('wallet-cleared', 'QA test wallet is empty again', `Balance is back to ${read.balance} on chain ${chainId}.`, 'info'))
          delete state.walletAlertOpenedAt
      }
    } else {
      facts.wallet = { checked: false, reason: read.reason }
    }
  }
  persistImpl(state)
  return facts
}
