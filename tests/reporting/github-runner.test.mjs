import test from 'node:test'
import assert from 'node:assert/strict'
import { planGitHubRun, ciProfile, verifyAppAccess } from '../../scripts/github-qa.mjs'
import { composeArgs } from '../../pipeline/adapters/local-stack.mjs'
const config={appRepository:'team/web-app',appRef:'main'}
test('fresh CI checkouts do not inherit a populated local production workspace', () => {
  const local = { name: 'local-docker', isolated: true, stack: { webmpcPath: '../WEB MPC', verificationRuntime: true, copiedWorkspace: true } }
  const ci = ciProfile(local, '123', '2')
  assert.equal(local.stack.copiedWorkspace, true)
  assert.equal(ci.stack.copiedWorkspace, false)
  const args = composeArgs(ci, ['up']).args
  assert.ok(args.some(arg => arg.endsWith('docker-compose.verification.yml')))
  assert.ok(!args.some(arg => arg.endsWith('docker-compose.workspace.yml')))
  assert.ok(composeArgs(local, ['up']).args.some(arg => arg.endsWith('docker-compose.workspace.yml')))
})
test('main updates run regression and KST schedules select API and load',()=>{
  assert.equal(planGitHubRun('push',{},config).suite,'regression')
  assert.equal(planGitHubRun('schedule',{schedule:'0 */4 * * *'},config).suite,'api')
  assert.equal(planGitHubRun('schedule',{schedule:'0 1 * * *'},config).suite,'load')
  assert.throws(()=>planGitHubRun('schedule',{schedule:'* * * * *'},config))
})
test('app PR dispatch tests the exact head commit only from the configured app',()=>{
  const client_payload={repository:'team/web-app',sha:'a'.repeat(40),pr_number:17}
  const plan=planGitHubRun('repository_dispatch',{action:'webapp-pr',client_payload},config)
  assert.equal(plan.appRef,client_payload.sha)
  assert.equal(plan.suite,'full')
  assert.equal(plan.prNumber,17)
  assert.throws(()=>planGitHubRun('repository_dispatch',{action:'webapp-pr',client_payload:{...client_payload,pr_number:0}},config))
  assert.throws(()=>planGitHubRun('repository_dispatch',{action:'webapp-merged',client_payload},config))
  assert.throws(()=>planGitHubRun('repository_dispatch',{action:'webapp-pr',client_payload:{...client_payload,repository:'other/app'}},config))
  assert.throws(()=>planGitHubRun('repository_dispatch',{action:'webapp-pr',client_payload:{...client_payload,sha:'main; echo unsafe'}},config))
})
test('direct PR events are rejected; only validated application dispatches select PR code',()=>{
  assert.throws(()=>planGitHubRun('pull_request',{},config))
  assert.equal(planGitHubRun('workflow_dispatch',{inputs:{suite:'full'}},config).suite,'full')
  assert.equal(planGitHubRun('workflow_dispatch',{inputs:{suite:'uat'}},config).suite,'uat')
  assert.throws(()=>planGitHubRun('workflow_dispatch',{inputs:{suite:'unknown'}},config))
  assert.throws(()=>planGitHubRun('push',{},{}))
})
test('CI uses its own disposable compose project and retains isolation guards',()=>{
  const env=ciProfile({isolated:true,allowLoad:true,stack:{ports:{web:3410}}},'123','2')
  assert.equal(env.stack.composeProject,'mpc-qa-ci-123-2')
  assert.equal(env.stack.webmpcPath,'../WEB MPC')
  assert.equal(env.isolated,true)
  assert.throws(()=>ciProfile({},'unsafe-project','1'))
})

test('checkout preflight requires an application token without making an anonymous request', async () => {
  await assert.rejects(verifyAppAccess({ ...config, fetchImpl: () => { throw new Error('must not fetch') } }), /WEBAPP_READ_TOKEN.*Contents: read/)
})

test('checkout preflight checks content access to the exact revision, not just repository metadata', async () => {
  const sha = 'a'.repeat(40)
  const result = await verifyAppAccess({ ...config, appRef: sha, token: 'test-private-token', fetchImpl: async (url, options) => {
    assert.equal(url, `https://api.github.com/repos/team/web-app/commits/${sha}`)
    assert.equal(options.headers.Authorization, 'Bearer test-private-token')
    return { ok: true, json: async () => ({ sha }) }
  } })
  assert.equal(result.sha, sha)
})

test('checkout failures explain token access and ref errors without leaking credentials', async () => {
  for (const status of [401, 403, 404, 422]) {
    await assert.rejects(verifyAppAccess({ ...config, token: 'private-token', fetchImpl: async () => ({ ok: false, status }) }), error => {
      assert.match(error.message, /WEBAPP_READ_TOKEN/)
      assert.match(error.message, /team\/web-app/)
      assert.ok(!error.message.includes('private-token'))
      return true
    })
  }
})
