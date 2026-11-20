import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { safeText } from '../lib/safe-output.mjs'

const execute=promisify(execFile)
const clean=value=>safeText(String(value??'')).replace(/[<>&`@\r\n]/g,'').slice(0,180)
const timestamp=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?Date.parse(value):0
const qaNames=new Set(['MPC QA / pre-merge','Automation self-checks','Wallet tests','qa'])
function completedChecks(pr) {
  return (pr.statusCheckRollup||[]).filter(check=>qaNames.has(check.name||check.context)
    && (check.__typename==='StatusContext'
      ? ['SUCCESS','FAILURE','ERROR'].includes(check.state)&&timestamp(check.createdAt)
      : check.status==='COMPLETED'&&['SUCCESS','FAILURE','TIMED_OUT','CANCELLED','ACTION_REQUIRED','STARTUP_FAILURE'].includes(check.conclusion)&&timestamp(check.completedAt)))
}
const checkTime=check=>timestamp(check.completedAt||check.createdAt)

// Only a fixed read-only command runs; questions never supply command arguments or repository names.
export async function answerPullRequest(kind,{repository,exec=execute}={}) {
  if(!/^[\w.-]+\/[\w.-]+$/.test(repository||''))
    return 'Configure QA_SLACK_PR_REPOSITORY with the QA reporting repository before requesting PR evidence.'
  let prs
  try {
    const {stdout}=await exec('gh',['pr','list','--repo',repository,'--state','all','--limit','100','--search','sort:updated-desc',
      '--json','number,title,headRefName,baseRefName,headRefOid,mergedAt,mergedBy,mergeCommit,statusCheckRollup'],
    {timeout:20000,maxBuffer:4*1024*1024,env:{...process.env,GH_HOST:'github.com',GH_PROMPT_DISABLED:'1'}})
    prs=JSON.parse(stdout)
    if(!Array.isArray(prs))throw new Error('Invalid PR evidence')
    prs=prs.filter(pr=>Number.isSafeInteger(pr.number)&&pr.number>0)
  } catch {
    return 'GitHub PR evidence is unavailable. Check GitHub CLI installation, authentication, and read access to the configured repository. No PR testing or merge outcome is inferred.'
  }
  const scope=`Repository: ${repository}. Scope: latest 100 updated PRs and their current-head checks.`
  const pr=kind==='merged'
    ? prs.filter(pr=>timestamp(pr.mergedAt)).sort((a,b)=>timestamp(b.mergedAt)-timestamp(a.mergedAt))[0]
    : prs.filter(pr=>completedChecks(pr).length).sort((a,b)=>Math.max(...completedChecks(b).map(checkTime))-Math.max(...completedChecks(a).map(checkTime)))[0]
  if(!pr)return `${scope}\n${kind==='merged'?'No merged PR':'No completed QA check for a tested PR'} was found in this scope.`
  const link=`https://github.com/${repository}/pull/${pr.number}`
  const lines=[`${kind==='merged'?'Last merged PR':'Last tested PR'}: #${pr.number} — ${clean(pr.title)}`,link,scope]
  if(kind==='merged') {
    lines.push(`Merged by: ${clean(pr.mergedBy?.login)||'Not recorded'}. Merged at: ${clean(pr.mergedAt)}.`,
      `Branches: ${clean(pr.headRefName)} → ${clean(pr.baseRefName)}.`,
      `Merge commit: ${/^[a-f0-9]{40,64}$/i.test(pr.mergeCommit?.oid||'')?pr.mergeCommit.oid:'Not recorded'}.`,
      'Merge method (merge commit, squash, or rebase): not recorded in this PR metadata; no method is inferred.')
  } else {
    const checks=completedChecks(pr).sort((a,b)=>checkTime(b)-checkTime(a))
    lines.push(`Latest completed QA check: ${new Date(checkTime(checks[0])).toISOString()}.`)
    for(const check of checks.slice(0,12)) {
      lines.push(`${clean(check.conclusion||check.state)}: ${clean(check.name||check.context)}`)
      const url=check.detailsUrl||check.targetUrl
      if(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+(?:\/job\/\d+)?$/.test(url||''))lines.push(url)
    }
    lines.push('Individual failed test cases are not available in PR check metadata. See the linked QA report for case-level evidence. Local run failures are reported separately; they are not attributed to this PR.')
  }
  return lines.join('\n').slice(0,2800)
}
