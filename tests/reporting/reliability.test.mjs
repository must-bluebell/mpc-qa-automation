import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Isolate every file this test writes (watchdog state, Jira store, run history) before any pipeline module loads.
const runsDir = mkdtempSync(join(tmpdir(), 'qa-reliability-'))
process.env.QA_RUNS_DIR = runsDir
const { evaluateScheduler, evaluateWalletBalance, runWatchdog } = await import('../../pipeline/lib/watchdog.mjs')
const { placementRefusal } = await import('../../pipeline/lib/placement.mjs')
const { completeJob } = await import('../../pipeline/scheduler.mjs')
const { buildTrends } = await import('../../pipeline/lib/test-history.mjs')
const { normalizeRecord } = await import('../../pipeline/adapters/playwright.mjs')
const { config } = await import('../../pipeline/lib/env.mjs')

const KST = (iso) => new Date(iso)
// 10:20 KST is 01:20 UTC.
const NOW = KST('2026-11-20T01:20:00Z')
const hourly = { id: 'hourly', cron: '0 * * * *', enabled: true, kind: 'test', env: 'production', suite: 'smoke' }
const daily = { id: 'nightly', cron: '0 1 * * *', enabled: true, kind: 'test', env: 'production', suite: 'hosted-full' }

test.after(() => rmSync(runsDir, { recursive: true, force: true }))

// --- Item 1: retries and flaky marking -------------------------------------------------------------------

test('a case that passes only on its retry is reported as passed and flaky, not failed', () => {
  const tests = normalizeRecord({ title: 'web > W01 - Display options', project: 'chromium', status: 'passed', outcome: 'flaky', annotations: [], errors: [], evidence: [], tags: [], retries: 1 }, { evidenceBase: 'steps/01' })
  assert.equal(tests.status, 'passed')
  assert.equal(tests.flaky, true)
  assert.equal(tests.retries, 1)
})

test('a case that fails on both attempts stays a failure', () => {
  const tests = normalizeRecord({ title: 'web > W01', project: 'chromium', status: 'failed', outcome: 'unexpected', annotations: [], errors: ['Timed out'], evidence: [], tags: [] }, { evidenceBase: 'steps/01' })
  assert.equal(tests.status, 'failed')
  assert.equal(tests.flaky, false)
})

test('playwright config honours QA_RETRIES and rejects out-of-range values', () => {
  const list = env => spawnSync('npx', ['playwright', 'test', '--project=api', '--list', '--reporter=json'], {
    cwd: join(import.meta.dirname, '../..'), env: { ...process.env, ...env, CI: '' }, encoding: 'utf8', timeout: 120_000,
  })
  const one = list({ QA_RETRIES: '1' })
  assert.equal(one.status, 0, one.stderr)
  assert.equal(JSON.parse(one.stdout).config.projects.find(p => p.name === 'api').retries, 1)
  const bad = list({ QA_RETRIES: '5' })
  assert.notEqual(bad.status, 0)
  assert.match(bad.stderr + bad.stdout, /QA_RETRIES must be 0, 1 or 2/)
})

// --- Item 2: which machine runs which schedule -----------------------------------------------------------

test('a hosted deployment refuses Docker-stack schedules and accepts live-site ones', () => {
  const docker = { id: 'critical-30m', suite: 'critical-smoke', env: 'local-docker' }
  assert.match(placementRefusal(docker, { hosted: true }), /isolated Docker runner/)
  assert.match(placementRefusal({ id: 'x', suite: 'load', env: 'production' }, { hosted: true }), /isolated Docker runner/)
  assert.equal(placementRefusal(hourly, { hosted: true }), null)
  assert.equal(placementRefusal({ id: 'y', suite: 'api', env: 'staging' }, { hosted: true }), null)
})

test('a developer machine runs every configured schedule', () => {
  assert.equal(placementRefusal({ id: 'critical-30m', suite: 'critical-smoke', env: 'local-docker' }, { hosted: false }), null)
})

test('an orchestrator policy refusal (exit 4) is recorded as refused, never as a crashed run', async () => {
  const state = { jobs: [] }
  const job = { id: 'j1', runId: 'sched-j1', suite: 'smoke', env: 'local-docker', status: 'running' }
  let saved = false
  await completeJob(state, job, 4, {
    readRunImpl: () => null, saveRunImpl: () => { saved = true }, createDirImpl: () => { saved = true }, persistImpl: () => {},
    notify: async () => { saved = true; return { queued: true } },
  })
  assert.equal(job.status, 'refused')
  assert.match(job.reason, /policy guard/)
  assert.equal(saved, false)
})

