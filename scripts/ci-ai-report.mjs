import { mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { analyzeRun } from '../pipeline/ai/analyze.mjs'
import { sanitizeCiRun, readCiReport, formatCiReport, unavailableCiRun } from '../pipeline/lib/ci-report.mjs'

/** Restore a dedicated CI login, never the developer's normal credential directory. */
export async function restoreCodexAuth(raw, home) {
  let auth
  try { auth=JSON.parse(raw) } catch { throw new Error('Configure a file-backed managed ChatGPT login for CI.') }
  if(typeof raw!=='string'||raw.length>64000||auth?.auth_mode!=='chatgpt'
    ||!['access_token','id_token','refresh_token'].every(k=>typeof auth.tokens?.[k]==='string'&&auth.tokens[k].length>0)
    ||!isAbsolute(home??'')) throw new Error('Configure a valid managed ChatGPT login and absolute CODEX_HOME for CI.')
  try { await mkdir(home,{mode:0o700}) } catch { throw new Error('Codex CI login requires a fresh private directory.') }
  await writeFile(join(home,'auth.json'),JSON.stringify(auth),{mode:0o600,flag:'wx'})
}

async function analyze(run,dir) {
  const result=await analyzeRun(run,dir)
  let review
  if(result.status==='ok') {
    const path=join(dir,'ai-analysis.json')
    if((await stat(path)).size>1_048_576)throw new Error('Oversized analysis')
    review=JSON.parse(await readFile(path,'utf8'))
  }
  return {result,review}
}

export async function reviewCiRun(raw,runId,{dir,auth=process.env.CODEX_AUTH_JSON,codexHome=process.env.CODEX_HOME,
  persistConfigured=process.env.CODEX_AUTH_PERSIST_CONFIGURED==='true',analyze:review=analyze}={}) {
  const run=sanitizeCiRun(raw,runId)
  run.ai={status:'not-requested'}
  if(!run.tests.some(t=>['passed','failed'].includes(t.status))) return sanitizeCiRun(run,runId)
  if(!auth||!persistConfigured) {
    run.ai={status:'not-configured'}
    return sanitizeCiRun(run,runId)
  }
  try {
    await restoreCodexAuth(auth,codexHome)
    const {result,review:analysis}=await review(run,dir)
    run.ai={...result,...(analysis?{review:analysis}:{})}
  } catch { run.ai={status:'rejected'} }
  return sanitizeCiRun(run,runId)
}

async function main() {
  if(process.env.GITHUB_ACTIONS!=='true')throw new Error('CI analysis runs only in GitHub Actions.')
  const [file,runId]=process.argv.slice(2)
  let raw
  try { raw=readCiReport(file,runId,{suite:process.env.QA_EXPECTED_SUITE}) } catch {
    raw=unavailableCiRun(runId,process.env.QA_EXPECTED_SUITE,process.env.QA_APP_REF)
  }
  const dir=join(process.cwd(),'ci-ai-private')
  await mkdir(dir,{recursive:true,mode:0o700})
  const run=await reviewCiRun(raw,runId,{dir})
  await writeFile('ci-review-report.json',JSON.stringify(run),{mode:0o600})
  const markdown=formatCiReport(run)
  await writeFile('ci-review-report.md',markdown+'\n',{mode:0o600})
  if(process.env.GITHUB_STEP_SUMMARY)appendFileSync(process.env.GITHUB_STEP_SUMMARY,markdown+'\n')
  console.log(`AI review status: ${run.ai.status}. QA status: ${run.status}.`)
  if(run.ai.status!=='ok')process.exitCode=1
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) main().catch(()=>{
  console.error('CI AI report could not be prepared; inspect the trusted workflow setup.')
  process.exitCode=1
})
