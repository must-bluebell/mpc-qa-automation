#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { config, knownSecrets, resolveEnvironment, isLoopback, readJson } from './lib/env.mjs'
import { acquireLock, LockBusyError } from './lib/lock.mjs'
import { appendEvent, createRunDir, isRunId, markCrashedRuns, newRunId, previousRun, readIndex, saveRun } from './lib/run-store.mjs'
import { classifyFailure, fingerprintOf, groupFailures, signatureOf } from './lib/classify.mjs'
import { compareRuns } from './lib/compare.mjs'
import { coverageOf, matchRequirements } from './lib/coverage.mjs'
import { appVersion, testSuiteVersion } from './lib/versions.mjs'
import { runPlaywrightStep } from './adapters/playwright.mjs'
import { runWebmpcStep } from './adapters/webmpc-scenarios.mjs'
import { runK6Step, LoadGuardError } from './adapters/k6.mjs'
import { runRecordedLoadStep } from './adapters/recorded-load.mjs'
import { stackStatus } from './adapters/local-stack.mjs'
import { startChaosProxy, PROFILES } from './chaos/proxy.mjs'
import { notifyRun } from './notify/slack.mjs'
import { analyzeRun } from './ai/analyze.mjs'
import { shouldReview } from './ai/policy.mjs'
import { publishSummary, kstTime } from './lib/safe-output.mjs'
import { generateAllureReport } from './lib/allure.mjs'
import { prepareTestData } from './lib/test-data.mjs'
import { runStatus } from './lib/run-status.mjs'

const ADAPTERS = { playwright: runPlaywrightStep, 'webmpc-scenarios': runWebmpcStep, k6: runK6Step, 'recorded-load': runRecordedLoadStep }
const TRIGGERS = /^[\w-]{1,40}$/

export class GuardError extends Error {}

/** Expands a suite (and any included suites) into its ordered steps. */
export function expandSuite(name, suites = config.suites(), seen = new Set()) {
  const suite = suites[name]
  if (!suite) throw new GuardError(`Unknown suite "${name}". Known: ${Object.keys(suites).join(', ')}`)
  if (seen.has(name)) return []
  seen.add(name)
  const steps = (suite.include ?? []).flatMap(child => expandSuite(child, suites, seen).map(s => ({ ...s, fromSuite: s.fromSuite ?? child })))
  return [...steps, ...(suite.steps ?? []).map(s => ({ ...s, fromSuite: name, requiresIsolated: suite.requiresIsolated, requiresLoad: suite.requiresLoad }))]
}

/** Policy checks before anything runs. Refusals are recorded, never silently skipped. */
export function guard({ suiteName, env, steps, seededDefect }) {
  const refusals = []
  for (const step of steps) {
    if (step.requiresIsolated && !env.isolated) refusals.push(`${step.fromSuite}: requires the isolated local stack; "${env.name}" is not isolated.`)
    if (step.requiresLoad && !(env.allowLoad && isLoopback(env.baseUrl))) refusals.push(`${step.fromSuite}: load tests are only allowed on an approved isolated loopback environment.`)
  }
  if (seededDefect && !env.allowSeededDefects) refusals.push(`Seeded defects are only allowed on the isolated stack, not "${env.name}".`)
  if (seededDefect && !PROFILES[seededDefect]) refusals.push(`Unknown seeded defect "${seededDefect}".`)
  if (refusals.length) throw new GuardError(`Run refused for suite "${suiteName}": ${refusals.join(' ')}`)
}

async function probe(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: 'manual' })
    return { ok: res.status < 500, status: res.status }
  } catch (error) { return { ok: false, error: error.cause?.code ?? error.message } }
}

function redactDeep(value, secrets) {
  const text = JSON.stringify(value)
  let out = text
  for (const s of secrets) out = out.split(s).join('[REDACTED]')
  return out === text ? value : JSON.parse(out)
}

