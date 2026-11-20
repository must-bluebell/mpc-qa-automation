import { existsSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { ROOT } from '../lib/env.mjs'
import { runProcess } from '../lib/proc.mjs'
import { prerequisiteReason } from '../lib/prerequisites.mjs'
import { assertApiWriteTarget } from '../../fixtures/api-case-config.mjs'
import { classifyFailure } from '../lib/classify.mjs'
import { warmBrowserRuntime } from './web-runtime.mjs'

/** Maps one regression-reporter record (utils/regression-reporter.ts) to the pipeline's test shape. */
export function normalizeRecord(record, { adapter = 'playwright', evidenceBase }) {
  const skipReason=(record.annotations??[]).find(a=>['skip','blocked'].includes(a.type))?.description??null
  const dependencyBlocked=record.status==='skipped'&&skipReason&&classifyFailure({status:'failed',errors:[skipReason]})?.kind==='infrastructure'
  const blocked = record.status === 'interrupted' || record.status === 'not-run'
    || dependencyBlocked || (record.status === 'skipped' && prerequisiteReason(skipReason)) || (record.status === 'skipped' && (record.annotations??[]).some(a => a.type === 'blocked'))
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

/** Final reports win; checkpoints recover completed and unstarted cases after a hard kill. */
export function readPlaywrightRecords(stepDir) {
  const summary = join(stepDir, 'regression-summary.json')
  if (existsSync(summary)) {
    try { const result = JSON.parse(readFileSync(summary, 'utf8')); if (Array.isArray(result.records)) return result.records }
    catch { /* A kill during final report writing must not discard completed checkpoints. */ }
  }
  const inventory = join(stepDir, 'execution-inventory.json')
  if (!existsSync(inventory)) return []
  const planned = JSON.parse(readFileSync(inventory, 'utf8')).records
  const completed = new Map()
  const journal = join(stepDir, 'execution-results.jsonl')
  if (existsSync(journal)) {
    for (const line of readFileSync(journal, 'utf8').split('\n').filter(Boolean)) {
      try { const record = JSON.parse(line); completed.set(record.id, record) }
      catch { /* A killed process may leave its final journal entry incomplete. */ }
    }
  }
  return planned.map(record => completed.get(record.id) ?? {...record,
    annotations: [...(record.annotations ?? []), {type:'blocked',description:'Runner stopped before this case completed.'}]})
}

/** Explicitly overwrite inherited flags; production authorization belongs only to this API step. */
export function apiWriteEnvironment(step, ctx) {
  const production = step.project === 'api' && ctx.productionApiWrites === true
  if (production) assertApiWriteTarget(ctx.env.baseUrl, '1', {productionApiWrites:true, environment:ctx.env.name})
  return {QA_ALLOW_WRITES: ctx.env.allowWrites || production ? '1' : '0', QA_PRODUCTION_API_WRITES: production ? '1' : '0'}
}

export async function runPlaywrightStep(step, ctx) {
  const args = ['playwright', 'test', `--project=${step.project}`]
  if (step.grep) args.push('--grep', step.grep)
  if (step.grepInvert) args.push('--grep-invert', step.grepInvert)
  const env = {
    BASE_URL: ctx.targetUrl, QA_APP_ORIGIN: ctx.env.appOrigin, QA_CHAIN_ID: String(ctx.env.chainId), QA_CHAIN_NAME: ctx.env.chainName??'',
    ...apiWriteEnvironment(step, ctx), QA_REPORT_DIR: ctx.stepDir, QA_ALLURE_RESULTS_DIR: join(ctx.runDir, 'allure-results'),
    QA_NAVIGATION: ctx.env.navigation??'', QA_ENVIRONMENT: ctx.env.name, QA_VERSION: ctx.versions.app.id, QA_RUN_LABEL: `${ctx.suite} (${ctx.runId})`,
    QA_WEB_FIXTURE_CONTAINER: ctx.env.isolated && (ctx.env.name === 'web-isolated' || ctx.env.stack?.verificationRuntime) ? `${ctx.env.stack.composeProject}-web-1` : '',
    // One retry for every pipeline case: timeouts on a slow page then show up as flaky, not as product failures.
    QA_RETRIES: '1',
    CI: process.env.CI ?? '', FORCE_COLOR: '0',
  }
  const evidenceBase = relative(ctx.runDir, ctx.stepDir).split('\\').join('/')
  // Discover with the same project and filters before network warmup or worker startup.
  const discovery = await runProcess('npx', [...args, '--list', '--reporter=list,./utils/regression-reporter.ts'], {
    cwd: ROOT, env: {...env, QA_DISCOVERY_ONLY:'1'}, timeoutMs: ctx.remainingMs(),
    logFile: join(ctx.stepDir, 'discovery.log'), echo: ctx.echo,
  })
  let startupError = discovery.code !== 0 ? `Playwright discovery failed: ${discovery.tail.slice(-1500)}` : null
  if (!startupError && step.project === 'chromium' && !ctx.seededDefect) {
    try { await warmBrowserRuntime(ctx.env,{timeoutMs:Math.min(60_000,ctx.remainingMs())}) }
    catch (error) { startupError = `Browser startup failed: ${error.message}` }
  }
  if (startupError) {
    const tests = readPlaywrightRecords(ctx.stepDir).map(record => normalizeRecord({...record,
      annotations:[...(record.annotations ?? []), {type:'blocked',description:startupError}],
    }, {evidenceBase}))
    // Replace the generic interruption reason with the actionable startup cause.
    for (const item of tests) item.skipReason = startupError
    return {tests, errors:[startupError], timedOut:discovery.timedOut, exitCode:1,
      durationMs:discovery.durationMs, artifacts:{htmlReport:null,log:`${evidenceBase}/discovery.log`}}
  }
  const result = await runProcess('npx', args, { cwd: ROOT, env: {...env, QA_DISCOVERY_ONLY:'0'}, timeoutMs: ctx.remainingMs(), logFile: join(ctx.stepDir, 'output.log'), echo: ctx.echo,
    passSecrets: ['QA_SEED_PHRASE'] }) // Signing workers never inherit Slack, AI or repository credentials.
  const records = readPlaywrightRecords(ctx.stepDir)
  const tests = records.map(r => normalizeRecord(r, { evidenceBase }))
  const errors = []
  if (result.timedOut) errors.push(`Step timed out after ${Math.round(result.durationMs / 1000)}s; remaining tests were not run.`)
  if (!records.length && result.code !== 0) errors.push(`Playwright exited ${result.code ?? result.signal} without results: ${result.tail.slice(-1500)}`)
  return {
    tests, errors, timedOut: result.timedOut, exitCode: result.code, durationMs: result.durationMs,
    artifacts: { htmlReport: existsSync(join(ctx.stepDir, 'html/index.html')) ? `${evidenceBase}/html/index.html` : null, log: `${evidenceBase}/output.log` },
  }
}
