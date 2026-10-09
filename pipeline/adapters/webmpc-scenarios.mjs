import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { ROOT, config } from '../lib/env.mjs'
import { runProcess } from '../lib/proc.mjs'
import { stackPortEnv } from './local-stack.mjs'

/**
 * Runs WEB MPC's own local scenario suite (test/scenario/local) unchanged against the isolated stack.
 * Output, traces and the JSON report go into this run's folder; nothing is written into the app repo's
 * report folders. Scenario tests assert receipts, balances, DB state and Activity, so they are the
 * evidence for the dig → send cart → confirm → recover journey.
 */
const TAGS_BY_TITLE = [
  [/My Mine lifecycle|mining draws/, ['@feature-mine', '@critical']],
  [/SIWE, community, email and SBT|registration and on-chain SBT/, ['@feature-membership', '@critical']],
  [/check-in|quizzes/, ['@feature-checkin', '@critical']],
  [/quest/i, ['@feature-quests', '@critical']],
  [/vote/i, ['@feature-vote', '@critical']],
  [/venture/i, ['@feature-ventures']],
  [/admin/i, ['@feature-admin', '@critical']],
  [/contracts are ready/, ['@feature-chain', '@preflight']],
]

function walk(suite, file, out) {
  for (const spec of suite.specs ?? []) for (const test of spec.tests ?? []) out.push({ spec, test, file: spec.file ?? file })
  for (const child of suite.suites ?? []) walk(child, child.file ?? file, out)
  return out
}

export async function runWebmpcStep(step, ctx) {
  const webmpc = resolve(ROOT, ctx.env.stack?.webmpcPath ?? '../WEB MPC')
  if (!existsSync(join(webmpc, 'playwright.local.config.ts'))) {
    return { tests: [], errors: [`WEB MPC checkout not found at ${webmpc}`], infra: 'WEB MPC checkout missing' }
  }
  const json = join(ctx.stepDir, 'results.json')
  const args = ['exec', 'playwright', 'test', '--config=playwright.local.config.ts', '--reporter=list,json,html', `--output=${join(ctx.stepDir, 'test-results')}`]
  if (step.project) args.push(`--project=${step.project}`)
  if (step.noDeps) args.push('--no-deps')
  const env = {
    PLAYWRIGHT_JSON_OUTPUT_FILE: json, PLAYWRIGHT_HTML_OUTPUT_DIR: join(ctx.stepDir, 'html'), PLAYWRIGHT_HTML_OPEN: 'never',
    SCENARIO_COMPOSE_PROJECT: ctx.env.stack?.composeProject ?? 'mpc-qa', SCENARIO_BASE_URL: ctx.env.baseUrl, FORCE_COLOR: '0',
    ...stackPortEnv(ctx.env),
  }
  // Host-side scenario wallets must reach the same Anvil nodes the app uses, not the 8545/8546 defaults.
  const ports = ctx.env.stack?.ports ?? {}
  if (ports.anvil) env.SCENARIO_BSC_RPC = `http://localhost:${ports.anvil}`
  if (ports.opbnbAnvil) env.SCENARIO_OPBNB_RPC = `http://localhost:${ports.opbnbAnvil}`
  const result = await runProcess('pnpm', args, { cwd: webmpc, env, timeoutMs: ctx.remainingMs(), logFile: join(ctx.stepDir, 'output.log'), echo: ctx.echo })
  const base = relative(ctx.runDir, ctx.stepDir).split('\\').join('/')
  const errors = []
  if (result.timedOut) errors.push('WEB MPC scenario step timed out; remaining scenarios were not run.')
  if (!existsSync(json)) {
    errors.push(`WEB MPC scenarios produced no report (exit ${result.code ?? result.signal}): ${result.tail.slice(-1500)}`)
    return { tests: [], errors, timedOut: result.timedOut, infra: /docker|compose|ECONNREFUSED/i.test(result.tail) ? 'docker stack unavailable' : null }
  }
  const report = JSON.parse(readFileSync(json, 'utf8'))
  const rows = []
  for (const suite of report.suites ?? []) walk(suite, suite.file, rows)
  const evidenceDir = join(ctx.stepDir, 'evidence')
  mkdirSync(evidenceDir, { recursive: true })
  const tests = rows.map(({ spec, test, file }, i) => {
    const last = test.results.at(-1) ?? {}
    const evidence = []
    for (const [j, a] of (last.attachments ?? []).entries()) {
      if (a.path && isAbsolute(a.path) && a.path.startsWith(ctx.runDir)) evidence.push({ name: a.name, path: relative(ctx.runDir, a.path).split('\\').join('/') })
      else if (a.body) {
        const name = `${i}-${j}-${a.name.replace(/[^\w.-]/g, '_')}`
        writeFileSync(join(evidenceDir, name), Buffer.from(a.body, 'base64'))
        evidence.push({ name: a.name, path: `${base}/evidence/${name}` })
      }
    }
    const out = (last.stdout ?? []).map(s => s.text ?? '').join('')
    if (out) {
      const name = `${i}-stdout.log`
      writeFileSync(join(evidenceDir, name), out)
      evidence.push({ name: 'scenario stdout', path: `${base}/evidence/${name}` })
    }
    const status = test.status === 'skipped' ? (last.status === 'skipped' ? 'skipped' : 'blocked')
      : ['expected', 'flaky'].includes(test.status) ? 'passed' : last.status === 'interrupted' ? 'blocked' : 'failed'
    const extraTags = TAGS_BY_TITLE.filter(([re]) => re.test(spec.title)).flatMap(([, tags]) => tags)
    return {
      key: `webmpc:${test.projectName}:${spec.title}`, title: `${file} > ${spec.title}`, adapter: 'webmpc-scenarios', project: test.projectName,
      tags: [...new Set(['@uat', '@api', '@regression', ...extraTags, ...(spec.tags ?? []).map(t => (t.startsWith('@') ? t : `@${t}`))])],
      status, flaky: test.status === 'flaky', durationMs: test.results.reduce((s, r) => s + (r.duration ?? 0), 0), retries: Math.max(0, test.results.length - 1),
      startedAt: last.startTime ?? null, errors: (last.errors ?? []).map(e => (e.message ?? String(e)).slice(0, 6_000)),
      annotations: test.annotations ?? [], evidence,
    }
  })
  for (const e of report.errors ?? []) errors.push((e.message ?? String(e)).slice(0, 2_000))
  return {
    tests, errors, timedOut: result.timedOut, exitCode: result.code, durationMs: result.durationMs,
    artifacts: { htmlReport: existsSync(join(ctx.stepDir, 'html/index.html')) ? `${base}/html/index.html` : null, log: `${base}/output.log` },
  }
}

export const _private = { TAGS_BY_TITLE, config }
