import test from 'node:test'
import assert from 'node:assert/strict'
import { answerPullRequest } from '../../pipeline/slack-agent/pr-evidence.mjs'

const pr=(number,checks=[],extra={})=>({number,title:`QA change ${number}`,headRefName:'feature/qa',baseRefName:'main',
  headRefOid:'a'.repeat(40),statusCheckRollup:checks,...extra})
const check=(name,conclusion,completedAt)=>({__typename:'CheckRun',name,conclusion,status:'COMPLETED',completedAt,
  detailsUrl:'https://github.com/team/qa/actions/runs/123/job/456'})
const options=records=>({repository:'team/qa',exec:async(file,args)=>{
  assert.equal(file,'gh')
  assert.deepEqual(args,['pr','list','--repo','team/qa','--state','all','--limit','100','--search','sort:updated-desc',
    '--json','number,title,headRefName,baseRefName,headRefOid,mergedAt,mergedBy,mergeCommit,statusCheckRollup'])
  return {stdout:JSON.stringify(records)}
}})

test('last tested PR uses completed QA timestamps, excludes pending/skipped/unrelated checks and lists failed checks',async()=>{
  const records=[pr(1,[check('Wallet tests','FAILURE','2026-10-22T10:00:00Z')]),
    pr(2,[check('Wallet tests','SKIPPED','2026-10-23T10:00:00Z'),check('Deployment','SUCCESS','2026-10-23T10:00:00Z'),
      {...check('Automation self-checks','SUCCESS','2026-10-23T11:00:00Z'),status:'IN_PROGRESS'}]),
    pr(3,[check('Automation self-checks','SUCCESS','2026-10-22T09:00:00Z')])]
  const answer=await answerPullRequest('tested',options(records))
  assert.match(answer,/#1.*QA change 1/)
  assert.match(answer,/FAILURE.*Wallet tests/)
  assert.match(answer,/individual failed test cases.*not available/i)
  assert.match(answer,/latest 100/i)
  assert.doesNotMatch(answer,/#2|#3/)
})

test('application pre-merge status is evidence while a pending status is not completed testing',async()=>{
  const records=[pr(1,[{__typename:'StatusContext',context:'MPC QA / pre-merge',state:'FAILURE',createdAt:'2026-10-22T10:00:00Z'}]),
    pr(2,[{__typename:'StatusContext',context:'MPC QA / pre-merge',state:'PENDING',createdAt:'2026-10-23T10:00:00Z'}])]
  const answer=await answerPullRequest('tested',options(records))
  assert.match(answer,/#1.*QA change 1/)
  assert.match(answer,/FAILURE: MPC QA \/ pre-merge/)
  assert.doesNotMatch(answer,/#2/)
})

test('last merged PR uses merge time, reports merger and commit without guessing merge method',async()=>{
  const records=[pr(2,[],{mergedAt:'2026-10-22T10:00:00Z'}),pr(1,[],{mergedAt:'2026-10-23T10:00:00Z',
    title:'Fix QA <@UAPP> xoxb-private',mergedBy:{login:'reviewer'},mergeCommit:{oid:'b'.repeat(40)}})]
  const answer=await answerPullRequest('merged',options(records))
  assert.match(answer,/#1/)
  assert.match(answer,/reviewer/)
  assert.match(answer,/feature\/qa.*main/)
  assert.match(answer,/b{40}/)
  assert.match(answer,/merge method.*not recorded/i)
  assert.doesNotMatch(answer,/<@|xoxb-private/)
})

test('unavailable PR evidence never invents testing, merge details or leaks command errors',async()=>{
  assert.match(await answerPullRequest('tested',options([pr(1,[])])),/no completed QA/i)
  assert.match(await answerPullRequest('merged',options([pr(1,[])])),/no merged PR/i)
  assert.match(await answerPullRequest('tested',{repository:'bad;repo',exec:()=>{throw new Error('must not execute')}}),/configure/i)
  assert.match(await answerPullRequest('tested',{repository:'team/qa',exec:()=>{throw new Error('xoxb-private')}}),/unavailable/i)
  assert.doesNotMatch(await answerPullRequest('tested',{repository:'team/qa',exec:()=>{throw new Error('xoxb-private')}}),/xoxb-private/)
})
