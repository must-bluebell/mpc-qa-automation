import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHandler } from '../../pipeline/github-app/handler.mjs'
import { createState } from '../../pipeline/github-app/state.mjs'
import { parseSettings } from '../../pipeline/github-app/policy.mjs'

const REPO = 'MSQ-AI-Testing/demo', SHA = 'c'.repeat(40)
const settings = () => parseSettings({ testsRepository: 'MSQ-AI-Testing/mpc-automation', testsRef: 'main', repositories: { [REPO]: { target: { type: 'local-stack' } } } })
const tmp = () => mkdtempSync(join(tmpdir(), 'ghapp-auto-'))

function fakeGitHub() {
  const calls = []
  const api = {
    calls,
    pull: (...a) => { calls.push(['pull', ...a]); return Promise.resolve({ state: 'open', head: { sha: api.head ?? SHA, repo: { full_name: REPO } } }) },
    pullFiles: (...a) => { calls.push(['pullFiles', ...a]); return Promise.resolve(['README.md']) },
    permissionOf: (...a) => { calls.push(['permissionOf', ...a]); return Promise.resolve(api.permission ?? 'write') },
    react: (...a) => { calls.push(['react', ...a]); return Promise.resolve(null) },
    comment: (...a) => { calls.push(['comment', ...a]); return Promise.resolve(null) },
  }
  return api
}
const pullPayload = (over = {}) => ({
  action: 'opened', repository: { full_name: REPO }, sender: { type: 'User', login: 'alice' },
  pull_request: {
    number: 4, state: 'open', draft: false, author_association: 'MEMBER', user: { login: 'alice', type: 'User' },
    head: { sha: SHA, repo: { full_name: REPO } },
  }, ...over,
})
const passing = async () => ({ verdict: 'passed', summary: { passed: 6, failed: [], flaky: 0, skipped: 2 }, durationMs: 1000, tests: { repository: 'MSQ-AI-Testing/mpc-automation', ref: 'main', sha: 'b'.repeat(40) }, targetLabel: 'local test stack · local-docker · chain 97' })
const names = gh => gh.calls.map(c => c[0])

function setup(gh, runReview = async () => passing()) {
  const seen = []
  const handler = createHandler({ settings, github: gh, runReview: async a => { seen.push(a); return runReview(a) }, state: createState(join(tmp(), 'state.json')) })
  return { handler, seen }
}

test('a member opening a pull request starts one review and posts one result, with no 👀 reaction', async () => {
  const gh = fakeGitHub()
  const { handler, seen } = setup(gh)
  const out = await handler.handle({ event: 'pull_request', delivery: 'd1', payload: pullPayload() })
  assert.deepEqual(out, { status: 'accepted', reason: 'queued' })
  await handler.idle()
  assert.equal(seen.length, 1)
  assert.equal(seen[0].sha, SHA); assert.equal(seen[0].number, 4)
  assert.ok(!names(gh).includes('react'), 'no comment to react to')
  assert.equal(names(gh).filter(n => n === 'comment').length, 1)
  assert.match(gh.calls.find(c => c[0] === 'comment')[3], /Automation review passed/)
})

test('the same commit is reviewed once, even if the pull request is reopened', async () => {
  const gh = fakeGitHub()
  const { handler, seen } = setup(gh)
  await handler.handle({ event: 'pull_request', delivery: 'd1', payload: pullPayload() })
  await handler.idle()
  const again = await handler.handle({ event: 'pull_request', delivery: 'd2', payload: pullPayload({ action: 'reopened' }) })
  assert.deepEqual(again, { status: 'ignored', reason: 'duplicate' })
  await handler.idle()
  assert.equal(seen.length, 1)
})

test('a new commit pushed to the pull request starts a review automatically', async () => {
  const gh = fakeGitHub()
  const { handler, seen } = setup(gh)
  const out = await handler.handle({ event: 'pull_request', delivery: 'd1', payload: pullPayload({ action: 'synchronize' }) })
  assert.equal(out.status, 'accepted')
  await handler.idle()
  assert.equal(seen.length, 1)
})

