import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateScheduler, runWatchdog } from '../../pipeline/lib/watchdog.mjs'

const NOW = new Date('2026-11-21T03:20:00Z')
const hourly = { id: 'hourly-smoke-hosted', cron: '0 * * * *', suite: 'smoke', env: 'preview', enabled: true, kind: 'test' }
const fresh = new Date(NOW.getTime() - 60_000).toISOString()
const refusedJob = { id: 'hourly-smoke-hosted-1', scheduleId: 'hourly-smoke-hosted', at: new Date(NOW.getTime() - 10 * 60_000).toISOString(),
  status: 'refused', reason: 'Environment "preview" needs QA_PREVIEW_BASE_URL.' }

test('a refused due slot is named, not reported as a silent scheduler', () => {
  const result = evaluateScheduler({ now: NOW, heartbeatAt: fresh, index: [], jobs: [refusedJob], schedules: [hourly], expected: true })
  assert.equal(result.silent, false)
  assert.equal(result.refused.length, 1)
  assert.match(result.reason, /scheduled check refused: hourly-smoke-hosted \(Environment "preview" needs QA_PREVIEW_BASE_URL\.\)/)
})

test('with no refusal recorded, a due schedule with no run is still silent', () => {
  const result = evaluateScheduler({ now: NOW, heartbeatAt: fresh, index: [], jobs: [], schedules: [hourly], expected: true })
  assert.equal(result.silent, true)
  assert.deepEqual(result.refused, [])
})

test('a refusal older than the window is not reported', () => {
  const old = { ...refusedJob, at: new Date(NOW.getTime() - 5 * 60 * 60_000).toISOString() }
  const result = evaluateScheduler({ now: NOW, heartbeatAt: fresh, index: [], jobs: [old], schedules: [hourly], expected: true })
  assert.deepEqual(result.refused, [])
})

test('the watchdog sends one warning per refused schedule and resets once the refusal leaves the window', async () => {
  const sent = []
  let stored = {}
  const notifyImpl = async (key, title, summary, severity) => { sent.push({ key, severity, summary }); return true }
  const base = { expectScheduler: true, schedules: { timezone: 'Asia/Seoul', schedules: [hourly] }, readIndexImpl: () => [],
    readHeartbeat: () => fresh, balanceReader: async () => ({ ok: false, reason: 'skipped' }), notifyImpl,
    persistImpl: next => { stored = next }, loadState: () => JSON.parse(JSON.stringify(stored)) }
  await runWatchdog({ ...base, now: NOW, readJobs: () => [refusedJob] })
  await runWatchdog({ ...base, now: NOW, readJobs: () => [refusedJob] })
  assert.deepEqual(sent.map(s => s.key), ['schedule-refused-hourly-smoke-hosted'])
  assert.equal(sent[0].severity, 'warning')
  assert.doesNotMatch(sent[0].summary, /https?:\/\//)
  // Three hours later the refusal is outside the window, so the record clears and a new refusal would alert again.
  const later = new Date(NOW.getTime() + 3 * 60 * 60_000)
  await runWatchdog({ ...base, now: later, readHeartbeat: () => new Date(later.getTime() - 60_000).toISOString(), readJobs: () => [refusedJob] })
  assert.deepEqual(stored.refusedAlerts, {})
})
