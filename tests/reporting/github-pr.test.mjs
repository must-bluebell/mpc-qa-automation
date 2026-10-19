import test from 'node:test'
import assert from 'node:assert/strict'
import { verifyPullRequest, reportPullRequest } from '../../scripts/github-pr.mjs'

const sha='a'.repeat(40)
const plan={appRepository:'team/web-app',appRef:sha,prNumber:17,suite:'full'}
const pr={number:17,state:'open',head:{sha,repo:{full_name:'team/web-app'}}}
const runUrl='https://github.com/team/qa/actions/runs/123'
function api(responses) {
  const calls=[]
  return {calls,fetchImpl:async (url,options)=>{
    calls.push({url,...options,body:options.body&&JSON.parse(options.body)})
    const data=responses.shift()
    assert.notEqual(data,undefined,`Unexpected request ${url}`)
    return {ok:true,json:async()=>data}
  }}
}
test('preflight verifies open same-repository PR and exact current head',async()=>{
  const mock=api([pr]); await verifyPullRequest(plan,{token:'read',...mock})
  assert.equal(mock.calls[0].url,'https://api.github.com/repos/team/web-app/pulls/17')
  for(const bad of [{...pr,state:'closed'},{...pr,head:{...pr.head,sha:'b'.repeat(40)}},{...pr,head:{...pr.head,repo:{full_name:'fork/app'}}}]) {
    await assert.rejects(verifyPullRequest(plan,{token:'read',...api([bad])}),/open|head|repository/i)
  }
  await assert.rejects(verifyPullRequest(plan,{...api([])}),/token/i)
})
test('pending check targets the exact PR SHA and a hosted GitHub report',async()=>{
  const mock=api([pr,{}])
  await reportPullRequest(plan,{token:'write',runUrl,phase:'pending',...mock})
  assert.ok(mock.calls[1].url.endsWith(`/statuses/${sha}`))
  assert.deepEqual(mock.calls[1].body,{state:'pending',context:'MPC QA / pre-merge',description:'QA is running for this PR revision.',target_url:runUrl})
})
test('successful gates update an existing bot report, including pagination',async()=>{
  const marker='<!-- mpc-qa-pre-merge -->'
  const mock=api([pr,{},Array.from({length:100},(_,id)=>({id,body:'other'})),[{id:72,body:marker,user:{login:'qa-bot'}}],{login:'qa-bot'},{}])
  await reportPullRequest(plan,{token:'write',runUrl,phase:'complete',results:{qa:'success','code-security':'success'},...mock})
  assert.equal(mock.calls[1].body.state,'success')
  assert.ok(mock.calls.at(-1).url.endsWith('/issues/comments/72'))
  assert.match(mock.calls.at(-1).body.body,/Code and security: success/)
  assert.match(mock.calls.at(-1).body.body,/Full QA: success/)
  assert.match(mock.calls.at(-1).body.body,/actions\/runs\/123/)
})
test('failure, skipped and cancelled jobs cannot produce a passing PR check',async()=>{
  for(const outcome of ['failure','skipped','cancelled']) {
    const mock=api([pr,{},[],{login:'qa-bot'},{}])
    await reportPullRequest(plan,{token:'write',runUrl,phase:'complete',results:{qa:outcome,'code-security':'success'},...mock})
    assert.equal(mock.calls[1].body.state,'failure')
    assert.ok(mock.calls.at(-1).url.endsWith('/issues/17/comments'))
  }
})
test('older PR revisions finish their own status but do not overwrite the latest comment',async()=>{
  const mock=api([{...pr,head:{...pr.head,sha:'b'.repeat(40)}},{}])
  await reportPullRequest(plan,{token:'write',runUrl,phase:'complete',results:{qa:'failure','code-security':'success'},...mock})
  assert.equal(mock.calls.length,2)
  assert.ok(mock.calls[1].url.endsWith(`/statuses/${sha}`))
})
test('invalid destinations and API failures fail visibly without exposing tokens',async()=>{
  await assert.rejects(reportPullRequest(plan,{token:'private-token',runUrl:'http://127.0.0.1:4500',phase:'pending',...api([])}),/GitHub/)
  await assert.rejects(verifyPullRequest(plan,{token:'private-token',fetchImpl:async()=>({ok:false,status:403})}),error=>{
    assert.match(error.message,/403/); assert.ok(!error.message.includes('private-token'));return true
  })
})
