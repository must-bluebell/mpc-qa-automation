import test from 'node:test'
import assert from 'node:assert/strict'
import { buildOverview, buildProjects, healthOf, projectOf, UNASSIGNED } from '../../pipeline/lib/overview.mjs'

const NOW = new Date('2026-11-24T00:00:00.000Z')
const envs = {
  production: { project: 'mpc' },
  staging: { project: 'mpc' },
  'other-app': { project: 'shop' },
}

function run(id, { env = 'production', status = 'passed', daysAgo = 1, tests = [], project, seededDefect, counts } = {}) {
  const finishedAt = new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString()
  const summed = counts ?? tests.reduce((c, t) => ({ ...c, [t.status]: (c[t.status] ?? 0) + 1 }), { passed: 0, failed: 0, skipped: 0, blocked: 0, flaky: 0 })
  return { runId: id, suite: 'regression', env, project, status, startedAt: finishedAt, finishedAt, seededDefect, counts: summed, tests }
}
const t = (key, status, flaky = false) => ({ key, title: key, status, flaky, errors: status === 'failed' ? ['boom'] : [] })

test('a run takes its project from its environment, and an explicit project on the record wins', () => {
  assert.equal(projectOf({ env: 'production' }, envs), 'mpc')
  assert.equal(projectOf({ env: 'unknown-env' }, envs), UNASSIGNED)
  assert.equal(projectOf({ env: 'production', project: 'legacy' }, envs), 'legacy')
})

test('project list shows configured projects with no runs, and the newest finished run per project', () => {
  const rows = buildProjects([
    run('a', { daysAgo: 3, status: 'failed' }),
    run('b', { daysAgo: 1, status: 'passed' }),
    run('c', { env: 'other-app', daysAgo: 2 }),
  ], envs)
  const mpc = rows.find(r => r.id === 'mpc')
  assert.equal(mpc.runs, 2)
  assert.equal(mpc.latest.runId, 'b')
  assert.deepEqual(mpc.envs, ['production', 'staging'])
  assert.equal(rows.find(r => r.id === 'shop').latest.runId, 'c')
})

test('pass rate counts only executed outcomes; skipped and blocked cases are excluded', () => {
  const runs = [run('a', { tests: [t('1', 'passed'), t('2', 'failed'), t('3', 'skipped'), t('4', 'blocked')] })]
  const o = buildOverview(runs, { days: 30, now: NOW })
  assert.equal(o.kpis.passed, 1)
  assert.equal(o.kpis.failed, 1)
  assert.equal(o.kpis.passRate, 0.5)
  assert.equal(o.kpis.failureRate, 0.5)
})

test('runs outside the window count toward latest and suites but not the rates', () => {
  const runs = [run('old', { daysAgo: 40, tests: [t('1', 'failed')] }), run('new', { daysAgo: 1, tests: [t('1', 'passed')] })]
  const o = buildOverview(runs, { days: 30, now: NOW })
  assert.equal(o.kpis.runs, 1)
  assert.equal(o.kpis.passRate, 1)
  assert.equal(o.latest.runId, 'new')
  assert.equal(o.suites.length, 1)
})

test('environment filter narrows the statistics and the environments list stays complete', () => {
  const runs = [
    run('p', { env: 'production', tests: [t('1', 'passed')] }),
    run('s', { env: 'staging', tests: [t('1', 'failed')] }),
  ]
  const all = buildOverview(runs, { days: 30, now: NOW })
  const staging = buildOverview(runs, { env: 'staging', days: 30, now: NOW })
  assert.deepEqual(all.envs, ['production', 'staging'])
  assert.equal(all.kpis.passRate, 0.5)
  assert.equal(staging.kpis.passRate, 0)
  assert.equal(staging.kpis.runs, 1)
})

test('seeded defect runs and unfinished runs are left out of every statistic', () => {
  const runs = [
    run('seeded', { seededDefect: 'upstream-connection-timeout', tests: [t('1', 'failed')] }),
    { ...run('live', { tests: [t('1', 'failed')] }), status: 'running', finishedAt: null },
    run('ok', { tests: [t('1', 'passed')] }),
  ]
  const o = buildOverview(runs, { days: 30, now: NOW })
  assert.equal(o.kpis.runs, 1)
  assert.equal(o.kpis.failed, 0)
})

test('daily totals group by Seoul calendar day and carry each day pass rate', () => {
  const runs = [
    run('d1a', { daysAgo: 2, tests: [t('1', 'passed'), t('2', 'failed')] }),
    run('d1b', { daysAgo: 2, tests: [t('1', 'passed')] }),
  ]
  const o = buildOverview(runs, { days: 30, now: NOW })
  assert.equal(o.daily.length, 1)
  assert.equal(o.daily[0].runs, 2)
  assert.equal(o.daily[0].passed, 2)
  assert.equal(o.daily[0].failed, 1)
  assert.equal(o.daily[0].passRate, 2 / 3)
})

test('health uses the window pass rate and the latest run result, and says why', () => {
  const rule = { latest: { status: 'passed' }, passRate: 0.97, days: 30 }
  assert.equal(healthOf(rule).state, 'healthy')
  assert.equal(healthOf({ ...rule, latest: { status: 'failed' } }).state, 'at-risk')
  assert.equal(healthOf({ ...rule, passRate: 0.9 }).state, 'at-risk')
  assert.equal(healthOf({ ...rule, passRate: 0.5 }).state, 'failing')
  assert.equal(healthOf({ latest: null, passRate: null, days: 30 }).state, 'no-data')
  assert.equal(healthOf({ latest: { status: 'passed' }, passRate: null, days: 7 }).state, 'no-data')
  assert.match(healthOf(rule).rule, /95%/)
})