/**
 * Runs one suite on one environment and returns the finished run record.
 * Exit semantics for the CLI: 0 passed, 1 product failures, 2 infrastructure/timeout, 3 overlap refused, 4 guard refused.
 */
export async function runPipeline({ suite: suiteName, env: envName, trigger = 'manual', scheduleId = null, seededDefect = null, runId, notify = true, ai = undefined, echo = true, slackOptions = {} }) {
  if (!TRIGGERS.test(trigger)) throw new GuardError(`Invalid trigger "${trigger}".`)
  if (runId != null && !isRunId(runId)) throw new GuardError(`Invalid run id "${runId}".`)
  const env = resolveEnvironment(envName)
  const suites = config.suites()
  const steps = expandSuite(suiteName, suites)
  guard({ suiteName, env, steps, seededDefect })
  const id = runId ?? newRunId(suiteName)
  let lock
  try { lock = acquireLock(id) } catch (error) {
    if (error instanceof LockBusyError) {
      appendEvent('overlaps.jsonl', { runId: id, suite: suiteName, env: envName, trigger, scheduleId, blockedBy: error.holder.runId })
      error.exitCode = 3
    }
    throw error
  }
  const crashed = markCrashedRuns(id)
  const dir = createRunDir(id)
  const started = Date.now()
  const timeoutMs = suites[suiteName].timeoutMs ?? 3_600_000
  const run = {
    schemaVersion: 1, runId: id, suite: suiteName, env: env.name, envDescription: env.description, baseUrl: env.baseUrl, trigger, scheduleId, seededDefect,
    status: 'running', startedAt: new Date(started).toISOString(), finishedAt: null, durationMs: null, timeoutMs,
    versions: { app: await appVersion(env), testSuite: testSuiteVersion(), pipeline: 'v1' },
    host: { node: process.version, platform: process.platform, pid: process.pid }, lock: { tookOverFrom: lock.tookOverFrom }, recoveredCrashedRuns: crashed,
    steps: [], tests: [], counts: { passed: 0, failed: 0, skipped: 0, blocked: 0, flaky: 0, total: 0 }, groups: [], errors: [], notifications: [], ai: { status: 'not-run' },
  }
  saveRun(run)
  let proxy
  try {
    // Health probe first: an unreachable target is an infrastructure failure, not a wall of red product tests.
    const health = await probe(env.baseUrl)
    run.health = { ...health, checkedAt: new Date().toISOString(), stack: env.stack ? await stackStatus(env) : null }
    if (!health.ok || (run.health.stack && !run.health.stack.healthy)) {
      run.status = 'infra-failed'
      run.errors.push(`Environment health probe failed for ${env.baseUrl}: ${health.error ?? `HTTP ${health.status}`}`)
      if(run.health.stack&&!run.health.stack.healthy)run.errors.push(`Required stack services missing or unhealthy: ${[...(run.health.stack.missingServices??[]),...(run.health.stack.unhealthyServices??[])].join(', ')||'see stack status'}`)
    } else {
      // Test data is prepared once the environment is known healthy; a failure is reported, not fatal (tests then show what is blocked).
      run.testData = await prepareTestData(env, { log: echo ? line => console.log(line) : () => {} })
      saveRun(run)
      let targetUrl = env.baseUrl
      if (seededDefect) {
        proxy = await startChaosProxy({ target: env.baseUrl, profile: seededDefect })
        targetUrl = proxy.url
        run.seed = { profile: seededDefect, ...PROFILES[seededDefect], response: undefined, delayMs: undefined, proxy: proxy.url }
      }
      for (const [i, step] of steps.entries()) {
        const name = `${String(i + 1).padStart(2, '0')}-${step.adapter}${step.project ? `-${step.project}` : ''}${step.script ? `-${step.script}` : ''}`
        const stepDir = join(dir, 'steps', name)
        mkdirSync(stepDir, { recursive: true })
        const remainingMs = () => Math.max(5_000, timeoutMs - (Date.now() - started))
        const ctx = { runId: id, runDir: dir, stepDir, env, targetUrl, suite: suiteName, versions: run.versions, remainingMs, seededDefect, echo }
        const stepStarted = Date.now()
        let result
        try {
          if (Date.now() - started > timeoutMs) throw new Error('Suite timeout reached before this step started')
          result = await ADAPTERS[step.adapter](step, ctx)
        } catch (error) {
          result = { tests: [], errors: [error.message], infra: error instanceof LoadGuardError ? null : 'step crashed', refused: error instanceof LoadGuardError }
          if (error instanceof LoadGuardError) appendEvent('load-guard.jsonl', { runId: id, env: env.name, refused: error.message })
        }
        for (const t of result.tests) {
          t.step = name
          if (result.infra && t.status === 'failed') t.infra = result.infra
        }
        if (!result.tests.length && (result.infra || result.errors.length)) {
          // A step that produced no results still needs a visible record: mark it as one blocked/failed pseudo-test.
          result.tests.push({ key: `${step.adapter}:${step.project ?? step.script ?? step.command}:step`, title: `${name} did not produce results`, adapter: step.adapter,
            project: step.project ?? null, tags: ['@pipeline'], status: 'failed', durationMs: Date.now() - stepStarted, retries: 0, errors: result.errors, annotations: [], evidence: [], infra: result.infra ?? 'step crashed', step: name })
        }
        run.tests.push(...result.tests)
        run.steps.push({ name, adapter: step.adapter, fromSuite: step.fromSuite, project: step.project ?? null, grep: step.grep ?? null, durationMs: Date.now() - stepStarted,
          timedOut: !!result.timedOut, exitCode: result.exitCode ?? null, errors: result.errors, artifacts: result.artifacts ?? {}, testCount: result.tests.length })
        if (result.load) run.load = result.load
        if (result.timedOut) run.errors.push(`${name} timed out`)
        saveRun(run)
      }
    }
  } catch (error) {
    run.errors.push(`Orchestrator error: ${error.stack ?? error.message}`)
    run.status = 'infra-failed'
  } finally {
    if (proxy) { run.seed.stats = proxy.stats; await proxy.close() }
  }

  // Classification, grouping, comparison, coverage.
  const requirements = config.requirements()
  for (const t of run.tests) {
    t.classification = classifyFailure(t)
    t.signature = t.status === 'failed' ? signatureOf(t) : null
    t.fingerprint = t.status === 'failed' ? fingerprintOf(t) : null
    t.requirementIds = matchRequirements(t, requirements)
  }
  const c = run.counts
  for (const t of run.tests) { c[t.status] = (c[t.status] ?? 0) + 1; if (t.flaky) c.flaky++ }
  c.total = run.tests.length
  run.groups = groupFailures(run.tests)
  const prev = previousRun(run)
  run.comparison = compareRuns(run, prev, readIndex().filter(r => r.runId !== id))
  run.coverage = coverageOf(run.tests, requirements)
  if (run.status === 'running') {
    run.status = runStatus(run)
  }
  run.finishedAt = new Date().toISOString()
  run.durationMs = Date.now() - started

  // AI review is advisory; it never changes the status computed above.
  const wantAi = shouldReview(ai, run)
  run.ai = wantAi ? await analyzeRun(run, dir, requirements) : { status: 'not-requested', reason: ai === false ? 'AI review disabled for this run' : process.env.QA_AI_AUTO === '1' ? 'no failures to analyse' : 'QA_AI_AUTO is not 1' }

  // Built before Slack so the summary can link it; a failed build only drops the link.
  run.allure = await generateAllureReport(id, dir, { echo })

  if (notify) {
    const delivery = await notifyRun(run, slackOptions)
    run.notifications = delivery.results.map(r => ({ ...r, latencyFromFinishMs: r.sentAt ? Date.parse(r.sentAt) - Date.parse(run.finishedAt) : null }))
    run.outboxRetries = delivery.outbox
  }
  const secrets = knownSecrets()
  const final = redactDeep(run, secrets)
  saveRun(final)
  writeFileSync(join(dir, 'summary.md'), renderMarkdown(final))
  publishSummary(final)
  lock.release()
  return final
}

