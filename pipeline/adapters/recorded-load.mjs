import { readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { ROOT } from '../lib/env.mjs'
import { runProcess } from '../lib/proc.mjs'
import { assertLoadAllowed } from './k6.mjs'

export function normalizeRecordedLoad(plan, report, evidenceBase) {
  return plan.cases.filter(row => !row.excluded).map(row => {
    const samples = report.samples.filter(sample => sample.id === row.id)
    const invalid = samples.some(sample => !sample.ok || !row.statuses.includes(sample.status)
      || !Number.isFinite(sample.durationMs) || sample.durationMs < 0)
    const reason = row.blocked || (!samples.length ? 'No measured request: a required scenario or fixture did not complete.' : null)
    const status = reason ? 'blocked' : invalid ? 'failed' : 'passed'
    const route = row.sourcePath === row.path ? row.sourcePath : `${row.sourcePath} → ${row.path}`
    return { key: `recorded:${row.id}`, title: `${row.id} ${row.method} ${route} (${row.target})`,
      adapter: 'recorded-load', project: 'recorded-journey', tags: ['@load'], status,
      durationMs: samples.length ? samples.reduce((sum, sample) => sum + sample.durationMs, 0) : null,
      retries: 0, errors: reason ? [reason] : invalid ? ['A measured request failed its HTTP or JSON-RPC assertion.'] : [],
      annotations: [{ type: 'measurement', description: `${samples.length} request samples; original recording: one user, one loop. Timings are not concurrent p95 measurements.` },
        ...(row.adaptation ? [{ type: 'adaptation', description: row.adaptation }] : [])],
      evidence: [{ name: 'Recorded request timings and source mapping', path: `${evidenceBase}/recorded-results.json` }],
    }
  })
}

export async function runRecordedLoadStep(step, ctx) {
  assertLoadAllowed(ctx.env, ctx.targetUrl)
  if (!ctx.env.stack?.verificationRuntime || ctx.seededDefect) throw new Error('Recorded journeys require the managed isolated stack without seeded faults')
  const plan = JSON.parse(readFileSync(join(ROOT, 'load/recorded/mpc-recording.json'), 'utf8'))
  const budget = Math.max(1000, Math.min(480_000, ctx.remainingMs() - 10_000))
  const result = await runProcess('docker', ['exec', '-e', `QA_RECORDED_PLAN=${Buffer.from(JSON.stringify(plan)).toString('base64')}`,
    '-e', `QA_RECORDED_TIMEOUT_MS=${budget}`, `${ctx.env.stack.composeProject}-web-1`, 'node', '/qa-runtime/recorded-load.mjs'], {
    cwd: ROOT, timeoutMs: budget + 5000, logFile: join(ctx.stepDir, 'output.log'), echo: ctx.echo,
  })
  const log = readFileSync(join(ctx.stepDir, 'output.log'), 'utf8')
  const line = log.split('\n').findLast(line => line.startsWith('MPC_RECORDED_RESULT:'))
  const report = line ? JSON.parse(line.slice('MPC_RECORDED_RESULT:'.length)) : { samples: [], errors: ['Recorded journey worker produced no results.'] }
  writeFileSync(join(ctx.stepDir, 'recorded-results.json'), JSON.stringify({ source: plan.source, sourceSha256: plan.sourceSha256,
    cases: plan.cases, ...report }, null, 2))
  const base = relative(ctx.runDir, ctx.stepDir).split('\\').join('/')
  return { tests: normalizeRecordedLoad(plan, report, base), errors: [...report.errors,
    ...(plan.cases.some(row => row.blocked && !row.excluded) ? ['The source recording includes an obsolete endpoint without current local coverage; see the blocked source case.'] : []),
    ...(result.code !== 0 ? ['Recorded journey execution did not complete successfully.'] : [])],
    timedOut: result.timedOut, exitCode: result.code, artifacts: { log: `${base}/output.log` } }
}
