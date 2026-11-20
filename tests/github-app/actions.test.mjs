import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createActionsClient, dispatchInputs, parseCallback, signDispatch, WORKFLOW_FILE } from '../../pipeline/github-app/actions.mjs'
import { createHandler } from '../../pipeline/github-app/handler.mjs'
import { createWebhookServer } from '../../pipeline/github-app/server.mjs'
import { parseSettings } from '../../pipeline/github-app/policy.mjs'
import { createState } from '../../pipeline/github-app/state.mjs'
import { GitHubError } from '../../pipeline/github-app/github.mjs'
import { sign } from '../../pipeline/github-app/signature.mjs'
import { postCallback, readInputs, runAction } from '../../pipeline/github-app/action-review.mjs'

const REPO = 'globalmpc/web', TESTS = 'globalmpc/mpc-automation', SHA = 'a'.repeat(40), OLD_SHA = 'b'.repeat(40)
const BASE = 'https://web-git-feat-team.vercel.app'
const SEED = 'word1 word2 secret-seed-phrase-value-xyz'
const CALLBACK_SECRET = 'callback-secret-0123456789'
const tmp = () => mkdtempSync(join(tmpdir(), 'ghapp-actions-'))
const REVIEW_ID = '0123456789abcdef0123456789abcdef'
const validReport = { dispatchToken: 'sha256=' + '1'.repeat(64), reviewId: REVIEW_ID, verdict: 'passed', headline: '4 passed', body: '### ✅ Automation review passed', runUrl: null }

test('a report from the Action must be exactly the expected shape', () => {
  assert.deepEqual(parseCallback(validReport), validReport)
  assert.equal(parseCallback({ ...validReport, runUrl: 'https://github.com/globalmpc/mpc-automation/actions/runs/42' }).runUrl, 'https://github.com/globalmpc/mpc-automation/actions/runs/42')
  const bad = [
    null, [], { ...validReport, reviewId: 'not-hex' }, { ...validReport, verdict: 'done' }, { ...validReport, headline: '' },
    { ...validReport, body: 'x'.repeat(60_001) }, { ...validReport, runUrl: 'https://evil.example/actions/runs/1' }, { ...validReport, body: 42 },
  ]
  for (const value of bad) assert.throws(() => parseCallback(value), /review report/, JSON.stringify(value)?.slice(0, 80))
})

test('dispatch inputs are strings, and the run is named after the review id', () => {
  const inputs = dispatchInputs({ reviewId: REVIEW_ID, repository: REPO, number: 12, sha: SHA, baseUrl: BASE, chainId: 97, playwrightArgs: ['--project=chromium'], requestedBy: 'alice' })
  assert.deepEqual(inputs, { review_id: REVIEW_ID, repository: REPO, pr_number: '12', head_sha: SHA, base_url: BASE, chain_id: '97', playwright_args: '["--project=chromium"]', requested_by: 'alice', timeout_minutes: '40', job_timeout_minutes: '100' })
  for (const value of Object.values(inputs)) assert.equal(typeof value, 'string')
  assert.equal(WORKFLOW_FILE, 'automation-review.yml')
})

test('the Actions client dispatches on the tests repository, finds its run by review id and manages the check', async () => {
  const calls = []
  const github = {
    dispatchWorkflow: async (...a) => { calls.push(['dispatch', ...a]) },
    listWorkflowRuns: async () => { calls.push(['list']); return calls.filter(c => c[0] === 'list').length < 2 ? [] : [{ id: 7, display_title: `automation-review ${REVIEW_ID}`, html_url: 'https://github.com/globalmpc/mpc-automation/actions/runs/7' }] },
    createCheckRun: async (repo, body) => { calls.push(['createCheck', repo, body]); return { id: 55 } },
    updateCheckRun: async (repo, id, body) => { calls.push(['updateCheck', repo, id, body]) },
  }
  const client = createActionsClient({ github, testsRepository: TESTS, sleep: async () => {} })
  await client.dispatch({ ref: 'main', inputs: { review_id: REVIEW_ID } })
  assert.deepEqual(calls[0], ['dispatch', TESTS, WORKFLOW_FILE, 'main', { review_id: REVIEW_ID }])
  assert.deepEqual(await client.findRun(REVIEW_ID), { id: 7, url: 'https://github.com/globalmpc/mpc-automation/actions/runs/7' })
  assert.equal(await client.findRun('f'.repeat(32)), null)
  assert.equal(await client.createCheck(REPO, { sha: SHA, reviewId: REVIEW_ID }), 55)
  const created = calls.find(c => c[0] === 'createCheck')[2]
  assert.equal(created.head_sha, SHA); assert.equal(created.status, 'in_progress')
  for (const [verdict, conclusion] of [['passed', 'success'], ['failed', 'failure'], ['blocked', 'neutral']]) {
    await client.finishCheck(REPO, 55, { verdict, headline: 'h', runUrl: 'https://github.com/globalmpc/mpc-automation/actions/runs/7' })
    const body = calls.filter(c => c[0] === 'updateCheck').at(-1)[3]
    assert.equal(body.status, 'completed'); assert.equal(body.conclusion, conclusion); assert.equal(body.details_url, 'https://github.com/globalmpc/mpc-automation/actions/runs/7')
  }
})