export function renderMarkdown(run) {
  const c = run.counts
  const lines = [
    `# MPC QA run ${run.runId}`, '',
    `- Suite: **${run.suite}**${run.seededDefect ? ` (seeded defect: ${run.seededDefect})` : ''} · Environment: **${run.env}** (${run.baseUrl})`,
    `- Trigger: ${run.trigger}${run.scheduleId ? ` (${run.scheduleId})` : ''} · Status: **${run.status}**`,
    `- Started ${kstTime(run.startedAt)} · Finished ${kstTime(run.finishedAt)} · ${Math.round(run.durationMs / 1000)}s`,
    `- App version: ${run.versions.app.id} (${run.versions.app.source}) · Test suite: ${run.versions.testSuite.id}`,
    `- Results: ${c.passed} passed, ${c.failed} failed, ${c.skipped} skipped, ${c.blocked} blocked, ${c.flaky} flaky (of ${c.total})`,
    `- Critical requirement coverage in this run: ${run.coverage.numerator}/${run.coverage.denominator}`, '',
  ]
  if (run.errors.length) lines.push('## Run errors', ...run.errors.map(e => `- ${e.split('\n')[0]}`), '')
  if (run.groups.length) {
    lines.push('## Failures (grouped by error signature)')
    for (const g of run.groups) lines.push(`- **${g.classification}**${g.critical ? ' · critical' : ''} · ${g.size} test(s) · ${g.message}`, ...g.tests.map(t => `  - ${t.title}`))
    lines.push('')
  }
  const cmp = run.comparison
  if (cmp) lines.push('## Compared with previous run', `- Previous: ${cmp.previousRunId ?? 'none'}`, `- New failures: ${cmp.newFailures.length} · Recurring: ${cmp.persisting.length} · New variants: ${cmp.newVariants.length} · Recovered: ${cmp.recovered.length}`, '')
  if (run.notifications.length) lines.push('## Slack', ...run.notifications.map(n => `- ${n.kind}: ${n.ok ? 'delivered' : `not delivered (${n.code})`}`), '')
  return lines.join('\n')
}

