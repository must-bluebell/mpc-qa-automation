import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { readCiReport, unavailableCiRun } from '../pipeline/lib/ci-report.mjs'
import { join } from 'node:path'
import { createRunDir } from '../pipeline/lib/run-store.mjs'
import { notifySavedRun } from './notify-saved-run.mjs'

export async function deliverCiReport(run, { create=createRunDir, notify=notifySavedRun }={}) {
  const dir=create(run.runId)
  if(run.ai.status==='ok')writeFileSync(join(dir,'ai-analysis.json'),JSON.stringify(run.ai.review),{mode:0o600})
  return notify(run)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [mode, file, runId] = process.argv.slice(2)
    if (!['export', 'send'].includes(mode) || !file || !runId) throw new Error('Expected export/send, file and CI run ID')
    let run
    try { run=readCiReport(file,runId,{suite:process.env.QA_EXPECTED_SUITE}) } catch(error) {
      if(mode!=='send'||error.code!=='ENOENT')throw error
      run=unavailableCiRun(runId,process.env.QA_EXPECTED_SUITE,process.env.QA_APP_REF)
    }
    if (mode === 'export') writeFileSync(process.env.QA_CI_REPORT_OUTPUT || 'ci-slack-report.json', JSON.stringify(run), { mode: 0o600 })
    else {
      const ok = await deliverCiReport(run)
      console.log(ok ? 'Slack report delivered.' : 'Slack delivery pending or failed; test results are unchanged.')
      if (!ok) process.exitCode = 1
    }
  } catch { console.error('CI report validation or delivery failed; inspect private execution evidence.'); process.exitCode = 1 }
}
