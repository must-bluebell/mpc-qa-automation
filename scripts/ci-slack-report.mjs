import { readFileSync, writeFileSync, statSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { sanitizeCiRun } from '../pipeline/lib/ci-report.mjs'
import { createRunDir } from '../pipeline/lib/run-store.mjs'
import { notifySavedRun } from './notify-saved-run.mjs'

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [mode, file, runId] = process.argv.slice(2)
    if (!['export', 'send'].includes(mode) || !file || !runId) throw new Error('Expected export/send, file and CI run ID')
    if (statSync(file).size > 8 * 1024 * 1024) throw new Error('CI report is too large')
    const run = sanitizeCiRun(JSON.parse(readFileSync(file, 'utf8')), runId, { suite: process.env.QA_EXPECTED_SUITE })
    if (mode === 'export') writeFileSync(process.env.QA_CI_REPORT_OUTPUT || 'ci-slack-report.json', JSON.stringify(run), { mode: 0o600 })
    else {
      createRunDir(runId)
      const ok = await notifySavedRun(run)
      console.log(ok ? 'Slack report delivered.' : 'Slack delivery pending or failed; test results are unchanged.')
      if (!ok) process.exitCode = 1
    }
  } catch { console.error('CI report validation or delivery failed; inspect private execution evidence.'); process.exitCode = 1 }
}