// --- Item 4: heartbeat --------------------------------------------------------------------------------------

test('scheduler silence is not judged on a host that does not run the scheduler', () => {
  assert.equal(evaluateScheduler({ now: NOW, heartbeatAt: null, schedules: [hourly], expected: false }).silent, false)
})

test('a fresh heartbeat with nothing due is not silent', () => {
  const heartbeatAt = new Date(NOW.getTime() - 60_000).toISOString()
  assert.equal(evaluateScheduler({ now: NOW, heartbeatAt, schedules: [daily], index: [], expected: true }).silent, false)
})

test('a stale heartbeat is silent, even for a daily-only schedule', () => {
  const heartbeatAt = new Date(NOW.getTime() - 120 * 60_000).toISOString()
  const result = evaluateScheduler({ now: NOW, heartbeatAt, schedules: [daily], index: [], expected: true })
  assert.equal(result.silent, true)
  assert.match(result.reason, /no scheduler heartbeat/)
})

test('an hourly slot that fell due with no scheduled run recorded is silent', () => {
  const heartbeatAt = new Date(NOW.getTime() - 60_000).toISOString()
  const result = evaluateScheduler({ now: NOW, heartbeatAt, schedules: [hourly], index: [], expected: true })
  assert.equal(result.silent, true)
  assert.equal(result.dueInWindow, true)
})

test('hourly slots the scheduler recorded as missed (busy pipeline) are not a silent scheduler', () => {
  const heartbeatAt = new Date(NOW.getTime() - 60_000).toISOString()
  // Two hourly slots fall in the 90-minute window (00:00Z and 01:00Z); both were recorded, one missed and one queued.
  const jobs = [
    { id: `hourly-${Date.parse('2026-11-20T00:00:00Z')}`, scheduleId: 'hourly', status: 'missed', at: '2026-11-20T00:00:00.000Z' },
    { id: `hourly-${Date.parse('2026-11-20T01:00:00Z')}`, scheduleId: 'hourly', status: 'queued', at: '2026-11-20T01:00:00.000Z' },
  ]
  const result = evaluateScheduler({ now: NOW, heartbeatAt, index: [], jobs, schedules: [hourly], expected: true })
  assert.equal(result.silent, false)
  assert.equal(result.dueInWindow, true)
  assert.equal(result.reason, 'scheduler reporting')
})

test('a recent scheduled run clears the silence for an hourly schedule', () => {
  const heartbeatAt = new Date(NOW.getTime() - 60_000).toISOString()
  const index = [{ trigger: 'scheduled', startedAt: '2026-11-20T00:58:00Z', finishedAt: '2026-11-20T01:02:00Z' }]
  assert.equal(evaluateScheduler({ now: NOW, heartbeatAt, schedules: [hourly], index, expected: true }).silent, false)
})

test('the watchdog alerts once when silence starts and once when it clears', async () => {
  const sent = []
  const notifyImpl = async (key, title) => { sent.push({ key, title }); return true }
  const base = { now: NOW, expectScheduler: true, schedules: { timezone: 'Asia/Seoul', schedules: [daily] }, balanceReader: async () => ({ ok: false, reason: 'skip' }), notifyImpl }
  const stale = new Date(NOW.getTime() - 200 * 60_000).toISOString()
  const fresh = new Date(NOW.getTime() - 60_000).toISOString()
  await runWatchdog({ ...base, readHeartbeat: () => stale, readIndexImpl: () => [] })
  await runWatchdog({ ...base, readHeartbeat: () => stale, readIndexImpl: () => [] })
  await runWatchdog({ ...base, readHeartbeat: () => fresh, readIndexImpl: () => [] })
  assert.deepEqual(sent.map(s => s.key), ['scheduler-silent', 'scheduler-recovered'])
})

