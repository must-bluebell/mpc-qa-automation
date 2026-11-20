import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
import { createGitHub } from '../../pipeline/github-app/github.mjs'
import { createHandler } from '../../pipeline/github-app/handler.mjs'
import { createState } from '../../pipeline/github-app/state.mjs'
import { parseSettings } from '../../pipeline/github-app/policy.mjs'
import { dispatchInputs, signDispatch, verifyDispatch } from '../../pipeline/github-app/actions.mjs'
import * as doctor from '../../pipeline/github-app/doctor.mjs'

const repo = 'globalmpc/web', sha = 'a'.repeat(40)

for (const nextEngine of ['local', 'actions']) test(`sweep delivers a saved local verdict after policy selects ${nextEngine}, without rerunning tests`, async () => {
  const state = createState(join(mkdtempSync(join(tmpdir(), 'delivery-')), 'state.json'))
  let runs = 0, unavailable = true, engine = 'local'
  const comments = []
  const github = {
    permissionOf: async () => 'write',
    pull: async () => ({ state: 'open', head: { sha, repo: { full_name: repo } } }),
    pullFiles: async () => [],
    comment: async (_repo, _number, body) => { if (unavailable) throw new Error('comment unavailable'); comments.push(body) },
  }
  const handler = createHandler({ github, state,
    settings: () => parseSettings({ testsRepository: 'globalmpc/mpc-automation', testsRef: 'main', repositories: { [repo]: { engine, target: { baseUrl: 'https://web.vercel.app' } } } }),
    runReview: async () => { runs++; return { verdict: 'passed', tests: { repository: 'globalmpc/mpc-automation', ref: 'main', sha }, summary: { passed: 1, failed: [], flaky: 0, skipped: 0 } } },
  })
  await handler.handle({ event: 'pull_request', payload: { action: 'opened', repository: { full_name: repo }, pull_request: { number: 1, state: 'open', user: { login: 'alice' }, head: { sha, repo: { full_name: repo } } } } })
  await handler.idle()
  const body = state.pending()[0].resultBody
  assert.equal(typeof body, 'string')
  unavailable = false
  engine = nextEngine
  await handler.sweep(); await handler.idle()
  await handler.sweep(); await handler.idle()
  assert.deepEqual(comments, [body])
  assert.equal(runs, 1)
  assert.equal(state.pending().length, 0)
})

for (const engine of ['local', 'actions']) test(`${engine}: automatic preview discovery resumes after restart without another webhook`, async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'preview-')), 'state.json')
  let ready = false, runs = 0, head = sha
  const github = {
    permissionOf: async () => 'write', pull: async () => ({ state: 'open', head: { sha: head, repo: { full_name: repo } } }),
    deployments: async () => ready ? [{ id: 1, sha: head, environment: 'Preview', creator: { login: 'vercel[bot]' } }] : [],
    deploymentStatuses: async () => [{ state: 'success', environment_url: 'https://web.vercel.app' }],
    pullFiles: async () => [], comment: async () => {},
  }
  const options = { github, settings: () => parseSettings({ testsRepository: 'globalmpc/mpc-automation', testsRef: 'main', repositories: { [repo]: { engine } } }),
    dispatchSecret: 'secret-for-dispatch-test', actions: { createCheck: async () => 1, dispatch: async () => { runs++ }, findRun: async () => null },
    runReview: async () => { runs++; return { verdict: 'passed', tests: {}, summary: { passed: 1, failed: [], skipped: 0 } } } }
  const first = createHandler({ ...options, state: createState(file) })
  await first.handle({ event: 'pull_request', payload: { action: 'opened', repository: { full_name: repo }, pull_request: { number: 1, state: 'open', user: { login: 'alice' }, head: { sha, repo: { full_name: repo } } } } })
  await first.idle()
  assert.equal(runs, 0)
  assert.equal(createState(file).pending().length, 1)
  const second = createHandler({ ...options, state: createState(file) })
  await second.idle()
  // A newer commit arrives while the original preview is still waiting.
  head = 'b'.repeat(40)
  await second.handle({ event: 'pull_request', payload: { action: 'synchronize', repository: { full_name: repo }, pull_request: { number: 1, state: 'open', user: { login: 'alice' }, head: { sha: head, repo: { full_name: repo } } } } })
  await second.idle()
  ready = true
  await second.sweep(); await second.idle()
  await second.sweep(); await second.idle()
  assert.equal(runs, 1)
})

test('policy timeout travels in dispatch and cannot be altered after signing', () => {
  const inputs = dispatchInputs({ timeoutMinutes: 90 })
  assert.equal(inputs.timeout_minutes, '90')
  assert.equal(inputs.job_timeout_minutes, '150')
  const secret = 'secret-for-dispatch-test', token = signDispatch(secret, 'repo', 'main', inputs)
  assert.equal(verifyDispatch(secret, 'repo', 'main', { ...inputs, timeout_minutes: '40' }, token), false)
})

test('doctor includes selected repository 101 and rejects failed lookups', async () => {
  assert.equal(typeof doctor.installationRepositories, 'function')
  const fetchImpl = async url => ({ ok: true, json: async () => ({ repositories: url.endsWith('page=1') ? Array.from({ length: 100 }, (_, i) => ({ full_name: `org/r${i}` })) : [{ full_name: 'globalmpc/mpc-automation' }] }) })
  const repos = await doctor.installationRepositories('token', fetchImpl)
  assert.equal(repos.length, 101)
  assert.equal(repos[100], 'globalmpc/mpc-automation')
  await assert.rejects(doctor.installationRepositories('token', async () => ({ ok: false, status: 403 })), /403/)
})

test('comment recovery finds an accepted result beyond the first page', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const comments = Array.from({ length: 100 }, () => ({ body: 'other' }))
  let posts = 0
  const github = createGitHub({ appId: '1', privateKey, fetchImpl: async (url, init) => {
    let data
    if (url.endsWith('/installation')) data = { id: 1 }
    else if (url.includes('access_tokens')) data = { token: 'token', expires_at: new Date(Date.now() + 3600000).toISOString() }
    else if (init.method === 'POST') { posts++; data = { id: 101, performed_via_github_app: { id: 1 }, body: JSON.parse(init.body).body }; comments.push(data) }
    else data = url.endsWith('page=1') ? comments.slice(0, 100) : comments.slice(100)
    return { ok: true, text: async () => JSON.stringify(data) }
  } })
  await github.comment(repo, 1, 'result', { key: 'review-1' })
  await github.comment(repo, 1, 'result', { key: 'review-1' })
  assert.equal(posts, 1)
  comments[100].performed_via_github_app = null // A copied marker from an unrelated commenter is not a receipt.
  await github.comment(repo, 1, 'result', { key: 'review-1' })
  assert.equal(posts, 2)
})