async function main() {
  const { values } = parseArgs({ options: {
    suite: { type: 'string', default: 'smoke' }, env: { type: 'string', default: process.env.QA_DEFAULT_ENV || 'local-docker' },
    trigger: { type: 'string', default: 'manual' }, 'schedule-id': { type: 'string' }, 'seed-defect': { type: 'string' },
    'run-id': { type: 'string' }, 'no-notify': { type: 'boolean', default: false }, ai: { type: 'boolean' }, 'no-ai': { type: 'boolean' }, quiet: { type: 'boolean', default: false },
  } })
  try {
    if (values.ai && values['no-ai']) throw new Error('Choose either --ai or --no-ai.')
    const run = await runPipeline({ suite: values.suite, env: values.env, trigger: values.trigger, scheduleId: values['schedule-id'] ?? null,
      seededDefect: values['seed-defect'] ?? null, runId: values['run-id'], notify: !values['no-notify'], ai: values['no-ai'] ? false : values.ai, echo: !values.quiet })
    console.log(`\n${renderMarkdown(run)}\nRun folder: runs/${run.runId}`)
    process.exit(run.status === 'passed' ? 0 : run.status === 'failed' ? 1 : 2)
  } catch (error) {
    console.error(error.message)
    process.exit(error.exitCode ?? (error instanceof GuardError ? 4 : 2))
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main()
export const _forTests = { readJson }
