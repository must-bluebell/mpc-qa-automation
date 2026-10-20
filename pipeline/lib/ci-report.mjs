import { config } from './env.mjs'
import { opaqueId, publicSummary } from './safe-output.mjs'
import { evaluateStackHealth } from '../adapters/local-stack.mjs'

const statuses = new Set(['passed', 'failed', 'blocked', 'skipped'])
const adapters = new Set(['playwright', 'webmpc-scenarios', 'k6'])
const projects = new Set(['chromium', 'api', 'uat'])
const services = new Set(['web', 'postgres', 'neon-proxy', 'anvil', 'anvil-opbnb', 'pgbouncer'])
const number = value => Number.isFinite(value) && value >= 0 ? value : null

/** Treat downloaded CI artifacts as data: re-allowlist names and discard raw diagnostics and paths. */
export function sanitizeCiRun(run, expectedId, { suite } = {}) {
  if (!/^gh-\d+-\d+$/.test(expectedId) || run?.runId !== expectedId
    || !Object.hasOwn(config.suites(), run.suite) || run.env !== 'local-docker' || (suite && run.suite !== suite)
    || !['passed', 'failed', 'infra-failed', 'blocked', 'timeout', 'crashed'].includes(run.status)
    || !Array.isArray(run.tests) || run.tests.length > 10000
    || !Number.isFinite(Date.parse(run.finishedAt)) || !Number.isFinite(Date.parse(run.startedAt))) {
    throw new Error('Invalid CI report metadata')
  }
  const view = publicSummary(run)
  const stepNames = new Map((run.steps ?? []).map((s, i) => [s.name, `ci-step-${i}`]))
  const tests = run.tests.map((t, i) => {
    if (!statuses.has(t.status) || typeof t.key !== 'string') throw new Error('Invalid CI check')
    const c = view.checks[i]
    return {
      key: opaqueId(t.key), title: c.name, status: t.status, fingerprint: opaqueId(t.fingerprint ?? t.key),
      signature: opaqueId(t.signature ?? t.key), adapter: adapters.has(t.adapter) ? t.adapter : 'playwright',
      project: projects.has(t.project) ? t.project : null, step: stepNames.get(t.step) ?? 'ci-step',
      requirementIds: c.requirementIds, durationMs: number(t.durationMs), errors: [], evidence: [],
      ...(t.infra ? { infra: 'CI infrastructure failure' } : {}),
      annotations: [
        ...(c.classification === 'confirmed' ? c.requirementIds.map(id => ({ type: 'defect-confirmed', description: `${id}: confirmed assertion` })) : []),
        ...(c.critical ? [{ type: 'severity', description: 'critical' }] : []),
      ],
    }
  })
  const counts = Object.fromEntries(['passed', 'failed', 'skipped', 'blocked'].map(status => [status, tests.filter(t => t.status === status).length]))
  if (run.status === 'passed' && (!counts.passed || counts.failed || counts.blocked)) throw new Error('CI pass status contradicts check outcomes')
  const load = view.loadMetrics
  const stackServices = (run.health?.stack?.services ?? []).filter(s => services.has(s.service)).map(s => ({
    service: s.service, state: s.state === 'running' ? 'running' : 'unavailable',
    health: ['healthy','unhealthy','starting'].includes(s.health) ? s.health : null,
  }))
  const stack = run.health?.stack ? {services:stackServices,...evaluateStackHealth(stackServices,config.environments()[run.env].stack)} : null
  return {
    schemaVersion: 1, runId: expectedId, suite: run.suite, env: run.env, status: run.status,
    startedAt: new Date(run.startedAt).toISOString(), finishedAt: new Date(run.finishedAt).toISOString(),
    trigger: 'github-ci', scheduleId: null, seededDefect: null, durationMs: number(run.durationMs),
    versions: { app: { id: /^[a-f0-9]{7,40}$/i.test(view.applicationVersion) ? view.applicationVersion : 'unspecified' } },
    counts: { ...counts, total: tests.length, flaky: 0 }, tests, groups: [], errors: [],
    steps: (run.steps ?? []).map((s, i) => ({
      name: `ci-step-${i}`, adapter: adapters.has(s.adapter) ? s.adapter : 'playwright',
      fromSuite: Object.hasOwn(config.suites(), s.fromSuite) ? s.fromSuite : run.suite,
      project: projects.has(s.project) ? s.project : null, artifacts: {},
      testCount: tests.filter(t => t.step === `ci-step-${i}`).length,
      durationMs: number(s.durationMs), exitCode: Number.isInteger(s.exitCode) ? s.exitCode : null,
      timedOut: s.timedOut === true, errors: s.errors?.length ? ['CI step error; see private execution evidence'] : [],
    })),
    health: run.health ? {
      ok: run.health.ok === true, status: number(run.health.status),
      stack,
    } : null,
    testData: run.testData ? { status: ['ready','failed','skipped'].includes(run.testData.status) ? run.testData.status : 'failed', steps: [] } : null,
    ai: { status: 'not-requested', reason: 'CI artifact delivery excludes raw AI artifacts; review saved local evidence separately.' },
    ...(load ? { load: {
      totalRequests: load.totalRequests, throughputRps: load.throughputRps, checkPassRate: load.checkPassRate,
      endpoints: Object.fromEntries(load.endpoints.map(e => [e.name, {p95Ms:e.p95Ms,errorRate:e.errorRate}])),
    } } : {}),
  }
}
