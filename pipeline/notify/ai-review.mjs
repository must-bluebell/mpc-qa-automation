import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isRunId } from '../lib/run-store.mjs'
import { safeText } from '../lib/safe-output.mjs'

// Escape Slack mentions and publish only validated review fields, never raw diagnostics.
const text=value=>safeText(typeof value==='string'?value:'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')
const list=value=>Array.isArray(value)?value:[]
const refs=value=>list(value).map(text).join(', ')||'none'
export function splitThreadText(header,body) {
  const chunks=[];let current=''
  for(const line of body.split('\n')) {
    const parts=line.match(/.{1,3100}/gu)??['']
    for(const part of parts) {
      if(current.length+part.length+1>3200){chunks.push(current);current=''}
      current+=(current?'\n':'')+part
    }
  }
  if(current||!chunks.length)chunks.push(current)
  return chunks.map((chunk,i)=>`${header}${chunks.length>1?` (${i+1}/${chunks.length})`:''}\n\n${chunk}`)
}
export function renderAiReview(run,stateDir) {
  const header='*AI analysis*'
  if(run.ai?.status!=='ok')return [`${header}\n\nStatus: ${text(run.ai?.status||'not-requested')}. No accepted model analysis is available. Test outcomes are unchanged.`]
  let review
  try {
    if(!isRunId(run.runId))throw new Error('invalid ID')
    const path=join(stateDir,run.runId,'ai-analysis.json')
    if(!existsSync(path))throw new Error('missing review')
    review=JSON.parse(readFileSync(path,'utf8'))
    if(review.status!=='ok'||review.modelOutputValidated!==true||!['findings','duplicateGroups','scenarios'].every(k=>Array.isArray(review[k])))throw new Error('unvalidated review')
  }catch{return [`${header}\n\nThe validated AI artifact is unavailable. No detailed analysis is being claimed. Test outcomes are unchanged.`]}
  const lines=[`Model: ${text(run.ai.model||review.model||'configured model')}`, 'Validated against recorded evidence. AI advice does not change test results.', '', '*Summary*',text(review.summary),'','*Findings*']
  if(!review.findings.length)lines.push('No evidence-backed findings reported.')
  for(const [i,f] of review.findings.entries())lines.push(`${i+1}. ${text(f.title)} — ${text(f.classification)}`,`Evidence: ${refs(f.evidenceIds)} · Requirements: ${refs(f.requirementIds)}`,text(f.rationale),'')
  lines.push('','*Possible duplicate groups — hypotheses*')
  if(!review.duplicateGroups.length)lines.push('None proposed.')
  for(const g of review.duplicateGroups)lines.push(`Evidence: ${refs(g.evidenceIds)}`,text(g.rationale),'')
  lines.push('','*Proposed scenarios — not an acceptance check*')
  if(!review.scenarios.length)lines.push('None proposed.')
  for(const [i,s] of review.scenarios.entries())lines.push(`${i+1}. ${text(s.title)}`,`Requirements: ${refs(s.requirementIds)}`,...list(s.steps).map((step,j)=>`   ${j+1}) ${text(step)}`),`Expected: ${text(s.expectedResult)}`,'')
  return splitThreadText(header,lines.join('\n'))
}