test('engine "actions" needs a web deployment, the repository root and no impact rules; the default stays local', () => {
  const policy = entry => parseSettings({ testsRepository: TESTS, testsRef: 'main', repositories: { [REPO]: entry } }).repositories.get(REPO.toLowerCase())
  assert.equal(policy({ previewHostPrefix: 'web' }).engine, 'local')
  assert.equal(policy({ engine: 'actions', previewHostPrefix: 'web' }).engine, 'actions')
  assert.equal(policy({ engine: 'actions', target: { baseUrl: BASE + '/' } }).fixedBaseUrl, BASE)
  assert.throws(() => policy({ engine: 'queue' }), /engine must be/)
  assert.throws(() => policy({ engine: 'actions', target: { type: 'local-stack' } }), /not a local stack/)
  assert.throws(() => policy({ engine: 'actions', extension: { path: 'ext' } }), /not a local stack or extension/)
  assert.throws(() => policy({ engine: 'actions', testsDirectory: 'sub' }), /repository root/)
  assert.throws(() => policy({ engine: 'actions', impact: [{ name: 'dig', paths: ['src/**'], runs: [['--project=uat']] }] }), /impact rules are not supported/)
})

// A fake App client and fake Actions client that record what the handler does.
function fixtures({ pullOverrides = {}, dispatchError = null, findRun = async () => ({ id: 99, url: 'https://github.com/globalmpc/mpc-automation/actions/runs/99' }) } = {}) {
  const github = {
    calls: [],
    permissionOf: async () => 'write',
    async pull(repo, number) { this.calls.push(['pull', repo, number]); return { state: 'open', head: { sha: SHA, repo: { full_name: REPO } }, ...pullOverrides } },
    async react(...a) { this.calls.push(['react', ...a]) },
    async comment(repo, number, body) { this.calls.push(['comment', repo, number, body]) },
    async deployments() { return [{ id: 9, sha: SHA, environment: 'Preview', creator: { login: 'vercel[bot]' } }] },
    async deploymentStatuses() { return [{ state: 'success', environment_url: BASE + '/' }] },
  }
  const actions = {
    dispatched: [], finished: [],
    async createCheck(repo, { sha }) { return 4242 },
    async dispatch(args) { if (dispatchError) throw dispatchError; actions.dispatched.push(args) },
    findRun,
    async finishCheck(repo, id, report) { actions.finished.push({ repo, id, verdict: report.verdict }) },
  }
  return { github, actions }
}
const settingsWithActions = () => parseSettings({ testsRepository: TESTS, testsRef: 'main', timeoutMinutes: 40, repositories: { [REPO]: { engine: 'actions', previewHostPrefix: 'web' } } })
const commentPayload = (id = 555) => ({
  action: 'created', repository: { full_name: REPO }, sender: { type: 'User', login: 'alice' },
  issue: { number: 12, state: 'open', pull_request: {} },
  comment: { id, body: '/automation review', author_association: 'MEMBER', user: { login: 'alice', type: 'User' } },
})
const handlerFor = (fx, { now } = {}) => createHandler({ settings: settingsWithActions, dispatchSecret: CALLBACK_SECRET, github: fx.github, actions: fx.actions, runReview: async () => { throw new Error('local engine not expected') }, state: createState(join(tmp(), 'state.json')), now })

test('a member comment dispatches the Action, leaves a pending check and waits for the report', async () => {
  const fx = fixtures()
  const handler = handlerFor(fx)
  assert.deepEqual(await handler.handle({ event: 'issue_comment', payload: commentPayload() }), { status: 'accepted', reason: 'queued' })
  await handler.idle()
  assert.equal(fx.actions.dispatched.length, 1)
  const { ref, inputs } = fx.actions.dispatched[0]
  assert.equal(ref, 'main'); assert.equal(inputs.pr_number, '12'); assert.equal(inputs.head_sha, SHA); assert.equal(inputs.base_url, BASE)
  assert.equal(inputs.requested_by, 'alice'); assert.equal(inputs.chain_id, '97')
  assert.equal(fx.github.calls.filter(c => c[0] === 'comment').length, 0, 'no comment until the Action reports')
  assert.deepEqual(fx.github.calls.find(c => c[0] === 'react').slice(1), [REPO, 555, 'eyes'])
})