test('commits pushed during a review are reviewed afterwards, and only the newest pending commit runs', async () => {
  const gh = fakeGitHub()
  let release
  const gate = new Promise(resolve => { release = resolve })
  const { handler, seen } = setup(gh, async () => { await gate; return passing() })
  assert.equal((await handler.handle({ event: 'pull_request', delivery: 'd1', payload: pullPayload() })).reason, 'queued')
  await new Promise(resolve => setImmediate(resolve))
  const pushed = sha => { gh.head = sha; const p = pullPayload({ action: 'synchronize' }); p.pull_request.head.sha = sha; return p }
  const second = 'd'.repeat(40), third = 'e'.repeat(40)
  assert.deepEqual(await handler.handle({ event: 'pull_request', delivery: 'd2', payload: pushed(second) }), { status: 'accepted', reason: 'queued-after-active' })
  assert.deepEqual(await handler.handle({ event: 'pull_request', delivery: 'd3', payload: pushed(third) }), { status: 'accepted', reason: 'queued-after-active' })
  release()
  await handler.idle()
  assert.equal(seen.length, 2, 'the first review and one follow-up; the superseded commit never runs')
  assert.equal(seen[1].sha, third)
  assert.equal(gh.calls.filter(c => c[0] === 'comment').length, 2)
})

test('a member whose stale payload says CONTRIBUTOR is reviewed, because the live repository permission decides', async () => {
  const gh = fakeGitHub(); gh.permission = 'admin'
  const { handler, seen } = setup(gh)
  const stale = pullPayload(); stale.pull_request.author_association = 'CONTRIBUTOR'
  assert.deepEqual(await handler.handle({ event: 'pull_request', delivery: 'd1', payload: stale }), { status: 'accepted', reason: 'queued' })
  await handler.idle()
  assert.equal(seen.length, 1)
})

test('a payload that says MEMBER does not help a user whose live permission is read-only', async () => {
  const gh = fakeGitHub(); gh.permission = 'read'
  const { handler, seen } = setup(gh)
  assert.deepEqual(await handler.handle({ event: 'pull_request', delivery: 'd1', payload: pullPayload() }), { status: 'rejected', reason: 'not-authorized' })
  await handler.idle()
  assert.equal(seen.length, 0)
})

test('draft pull requests wait until marked ready', async () => {
  const gh = fakeGitHub()
  const { handler, seen } = setup(gh)
  const draft = pullPayload(); draft.pull_request.draft = true
  assert.deepEqual(await handler.handle({ event: 'pull_request', delivery: 'd1', payload: draft }), { status: 'ignored', reason: 'draft' })
  const ready = await handler.handle({ event: 'pull_request', delivery: 'd2', payload: pullPayload({ action: 'ready_for_review' }) })
  assert.equal(ready.status, 'accepted')
  await handler.idle()
  assert.equal(seen.length, 1)
})

test('forks are skipped silently and never reach the test wallet', async () => {
  const gh = fakeGitHub()
  const { handler, seen } = setup(gh)
  const fork = pullPayload(); fork.pull_request.head.repo = { full_name: 'someone/demo' }
  assert.deepEqual(await handler.handle({ event: 'pull_request', delivery: 'd1', payload: fork }), { status: 'ignored', reason: 'fork' })
  await handler.idle()
  assert.equal(seen.length, 0); assert.equal(gh.calls.length, 0)
})

test('a pull request by someone without repository permission is rejected and gets no comment', async () => {
  const gh = fakeGitHub(); gh.permission = 'none'
  const { handler, seen } = setup(gh)
  const outsider = pullPayload(); outsider.pull_request.author_association = 'CONTRIBUTOR'
  assert.deepEqual(await handler.handle({ event: 'pull_request', delivery: 'd1', payload: outsider }), { status: 'rejected', reason: 'not-authorized' })
  await handler.idle()
  assert.equal(seen.length, 0); assert.deepEqual(gh.calls.filter(c => c[0] !== 'permissionOf'), [])
})

test('repositories not in the policy are ignored', async () => {
  const gh = fakeGitHub()
  const { handler, seen } = setup(gh)
  const other = pullPayload({ repository: { full_name: 'MSQ-AI-Testing/other' } })
  assert.deepEqual(await handler.handle({ event: 'pull_request', delivery: 'd1', payload: other }), { status: 'ignored', reason: 'repository-not-enabled' })
  await handler.idle()
  assert.equal(seen.length, 0)
})

test('a bot-opened pull request is ignored', async () => {
  const gh = fakeGitHub()
  const { handler, seen } = setup(gh)
  const bot = pullPayload(); bot.pull_request.user = { login: 'dependabot[bot]', type: 'Bot' }
  assert.deepEqual(await handler.handle({ event: 'pull_request', delivery: 'd1', payload: bot }), { status: 'ignored', reason: 'bot' })
  await handler.idle()
  assert.equal(seen.length, 0)
})
