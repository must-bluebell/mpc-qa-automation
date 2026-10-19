import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const marker='<!-- mpc-qa-pre-merge -->'
function client(token,fetchImpl) {
  if(!token)throw new Error('Set the application GitHub token for PR read access or report publication.')
  return async (path,{method='GET',body}={})=>{
    const response=await fetchImpl(`https://api.github.com${path}`,{
      method,headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','Content-Type':'application/json','X-GitHub-Api-Version':'2022-11-28'},
      ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000),redirect:'error',
    })
    if(!response.ok)throw new Error(`GitHub PR reporting request failed (HTTP ${response.status}). Check repository access and token permissions.`)
    return response.json()
  }
}
function validate(plan) {
  if(!/^[\w.-]+\/[\w.-]+$/.test(plan.appRepository??'')||!/^([a-f0-9]{40}|[a-f0-9]{64})$/i.test(plan.appRef??'')||!Number.isSafeInteger(plan.prNumber)||plan.prNumber<1)throw new Error('Expected application repository, exact PR SHA and PR number.')
}
export async function verifyPullRequest(plan,{token,fetchImpl=fetch,allowStale=false}={}) {
  validate(plan)
  const pr=await client(token,fetchImpl)(`/repos/${plan.appRepository}/pulls/${plan.prNumber}`)
  if(pr.number!==plan.prNumber||pr.head?.repo?.full_name!==plan.appRepository)throw new Error('PR must belong to the configured application repository; fork code is not allowed in this credential-bearing runner.')
  if(!allowStale&&(pr.state!=='open'||pr.head.sha!==plan.appRef))throw new Error('PR must be open and dispatch must match its current head SHA; request checks again for the latest revision.')
  return pr
}
export async function reportPullRequest(plan,{token,runUrl,phase,results={},fetchImpl=fetch}={}) {
  validate(plan)
  if(!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+$/.test(runUrl??''))throw new Error('Expected a hosted GitHub Actions run URL.')
  if(!['pending','complete'].includes(phase))throw new Error('Expected pending or complete PR reporting phase.')
  const pr=await verifyPullRequest(plan,{token,fetchImpl,allowStale:phase==='complete'})
  const api=client(token,fetchImpl),base=`/repos/${plan.appRepository}`
  const passed=results.qa==='success'&&results['code-security']==='success'
  const state=phase==='pending'?'pending':passed?'success':'failure'
  await api(`${base}/statuses/${plan.appRef}`,{method:'POST',body:{state,context:'MPC QA / pre-merge',
    description:phase==='pending'?'QA is running for this PR revision.':passed?'Code/security and full QA passed.':'QA failed, was cancelled, or did not finish. See report.',target_url:runUrl}})
  // Old runs may finish after a new commit: their status belongs to that SHA only.
  if(phase==='pending'||pr.state!=='open'||pr.head.sha!==plan.appRef)return {state,commented:false}
  const comments=[]
  for(let page=1;;page++) {
    const batch=await api(`${base}/issues/${plan.prNumber}/comments?per_page=100&page=${page}`)
    comments.push(...batch)
    if(batch.length<100)break
  }
  const actor=await api('/user')
  const existing=comments.find(c=>c.user?.login===actor.login&&c.body?.includes(marker))
  const outcome=value=>['success','failure','cancelled','skipped'].includes(value)?value:'not completed'
  const body=[marker,'### MPC QA before merge',`Commit: \`${plan.appRef}\``,
    `Code and security: ${outcome(results['code-security'])}`,`Full QA: ${outcome(results.qa)}`,
    'Full QA includes API, web regression, UAT and controlled load on a disposable stack.',
    `[View report, job results and sanitized downloadable artifact](${runUrl})`,
    'Review failing, skipped and blocked checks in the report before merging.'].join('\n\n')
  await api(existing?`${base}/issues/comments/${existing.id}`:`${base}/issues/${plan.prNumber}/comments`,{method:existing?'PATCH':'POST',body:{body}})
  return {state,commented:true}
}
async function main() {
  if(process.env.GITHUB_ACTIONS!=='true')throw new Error('PR reporting is only run from GitHub Actions.')
  const {planGitHubRun}=await import('./github-qa.mjs')
  const event=JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH,'utf8'))
  const plan=planGitHubRun(process.env.GITHUB_EVENT_NAME,event,{appRepository:process.env.WEBAPP_REPOSITORY})
  await reportPullRequest(plan,{token:process.env.WEBAPP_REPORT_TOKEN,runUrl:process.env.QA_GITHUB_RUN_URL,phase:process.argv[2],results:JSON.parse(process.env.QA_JOB_RESULTS||'{}')})
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1})