test('a silent scheduler alerts once even when the watchdog state cannot be saved', async () => {
  const sent = []
  const notifyImpl = async (key) => { sent.push(key); return true }
  const stale = new Date(NOW.getTime() - 200 * 60_000).toISOString()
  const fresh = new Date(NOW.getTime() - 60_000).toISOString()
  const base = { now: NOW, expectScheduler: true, schedules: { timezone: 'Asia/Seoul', schedules: [daily] }, balanceReader: async () => ({ ok: false, reason: 'skip' }), notifyImpl,
    loadState: () => ({}), persistImpl: () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }) } }
  const errors = []
  const originalError = console.error
  console.error = (...args) => errors.push(args.join(' '))
  try {
    await runWatchdog({ ...base, readHeartbeat: () => stale, readIndexImpl: () => [] })
    await runWatchdog({ ...base, readHeartbeat: () => stale, readIndexImpl: () => [] })
    await runWatchdog({ ...base, readHeartbeat: () => stale, readIndexImpl: () => [] })
    await runWatchdog({ ...base, readHeartbeat: () => fresh, readIndexImpl: () => [] })
  } finally { console.error = originalError }
  assert.deepEqual(sent, ['scheduler-silent', 'scheduler-recovered'])
  assert.ok(errors.some(e => /state not saved: ENOSPC/.test(e)))
})

// --- Item 5: test wallet ------------------------------------------------------------------------------------

test('any balance above the allowed maximum is a finding', () => {
  assert.equal(evaluateWalletBalance({ balanceWei: 0n }).funded, false)
  assert.equal(evaluateWalletBalance({ balanceWei: 1n }).funded, true)
  assert.equal(evaluateWalletBalance({ balanceWei: 5n, maxWei: 5n }).funded, false)
})

test('an unreadable balance is reported as unchecked, never as funded', async () => {
  process.env.WALLET_ADDRESS = '0x000000000000000000000000000000000000dEaD'
  const notifyImpl = async () => { throw new Error('must not alert on an unknown balance') }
  const facts = await runWatchdog({ now: NOW, expectScheduler: false, schedules: { timezone: 'Asia/Seoul', schedules: [] }, readIndexImpl: () => [],
    readHeartbeat: () => null, balanceReader: async () => ({ ok: false, reason: 'balance lookup failed' }), notifyImpl })
  assert.equal(facts.wallet.checked, false)
  delete process.env.WALLET_ADDRESS
})

// --- Item 3: browser smoke coverage ------------------------------------------------------------------------

test('the hourly production smoke runs the read-only browser journeys', () => {
  const smoke = config.suites().smoke.steps.find(s => s.project === 'chromium')
  assert.equal(smoke.grep, '@smoke')
  const spec = join(import.meta.dirname, '../../tests/wallet/smoke-journeys.spec.ts')
  assert.ok(existsSync(spec))
  const src = readFileSync(spec, 'utf8')
  assert.match(src, /J02 - A rejected sign-in request never reaches verification/)
  assert.doesNotMatch(src, /\/api\/auth\/verify'[^)]*method:\s*'POST'/)
})

// --- Item 6: trends -----------------------------------------------------------------------------------------

test('trends compute pass rate per run, flaky counts and first-failed dates, and skip non-executed cases', () => {
  const run = (id, finishedAt, tests, extra = {}) => ({ runId: id, finishedAt, startedAt: finishedAt, suite: 'api', env: 'production', status: 'failed',
    counts: { passed: tests.filter(t => t.status === 'passed').length, failed: tests.filter(t => t.status === 'failed').length, flaky: tests.filter(t => t.flaky).length }, tests, ...extra })
  const runs = [
    run('r2', '2026-11-02T00:00:00Z', [{ key: 'a', title: 'A', status: 'failed' }, { key: 'b', title: 'B', status: 'passed', flaky: true }, { key: 'c', title: 'C', status: 'skipped' }]),
    run('r1', '2026-11-01T00:00:00Z', [{ key: 'a', title: 'A', status: 'passed' }, { key: 'b', title: 'B', status: 'passed' }]),
    run('seeded', '2026-11-03T00:00:00Z', [{ key: 'a', title: 'A', status: 'failed' }], { seededDefect: 'auth-session-500' }),
  ]
  const trends = buildTrends(runs)
  assert.deepEqual(trends.series.map(p => p.runId), ['r1', 'r2'])
  assert.equal(trends.series[0].passRate, 1)
  assert.equal(trends.series[1].passRate, 0.5)
  const a = trends.topFailing.find(t => t.key === 'a')
  assert.equal(a.failures, 1)
  assert.equal(a.firstFailedAt, '2026-11-02T00:00:00Z')
  assert.equal(trends.topFailing.find(t => t.key === 'b').flaky, 1)
  assert.equal(trends.topFailing.find(t => t.key === 'c'), undefined)
})