test('the Action report is posted once to the pull request, the check is completed, and a repeat is ignored', async () => {
  const fx = fixtures()
  const handler = handlerFor(fx)
  await handler.handle({ event: 'issue_comment', payload: commentPayload() }); await handler.idle()
  const reviewId = fx.actions.dispatched[0].inputs.review_id
  assert.deepEqual(await handler.completeReview({ ...validReport, reviewId, dispatchToken: fx.actions.dispatched[0].inputs.dispatch_token }), { status: 'accepted', reason: 'reported' })
  const comments = fx.github.calls.filter(c => c[0] === 'comment')
  assert.equal(comments.length, 1); assert.equal(comments[0][3], validReport.body)
  assert.deepEqual(fx.actions.finished, [{ repo: REPO, id: 4242, verdict: 'passed' }])
  assert.deepEqual(await handler.completeReview({ ...validReport, reviewId }), { status: 'ignored', reason: 'unknown-review' })
  assert.deepEqual(await handler.completeReview({ ...validReport, reviewId: 'f'.repeat(32) }), { status: 'ignored', reason: 'unknown-review' })
})

test('a second request for the same commit does not start another run', async () => {
  const fx = fixtures()
  const handler = handlerFor(fx)
  await handler.handle({ event: 'issue_comment', payload: commentPayload(555) }); await handler.idle()
  await handler.handle({ event: 'issue_comment', payload: commentPayload(556) }); await handler.idle()
  assert.equal(fx.actions.dispatched.length, 1)
  assert.match(fx.github.calls.find(c => c[0] === 'comment')[3], /already being reviewed/)
})

test('a failed dispatch reports a blocked check and a clear comment, and leaves nothing pending', async () => {
  const fx = fixtures({ dispatchError: new GitHubError('POST', '/dispatches', 403, 'Forbidden') })
  const state = createState(join(tmp(), 'state.json'))
  const handler = createHandler({ settings: settingsWithActions, dispatchSecret: CALLBACK_SECRET, github: fx.github, actions: fx.actions, runReview: async () => null, state })
  await handler.handle({ event: 'issue_comment', payload: commentPayload() }); await handler.idle()
  assert.deepEqual(fx.actions.finished, [{ repo: REPO, id: 4242, verdict: 'blocked' }])
  assert.match(fx.github.calls.find(c => c[0] === 'comment')[3], /could not be started/)
  assert.equal(state.pending().length, 0)
})

test('a run that never reports is expired once, with its run link', async () => {
  let clock = 1_000_000
  const fx = fixtures({ findRun: async () => ({ id: 99, url: 'https://github.com/globalmpc/mpc-automation/actions/runs/99' }) })
  const handler = handlerFor(fx, { now: () => clock })
  await handler.handle({ event: 'issue_comment', payload: commentPayload() }); await handler.idle()
  await handler.sweep()
  assert.equal(fx.github.calls.filter(c => c[0] === 'comment').length, 0, 'not expired yet')
  clock += 110 * 60_000
  await handler.sweep(); await handler.sweep()
  const comments = fx.github.calls.filter(c => c[0] === 'comment')
  assert.equal(comments.length, 1)
  assert.match(comments[0][3], /did not report a result/); assert.match(comments[0][3], /actions\/runs\/99/)
  assert.deepEqual(fx.actions.finished.map(f => f.verdict), ['blocked'])
})

