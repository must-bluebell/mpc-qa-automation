import test from 'node:test'
import assert from 'node:assert/strict'
import { planGitHubRun, ciProfile } from '../../scripts/github-qa.mjs'
const config={appRepository:'team/web-app',appRef:'main'}
test('main updates run regression and KST schedules select API and load',()=>{
  assert.equal(planGitHubRun('push',{},config).suite,'regression')
  assert.equal(planGitHubRun('schedule',{schedule:'0 */4 * * *'},config).suite,'api')
  assert.equal(planGitHubRun('schedule',{schedule:'0 1 * * *'},config).suite,'load')
  assert.throws(()=>planGitHubRun('schedule',{schedule:'* * * * *'},config))
})
test('app merge dispatch tests the exact commit only from the configured app',()=>{
  const client_payload={repository:'team/web-app',sha:'a'.repeat(40)}
  const plan=planGitHubRun('repository_dispatch',{action:'webapp-merged',client_payload},config)
  assert.equal(plan.appRef,client_payload.sha)
  assert.throws(()=>planGitHubRun('repository_dispatch',{action:'webapp-merged',client_payload:{...client_payload,repository:'other/app'}},config))
  assert.throws(()=>planGitHubRun('repository_dispatch',{action:'webapp-merged',client_payload:{...client_payload,sha:'main; echo unsafe'}},config))
})
test('PR code never enters a credential-bearing Docker job',()=>{
  assert.throws(()=>planGitHubRun('pull_request',{},config))
  assert.throws(()=>planGitHubRun('workflow_dispatch',{inputs:{suite:'full'}},config))
  assert.throws(()=>planGitHubRun('push',{},{}))
})
test('CI uses its own disposable compose project and retains isolation guards',()=>{
  const env=ciProfile({isolated:true,allowLoad:true,stack:{ports:{web:3410}}},'123','2')
  assert.equal(env.stack.composeProject,'mpc-qa-ci-123-2')
  assert.equal(env.stack.webmpcPath,'../WEB MPC')
  assert.equal(env.isolated,true)
  assert.throws(()=>ciProfile({},'unsafe-project','1'))
})
