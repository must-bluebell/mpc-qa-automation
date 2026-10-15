import { existsSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { ROOT } from '../lib/env.mjs'
import { runProcess } from '../lib/proc.mjs'
import { classifyFailure } from '../lib/classify.mjs'

/** Maps one regression-reporter record (utils/regression-reporter.ts) to the pipeline's test shape. */
export function normalizeRecord(record, { adapter = 'playwright', evidenceBase }) {
  const skipReason=record.annotations.find(a=>['skip','blocked'].includes(a.type))?.description??null
  const dependencyBlocked=record.status==='skipped'&&skipReason&&classifyFailure({status:'failed',errors:[skipReason]})?.kind==='infrastructure'
  const blocked = record.status === 'interrupted' || record.status === 'not-run'
    || dependencyBlocked || (record.status === 'skipped' && record.annotations.some(a => a.type === 'blocked'))
  const status = blocked ? 'blocked' : record.status === 'skipped' ? 'skipped'
    : ['expected', 'flaky'].includes(record.outcome) ? 'passed' : 'failed'
  const title = record.title.replace(/^[^>]*> /, '') // drop the project prefix; it is kept separately
  return {
    key: `${adapter}:${record.project ?? ''}:${title}`, title, adapter, project: record.project ?? null,
    tags: record.tags ?? [], status, flaky: record.outcome === 'flaky', durationMs: record.durationMs ?? null, retries: record.retries ?? 0,
    startedAt: record.startedAt ?? null, errors: record.errors ?? [], annotations: record.annotations ?? [],
    skipReason: ['skipped','blocked'].includes(status) ? skipReason : null,
    evidence: (record.evidence ?? []).map(e => ({ name: e.name, path: `${evidenceBase}/${e.path}` })),
  }
}

export async function runPlaywrightStep(step, ctx) {
  const args = ['playwright', 'test', `--project=${step.project}`]
  if (step.grep) args.push('--grep', step.grep)
  if (step.grepInvert) args.push('--grep-invert', step.grepInvert)
  const env = {
    BASE_URL: ctx.targetUrl, QA_APP_ORIGIN: ctx.env.appOrigin, QA_CHAIN_ID: String(ctx.env.chainId), QA_CHAIN_NAME: ctx.env.chainName??'',
    QA_ALLOW_WRITES: ctx.env.allowWrites ? '1' : '0', QA_REPORT_DIR: ctx.stepDir, QA_ALLURE_RESULTS_DIR: join(ctx.runDir, 'allure-results'),
    QA_NAVIGATION: ctx.env.navigation??'', QA_ENVIRONMENT: ctx.env.name, QA_VERSION: ctx.versions.app.id, QA_RUN_LABEL: `${ctx.suite} (${ctx.runId})`,
    QA_WEB_FIXTURE_CONTAINER: ctx.env.isolated && (ctx.env.name === 'web-isolated' || ctx.env.stack?.verificationRuntime) ? `${ctx.env.stack.composeProject}-web-1` : '',
    CI: process.env.CI ?? '', FORCE_COLOR: '0',
  }
  const result = await runProcess('npx', args, { cwd: ROOT, env, timeoutMs: ctx.remainingMs(), logFile: join(ctx.stepDir, 'output.log'), echo: ctx.echo,
    passSecrets: true }) // the wallet fixture signs with QA_SEED_PHRASE; no other child receives it
  const summaryPath = join(ctx.stepDir, 'regression-summary.json')
  const evidenceBase = relative(ctx.runDir, ctx.stepDir).split('\\').join('/')
  const records = existsSync(summaryPath) ? JSON.parse(readFileSync(summaryPath, 'utf8')).records : []
  const tests = records.map(r => normalizeRecord(r, { evidenceBase }))
  const errors = []
  if (result.timedOut) errors.push(`Step timed out after ${Math.round(result.durationMs / 1000)}s; remaining tests were not run.`)
  if (!records.length && result.code !== 0) errors.push(`Playwright exited ${result.code ?? result.signal} without results: ${result.tail.slice(-1500)}`)
  return {
    tests, errors, timedOut: result.timedOut, exitCode: result.code, durationMs: result.durationMs,
    artifacts: { htmlReport: existsSync(join(ctx.stepDir, 'html/index.html')) ? `${evidenceBase}/html/index.html` : null, log: `${evidenceBase}/output.log` },
  }
}