test('the callback route accepts only reports signed with the callback secret, and never the webhook secret', async () => {
  const calls = []
  const handler = { handle: async () => ({ status: 'ignored' }), completeReview: async report => { calls.push(report); return { status: 'accepted', reason: 'reported' } } }
  const server = createWebhookServer({ secret: 'webhook-secret-0123456789', callbackSecret: CALLBACK_SECRET, handler })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/callbacks/review`
  const body = JSON.stringify(validReport)
  const post = (signature, raw = body) => fetch(url, { method: 'POST', body: raw, headers: signature ? { 'content-type': 'application/json', 'x-qa-signature': signature } : { 'content-type': 'application/json' } })
  try {
    assert.equal((await post()).status, 401)
    assert.equal((await post(sign('webhook-secret-0123456789', body))).status, 401)
    assert.equal((await post(sign(CALLBACK_SECRET, body + ' '))).status, 401)
    const bad = JSON.stringify({ ...validReport, verdict: 'great' })
    assert.equal((await post(sign(CALLBACK_SECRET, bad), bad)).status, 400)
    assert.equal(calls.length, 0)
    const ok = await post(sign(CALLBACK_SECRET, body))
    assert.equal(ok.status, 200); assert.equal((await ok.json()).reason, 'reported')
    assert.equal(calls.length, 1)
  } finally { await new Promise(resolve => server.close(resolve)) }
})

// The runner side: what the Action sends to the App, and what the tests may see.
const runnerEnv = (over = {}) => {
  const env = {
  QA_PIPELINE_LOCK_DIR: tmp(), REVIEW_TIMEOUT_MINUTES: '40', REVIEW_JOB_TIMEOUT_MINUTES: '100',
  REVIEW_ID: REVIEW_ID, REVIEW_REPOSITORY: REPO, REVIEW_PR: '12', REVIEW_SHA: SHA, REVIEW_BASE_URL: BASE, REVIEW_CHAIN_ID: '97',
  REVIEW_ARGS: '["--project=chromium"]', REVIEW_REQUESTED_BY: 'alice', REVIEW_CALLBACK_URL: 'https://qa.example.com/callbacks/review',
  REVIEW_CALLBACK_SECRET: CALLBACK_SECRET, QA_SEED_PHRASE: SEED, WALLET_ADDRESS: '0x1111111111111111111111111111111111111111',
  GITHUB_REPOSITORY: TESTS, GITHUB_SHA: 'c'.repeat(40), GITHUB_REF_NAME: 'main', GITHUB_SERVER_URL: 'https://github.com', GITHUB_RUN_ID: '42',
  }
  env.REVIEW_DISPATCH_TOKEN = signDispatch(CALLBACK_SECRET, TESTS, 'main', dispatchInputs({ reviewId: REVIEW_ID, repository: REPO, number: 12, sha: SHA, baseUrl: BASE, chainId: 97, playwrightArgs: ['--project=chromium'], requestedBy: 'alice' }))
  return { ...env, ...over }
}
const playwrightJson = (...tests) => ({ suites: [{ title: 'api.spec.ts', specs: tests }] })

test('the runner rejects unsafe dispatch inputs before anything runs', () => {
  assert.equal(readInputs(runnerEnv()).runUrl, 'https://github.com/globalmpc/mpc-automation/actions/runs/42')
  const bad = [
    { REVIEW_ID: 'short' }, { REVIEW_REPOSITORY: 'no-slash' }, { REVIEW_PR: '0' }, { REVIEW_SHA: 'xyz' },
    { REVIEW_BASE_URL: 'https://evil.example.com/' }, { REVIEW_CHAIN_ID: '56' }, { REVIEW_ARGS: '["--reporter=list"]' },
    { REVIEW_ARGS: '["--grep", "a;rm -rf /"]' }, { REVIEW_CALLBACK_URL: 'http://insecure.example.com' }, { QA_SEED_PHRASE: '' },
  ]
  for (const over of bad) assert.throws(() => readInputs(runnerEnv(over)), undefined, JSON.stringify(over))
})

test('the runner reports a failing review, never leaks the wallet or the callback secret, and fails the job', async () => {
  const outDir = tmp(), posted = [], childEnvs = []
  const run = async (command, args, options) => {
    childEnvs.push(options.env)
    writeFileSync(options.env.PLAYWRIGHT_JSON_OUTPUT_NAME, JSON.stringify(playwrightJson(
      { title: 'passes', tests: [{ status: 'expected', results: [] }] },
      { title: 'fails', tests: [{ status: 'unexpected', results: [{ error: { message: `login failed for ${SEED}`, location: { file: '/w/tests/api.spec.ts', line: 3 } } }] }] },
    )))
    return { code: 1, timedOut: false, durationMs: 5 }
  }
  const verdict = await runAction({ env: runnerEnv(), outDir, run, post: async opts => posted.push(opts) })
  assert.equal(verdict, 'failed')
  const [{ url, secret, report }] = posted
  assert.equal(url, 'https://qa.example.com/callbacks/review'); assert.equal(secret, CALLBACK_SECRET)
  assert.equal(report.reviewId, REVIEW_ID); assert.equal(report.verdict, 'failed')
  assert.match(report.body, /1 passed, 1 failed/); assert.match(report.body, /api\.spec\.ts:3/)
  assert.ok(!report.body.includes('secret-seed-phrase-value-xyz'), 'the wallet seed must not reach the comment')
  assert.equal(childEnvs[0].QA_SEED_PHRASE, SEED, 'the tests get the wallet')
  assert.equal(childEnvs[0].REVIEW_CALLBACK_SECRET, undefined, 'the tests never get the callback secret')
  assert.match(readFileSync(join(outDir, 'review.md'), 'utf8'), /Automation review failed/)
})

test('a run with no readable results is blocked, not passed', async () => {
  const posted = []
  const verdict = await runAction({ env: runnerEnv(), outDir: tmp(), run: async () => ({ code: 0, timedOut: false, durationMs: 1 }), post: async opts => posted.push(opts) })
  assert.equal(verdict, 'blocked'); assert.equal(posted[0].report.verdict, 'blocked')
})

test('setup problems are reported to the pull request when the callback is configured', async () => {
  const posted = []
  await assert.rejects(runAction({ env: runnerEnv({ QA_SEED_PHRASE: '' }), outDir: tmp(), post: async opts => posted.push(opts) }), /test wallet/)
  assert.equal(posted[0].report.verdict, 'blocked'); assert.equal(posted[0].report.reviewId, REVIEW_ID)
})

test('the report post retries server errors, but a refused report is raised at once', async () => {
  const body = { reviewId: REVIEW_ID, verdict: 'passed', headline: 'h', body: 'b', runUrl: null }
  let attempts = 0
  await postCallback({ url: 'https://x.example.com/', secret: CALLBACK_SECRET, report: body, pauseMs: 0, fetchImpl: async () => ({ ok: ++attempts > 1, status: attempts > 1 ? 200 : 503 }) })
  assert.equal(attempts, 2)
  let refusals = 0
  await assert.rejects(postCallback({ url: 'https://x.example.com/', secret: CALLBACK_SECRET, report: body, pauseMs: 0, fetchImpl: async () => { refusals++; return { ok: false, status: 401 } } }), /HTTP 401/)
  assert.equal(refusals, 1)
})

test('a public review id alone cannot complete an App review', async () => {
  const fx = fixtures(), handler = handlerFor(fx)
  await handler.handle({ event: 'issue_comment', payload: commentPayload() }); await handler.idle()
  const { inputs } = fx.actions.dispatched[0]
  assert.deepEqual(await handler.completeReview({ ...validReport, reviewId: inputs.review_id }), { status: 'ignored', reason: 'invalid-dispatch' })
  assert.equal(fx.actions.finished.length, 0)
})

test('callback and sweep cannot deliver the same result concurrently', async () => {
  const fx = fixtures(), handler = handlerFor(fx)
  await handler.handle({ event: 'issue_comment', payload: commentPayload() }); await handler.idle()
  const inputs = fx.actions.dispatched[0].inputs
  let release, entered
  const gate = new Promise(resolve => { release = resolve })
  const started = new Promise(resolve => { entered = resolve })
  fx.github.pull = async () => { entered(); await gate; return { head: { sha: SHA } } }
  const completion = handler.completeReview({ ...validReport, reviewId: inputs.review_id, dispatchToken: inputs.dispatch_token })
  await started
  const sweep = handler.sweep()
  release()
  await Promise.all([completion, sweep])
  assert.equal(fx.github.calls.filter(c => c[0] === 'comment').length, 1)
})

test('Actions dispatch and lookup use the repository captured for this review', async () => {
  const calls = []
  const client = createActionsClient({ github: {
    dispatchWorkflow: async repo => calls.push(repo), listWorkflowRuns: async repo => { calls.push(repo); return [] },
  }, testsRepository: 'globalmpc/old-tests', lookups: 1, sleep: async () => {} })
  await client.dispatch({ testsRepository: TESTS, ref: 'main', inputs: {} })
  await client.findRun(REVIEW_ID, TESTS)
  assert.deepEqual(calls, [TESTS, TESTS])
})

test('a manually altered dispatch cannot run tests or send any verdict', async () => {
  let runs = 0, posts = 0
  await assert.rejects(runAction({ env: runnerEnv({ REVIEW_BASE_URL: 'https://different.vercel.app' }), outDir: tmp(),
    run: async () => { runs++; return { code: 0 } }, post: async () => { posts++ },
  }), /dispatch credential/)
  assert.equal(runs, 0); assert.equal(posts, 0)
})

test('dispatch credentials bind every input plus the tests repository and ref', async () => {
  for (const over of [
    { REVIEW_JOB_TIMEOUT_MINUTES: '150' }, { REVIEW_TIMEOUT_MINUTES: '90' }, { REVIEW_ID: 'f'.repeat(32) }, { REVIEW_REPOSITORY: 'globalmpc/another' }, { REVIEW_PR: '13' },
    { REVIEW_SHA: OLD_SHA }, { REVIEW_BASE_URL: 'https://different.vercel.app' }, { REVIEW_CHAIN_ID: '56' },
    { REVIEW_ARGS: '["--project=chromium","--grep=passing"]' }, { REVIEW_REQUESTED_BY: 'bob' },
    { GITHUB_REPOSITORY: 'globalmpc/another' }, { GITHUB_REF_NAME: 'other' }, { REVIEW_DISPATCH_TOKEN: '' },
  ]) {
    await assert.rejects(runAction({ env: runnerEnv(over), outDir: tmp(),
      run: async () => assert.fail('unauthorized tests ran'), post: async () => assert.fail('unauthorized callback sent'),
    }), /dispatch credential/)
  }
})

test('new reviews follow reloaded policy while a pending review retains its repository', async () => {
  const fx = fixtures(), state = createState(join(tmp(), 'state.json')), lookedUp = []
  let config = settingsWithActions()
  fx.actions.findRun = async (id, repo) => { lookedUp.push(repo); return null }
  const handler = createHandler({ settings: () => config, dispatchSecret: CALLBACK_SECRET, github: fx.github, actions: fx.actions, state })
  await handler.handle({ event: 'issue_comment', payload: commentPayload() }); await handler.idle()
  config = { ...config, testsRepository: 'globalmpc/replacement-tests' }
  const payload = commentPayload(556); payload.issue.number = 13
  await handler.handle({ event: 'issue_comment', payload }); await handler.idle()
  assert.deepEqual(fx.actions.dispatched.map(d => d.testsRepository), [TESTS, config.testsRepository])
  assert.deepEqual(lookedUp, [TESTS, config.testsRepository])
  assert.deepEqual(state.pending().map(job => job.testsRepository), [TESTS, config.testsRepository])
})

test('failed delivery releases its completion lock and sweep retries the saved result', async () => {
  const fx = fixtures(), handler = handlerFor(fx)
  await handler.handle({ event: 'issue_comment', payload: commentPayload() }); await handler.idle()
  const inputs = fx.actions.dispatched[0].inputs, comment = fx.github.comment.bind(fx.github)
  fx.github.comment = async () => { throw new Error('temporarily unavailable') }
  await assert.rejects(handler.completeReview({ ...validReport, reviewId: inputs.review_id, dispatchToken: inputs.dispatch_token }), /temporarily unavailable/)
  fx.github.comment = comment
  await Promise.all([handler.sweep(), handler.sweep()])
  assert.equal(fx.github.calls.filter(c => c[0] === 'comment').length, 1)
})

for (const recovery of ['sweep', 'restart']) test(`failed check update retains the verdict for ${recovery} recovery`, async () => {
  const fx = fixtures(), file = join(tmp(), 'state.json'), state = createState(file)
  const options = { settings: settingsWithActions, dispatchSecret: CALLBACK_SECRET, github: fx.github, actions: fx.actions }
  let handler = createHandler({ ...options, state })
  await handler.handle({ event: 'issue_comment', payload: commentPayload() }); await handler.idle()
  const inputs = fx.actions.dispatched[0].inputs
  const finishCheck = fx.actions.finishCheck.bind(fx.actions)
  fx.actions.finishCheck = async () => { throw new Error('check unavailable') }
  await assert.rejects(handler.completeReview({ ...validReport, reviewId: inputs.review_id, dispatchToken: inputs.dispatch_token }), /check unavailable/)
  assert.equal(createState(file).pending()[0].result.verdict, 'passed')
  assert.equal(fx.github.calls.filter(c => c[0] === 'comment').length, 0)
  if (recovery === 'restart') handler = createHandler({ ...options, state: createState(file) })
  fx.actions.finishCheck = finishCheck
  await handler.sweep()
  assert.equal(createState(file).pending().length, 0)
  assert.deepEqual(fx.actions.finished, [{ repo: REPO, id: 4242, verdict: 'passed' }])
  assert.equal(fx.actions.dispatched.length, 1)
  assert.equal(fx.github.calls.filter(c => c[0] === 'comment').length, 1)
})

test('a large failing Action still posts a valid callback including its run link', async () => {
  let posted
  await runAction({ env: runnerEnv(), outDir: tmp(), run: async (_command, _args, options) => {
    writeFileSync(options.env.PLAYWRIGHT_JSON_OUTPUT_NAME, JSON.stringify(playwrightJson(...Array.from({ length: 120 }, () => ({
      title: 'n'.repeat(200), tests: [{ status: 'unexpected', results: [{ error: { location: { file: '/tests/' + 'l'.repeat(160), line: 1 }, message: Array(3).fill('m'.repeat(200)).join('\n') } }] }],
    })))))
    return { code: 1 }
  }, post: async ({ report }) => { posted = parseCallback(report) } })
  assert.equal(posted.verdict, 'failed')
  assert.ok(posted.body.length <= 60_000)
  assert.match(posted.body, /truncated/)
  assert.match(posted.body, /\*\*Run:\*\* https:\/\/github.com/)
})

for (const recovery of ['sweep', 'restart']) {
  test(`failed dispatch and failed comment stay pending for ${recovery} recovery`, async () => {
    const fx = fixtures()
    let dispatches = 0
    fx.actions.dispatch = async () => { dispatches++; throw new GitHubError('POST', '/dispatches', 422, 'dispatch rejected') }
    const comment = fx.github.comment.bind(fx.github)
    fx.github.comment = async () => { throw new Error('comment unavailable') }
    const file = join(tmp(), 'state.json')
    const state = createState(file)
    const options = { settings: settingsWithActions, dispatchSecret: CALLBACK_SECRET, github: fx.github, actions: fx.actions }
    let handler = createHandler({ ...options, state })
    await handler.handle({ event: 'issue_comment', payload: commentPayload() })
    await handler.idle()
    const [pending] = createState(file).pending()
    assert.ok(pending, 'undelivered blocked result must remain on disk')
    assert.equal(pending.result.verdict, 'blocked')
    assert.match(pending.result.body, /could not be started/)
    await handler.sweep()
    assert.equal(createState(file).pending().length, 1, 'continued delivery failure must remain retryable')
    if (recovery === 'restart') {
      handler = createHandler({ ...options, state: createState(file) })
      await handler.idle()
    }
    fx.github.comment = comment
    await handler.sweep()
    await handler.sweep()
    assert.deepEqual(createState(file).pending(), [])
    assert.equal(dispatches, 1, 'recovery must not redispatch the workflow')
    const comments = fx.github.calls.filter(c => c[0] === 'comment')
    assert.equal(comments.length, 1)
    assert.equal(comments[0][3], pending.result.body)
  })
}

test('the Actions runner waits on the scheduler lock and releases it after a failed child', async () => {
  const { acquireLock, readLock } = await import('../../pipeline/lib/lock.mjs')
  const directory = tmp(), held = acquireLock('scheduler', 'pipeline', { directory })
  let started = false
  const execution = runAction({ env: runnerEnv({ QA_PIPELINE_LOCK_DIR: directory }), outDir: tmp(), lockOptions: { pollMs: 5, waitMs: 500 },
    run: async () => { started = true; assert.equal(readLock('pipeline', { directory }).runId, `action-${REVIEW_ID}`); throw new Error('child failed') }, post: async () => {} })
  // Attach immediately so the pre-fix rejection does not become an unhandled rejection.
  const checked = assert.rejects(execution, /child failed/)
  await new Promise(resolve => setTimeout(resolve, 30))
  const raced = started
  held.release()
  await checked
  assert.equal(raced, false)
  assert.equal(started, true)
  assert.equal(readLock('pipeline', { directory }), null)
})

test('a signed 90 minute review gives Playwright its entire configured budget', async () => {
  const env = runnerEnv({ REVIEW_JOB_TIMEOUT_MINUTES: '150', REVIEW_TIMEOUT_MINUTES: '90' })
  env.REVIEW_DISPATCH_TOKEN = signDispatch(CALLBACK_SECRET, TESTS, 'main', dispatchInputs({ reviewId: REVIEW_ID, repository: REPO, number: 12, sha: SHA, baseUrl: BASE, chainId: 97, playwrightArgs: ['--project=chromium'], requestedBy: 'alice', timeoutMinutes: 90 }))
  let budget
  await runAction({ env, outDir: tmp(), run: async (_, __, options) => { budget = options.timeoutMs; return { code: 0 } }, post: async () => {} })
  assert.equal(budget, 5400000)
  for (const invalid of ['', '0', '-1', '181', '1.5', 'NaN']) assert.throws(() => readInputs({ ...env, REVIEW_TIMEOUT_MINUTES: invalid }), /REVIEW_TIMEOUT_MINUTES/)
  for (const invalid of ['', 'relative/path']) assert.throws(() => readInputs({ ...env, QA_PIPELINE_LOCK_DIR: invalid }), /QA_PIPELINE_LOCK_DIR/)
})

test('an occupied wallet reports blocked immediately when lock waiting expires', async () => {
  const { acquireLock } = await import('../../pipeline/lib/lock.mjs')
  const directory = tmp(), lock = acquireLock('scheduler', 'pipeline', { directory }), posted = []
  try {
    const verdict = await runAction({ env: runnerEnv({ QA_PIPELINE_LOCK_DIR: directory }), outDir: tmp(), lockOptions: { waitMs: 0 },
      run: async () => assert.fail('wallet was busy'), post: async args => posted.push(args.report) })
    assert.equal(verdict, 'blocked')
    assert.match(posted[0].headline, /shared test wallet/)
  } finally { lock.release() }
})

for (const lookup of ['missing', 'existing', 'error']) test(`restart reconciles an interrupted dispatch: ${lookup}`, async () => {
  const file = join(tmp(), 'state.json'), state = createState(file)
  const inputs = dispatchInputs({ reviewId: REVIEW_ID, repository: REPO, number: 12, sha: SHA, baseUrl: BASE, chainId: 97, playwrightArgs: ['--project=chromium'], requestedBy: 'alice' })
  const token = signDispatch(CALLBACK_SECRET, TESTS, 'main', inputs)
  state.claim(555, { repo: REPO, number: 12, actor: 'alice', reviewId: REVIEW_ID, checkId: 4242, sha: SHA, testsRepository: TESTS, ref: 'main', dispatchToken: token, dispatchInputs: inputs, dispatchState: 'pending', expiresAt: Date.now() + 3600000 })
  const fx = fixtures({ findRun: async () => {
    if (lookup === 'error') throw new Error('GitHub unavailable')
    return lookup === 'existing' ? { id: 99, url: 'https://github.com/globalmpc/mpc-automation/actions/runs/99' } : null
  } })
  const handler = createHandler({ settings: settingsWithActions, dispatchSecret: CALLBACK_SECRET, github: fx.github, actions: fx.actions, state: createState(file) })
  await Promise.all([handler.sweep(), handler.sweep()])
  await handler.sweep()
  assert.equal(fx.actions.dispatched.length, lookup === 'missing' ? 1 : 0)
  if (lookup === 'missing') assert.deepEqual(fx.actions.dispatched[0], { testsRepository: TESTS, ref: 'main', inputs: { ...inputs, dispatch_token: token } })
  const saved = createState(file).pending()[0]
  assert.equal(saved.dispatchState, lookup === 'error' ? 'pending' : 'dispatched')
  if (lookup === 'existing') assert.equal(saved.runId, 99)
})

test('dispatch intent is durable before contacting GitHub', async () => {
  const file = join(tmp(), 'state.json'), state = createState(file), fx = fixtures()
  let checked = false
  fx.actions.dispatch = async ({ inputs, ref, testsRepository }) => {
    const saved = createState(file).pending()[0]
    assert.equal(saved.dispatchState, 'pending')
    assert.equal(saved.ref, ref)
    assert.equal(saved.testsRepository, testsRepository)
    assert.deepEqual({ ...saved.dispatchInputs, dispatch_token: saved.dispatchToken }, inputs)
    checked = true
  }
  const handler = createHandler({ settings: settingsWithActions, dispatchSecret: CALLBACK_SECRET, github: fx.github, actions: fx.actions, state })
  await handler.handle({ event: 'issue_comment', payload: commentPayload() })
  await handler.idle()
  assert.equal(checked, true)
  assert.equal(createState(file).pending()[0].dispatchState, 'dispatched')
})

for (const status of [null, 408, 429, 500, 502]) test(`uncertain dispatch failure (${status}) preserves the intent and accepts the eventual callback`, async () => {
  const error = status === null ? new Error('response timed out') : new GitHubError('POST', '/dispatches', status, 'unavailable')
  const fx = fixtures({ dispatchError: error }), state = createState(join(tmp(), 'state.json'))
  const handler = createHandler({ settings: settingsWithActions, dispatchSecret: CALLBACK_SECRET, github: fx.github, actions: fx.actions, state })
  await handler.handle({ event: 'issue_comment', payload: commentPayload() }); await handler.idle()
  const [job] = state.pending()
  assert.ok(job)
  assert.equal(job.dispatchState, 'pending')
  assert.equal(job.result, undefined)
  assert.equal(fx.actions.finished.length, 0)
  assert.equal(fx.github.calls.filter(c => c[0] === 'comment').length, 0)
  await handler.sweep()
  assert.equal(state.pending()[0].runId, 99)
  assert.deepEqual(await handler.completeReview({ ...validReport, reviewId: job.reviewId, dispatchToken: job.dispatchToken }), { status: 'accepted', reason: 'reported' })
  assert.equal(fx.actions.finished[0].verdict, 'passed')
  assert.equal(state.pending().length, 0)
})

for (const secret of [undefined, '', 'short']) test(`reloading Actions policy with invalid secret ${String(secret)} creates no check`, async () => {
  let config = parseSettings({ testsRepository: TESTS, testsRef: 'main', repositories: { [REPO]: { previewHostPrefix: 'web' } } })
  const fx = fixtures(), state = createState(join(tmp(), 'state.json'))
  let checks = 0
  fx.actions.createCheck = async () => { checks++; return 4242 }
  const handler = createHandler({ settings: () => config, dispatchSecret: secret, github: fx.github, actions: fx.actions, state })
  config = settingsWithActions()
  await handler.handle({ event: 'issue_comment', payload: commentPayload() }); await handler.idle()
  assert.equal(checks, 0)
  assert.equal(fx.actions.dispatched.length, 0)
  assert.equal(state.pending().length, 0)
  assert.match(fx.github.calls.find(c => c[0] === 'comment')[3], /could not run/)
})
