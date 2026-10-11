import { readFileSync, writeFileSync, copyFileSync, appendFileSync, constants } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function planGitHubRun(name,event,{appRepository,appRef='main'}={}) {
  if(!/^[\w.-]+\/[\w.-]+$/.test(appRepository??''))throw new Error('Set WEBAPP_REPOSITORY to the application owner/repository in GitHub Actions variables.')
  let suite
  if(name==='push')suite='regression'
  else if(name==='schedule')suite=({'0 */4 * * *':'api','0 1 * * *':'load'})[event.schedule]
  else if(name==='workflow_dispatch') {suite=event.inputs?.suite??'regression';appRef=event.inputs?.app_ref||appRef}
  else if(name==='repository_dispatch'&&event.action==='webapp-merged') {
    if(event.client_payload?.repository!==appRepository||!/^([a-f0-9]{40}|[a-f0-9]{64})$/i.test(event.client_payload?.sha??''))throw new Error('App merge dispatch must identify the configured repository and its exact commit SHA.')
    suite='full';appRef=event.client_payload.sha
  }
  if(!['regression','api','load','uat','full'].includes(suite))throw new Error('Unsupported GitHub trigger or suite.')
  if(!/^(?!-)[\w./-]{1,200}$/.test(appRef))throw new Error('Invalid application ref.')
  return {suite,appRepository,appRef}
}
export function ciProfile(profile,runId,attempt) {
  if(!/^\d+$/.test(runId??'')||!/^\d+$/.test(attempt??''))throw new Error('Expected numeric GitHub run ID and attempt.')
  return {...profile,stack:{...profile.stack,composeProject:`mpc-qa-ci-${runId}-${attempt}`,webmpcPath:'../WEB MPC'}}
}
export async function verifyAppAccess({appRepository,appRef='main',token,fetchImpl=fetch}) {
  if(!/^[\w.-]+\/[\w.-]+$/.test(appRepository??''))throw new Error('Set WEBAPP_REPOSITORY to the application owner/repository.')
  if(!token)throw new Error(`Set secret WEBAPP_READ_TOKEN with Contents: read access to ${appRepository}. The QA repository GITHUB_TOKEN cannot read a different private repository.`)
  const response=await fetchImpl(`https://api.github.com/repos/${appRepository}/commits/${encodeURIComponent(appRef)}`,{
    headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json'},signal:AbortSignal.timeout(20_000),redirect:'error',
  })
  if(!response.ok)throw new Error(`Application checkout preflight failed (HTTP ${response.status}) for ${appRepository} at ${appRef}. Check WEBAPP_READ_TOKEN: it must be unexpired, approved by the application organization when required, and have Contents: read on this repository. Verify WEBAPP_REPOSITORY and the requested branch or commit also exist.`)
  const {sha}=await response.json()
  return {sha}
}
async function main() {
  if(process.env.GITHUB_ACTIONS!=='true')throw new Error('This setup command is only for a disposable GitHub Actions checkout.')
  if(process.argv[2]==='plan') {
    const event=JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH,'utf8'))
    const plan=planGitHubRun(process.env.GITHUB_EVENT_NAME,event,{appRepository:process.env.WEBAPP_REPOSITORY,appRef:process.env.WEBAPP_REF||'main'})
    appendFileSync(process.env.GITHUB_OUTPUT,Object.entries(plan).map(([k,v])=>`${k}=${v}\n`).join(''))
  } else if(process.argv[2]==='verify-access') {
    const result=await verifyAppAccess({appRepository:process.env.APP_REPOSITORY,appRef:process.env.APP_REF,token:process.env.GH_TOKEN})
    console.log(`Application revision is readable: ${result.sha}`)
  } else if(process.argv[2]==='prepare') {
    const root=resolve(fileURLToPath(new URL('..',import.meta.url)))
    if(root!==resolve(process.env.GITHUB_WORKSPACE??'', 'qa'))throw new Error('Expected qa checkout inside GITHUB_WORKSPACE.')
    const path=resolve(root,'pipeline/config/environments.json'),all=JSON.parse(readFileSync(path,'utf8'))
    all['local-docker']=ciProfile(all['local-docker'],process.env.GITHUB_RUN_ID,process.env.GITHUB_RUN_ATTEMPT)
    // Copy only the application's committed public development fixtures, never the user's .env.
    const app=resolve(root,'../WEB MPC')
    copyFileSync(resolve(app,'docker/.env.example'),resolve(app,'docker/.env'),constants.COPYFILE_EXCL)
    writeFileSync(path,JSON.stringify(all,null,2)+'\n')
  } else throw new Error('Expected plan, verify-access or prepare.')
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  main().catch(error=>{console.error(error.message);process.exitCode=1})
}
