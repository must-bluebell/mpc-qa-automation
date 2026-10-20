import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, RUNS_DIR } from './env.mjs'
import { runProcess } from './proc.mjs'

/** Where each run's Allure site is written. Only this tree may be served at QA_ALLURE_BASE_URL. */
export const ALLURE_DIR = join(RUNS_DIR, 'allure')

/**
 * Builds runs/allure/<runId>/ from the Playwright steps' allure-results. Never throws: a missing or failed
 * report must not change the run's outcome or block Slack delivery; the reason is kept on the run record.
 */
export async function generateAllureReport(runId, runDir, { echo = true, timeoutMs = 120_000 } = {}) {
  const results = join(runDir, 'allure-results')
  if (!existsSync(results) || !readdirSync(results).length) return { generated: false, reason: 'no Allure results (no Playwright steps ran)' }
  mkdirSync(ALLURE_DIR, { recursive: true, mode: 0o700 })
  const output = join(ALLURE_DIR, runId)
  const result = await runProcess('npx', ['allure', 'generate', results, '--config', join(ROOT, 'allurerc.mjs'), '--output', output, '--report-name', `MPC QA ${runId}`],
    { cwd: ROOT, env: { QA_ALLURE_HISTORY: join(ALLURE_DIR, 'history.jsonl') }, timeoutMs, logFile: join(runDir, 'allure.log'), echo })
  const generated = result.code === 0 && existsSync(join(output, 'index.html'))
  return generated ? { generated, path: `allure/${runId}/index.html` }
    : { generated, reason: result.timedOut ? 'allure generate timed out' : `allure generate exited ${result.code ?? result.signal}` }
}
