import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
import { createHandler } from '../../pipeline/github-app/handler.mjs'
import { createWebhookServer } from '../../pipeline/github-app/server.mjs'
import { createGitHub, findPreview } from '../../pipeline/github-app/github.mjs'
import { createReviewer, SetupError } from '../../pipeline/github-app/reviewer.mjs'
import { createState } from '../../pipeline/github-app/state.mjs'
import { parseSettings } from '../../pipeline/github-app/policy.mjs'
import { sign } from '../../pipeline/github-app/signature.mjs'
import { diagnose } from '../../pipeline/github-app/doctor.mjs'

const REPO = 'globalmpc/web', SHA = 'a'.repeat(40)
const settings = () => parseSettings({ testsRepository: 'globalmpc/mpc-automation', testsRef: 'review', repositories: { [REPO]: { previewHostPrefix: 'web' } } })
const tmp = () => mkdtempSync(join(tmpdir(), 'ghapp-'))

function fakeGitHub(overrides = {}) {
  const calls = []
  const record = name => (...args) => { calls.push([name, ...args]); return Promise.resolve(overrides[name]?.(...args) ?? null) }
  const api = {
    calls,
    permissionOf: async (...args) => overrides.permissionOf ? overrides.permissionOf(...args) : 'write',
    pull: record('pull'), react: record('react'), comment: record('comment'),
    deployments: record('deployments'), deploymentStatuses: record('deploymentStatuses'),
  }
  api.pull = (...a) => { calls.push(['pull', ...a]); return Promise.resolve(overrides.pull ? overrides.pull(...a) : { state: 'open', head: { sha: SHA, repo: { full_name: REPO } } }) }
  api.pullFiles = (...a) => { calls.push(['pullFiles', ...a]); return Promise.resolve(overrides.pullFiles ? overrides.pullFiles(...a) : ['README.md']) }
  api.deployments = (...a) => { calls.push(['deployments', ...a]); return Promise.resolve(overrides.deployments ? overrides.deployments(...a) : [{ id: 9, sha: SHA, environment: 'Preview', creator: { login: 'vercel[bot]' } }]) }
  api.deploymentStatuses = (...a) => { calls.push(['deploymentStatuses', ...a]); return Promise.resolve(overrides.deploymentStatuses ? overrides.deploymentStatuses(...a) : [{ state: 'success', environment_url: 'https://web-git-feat-team.vercel.app/' }]) }
  return api
}
const payload = (over = {}) => ({
  action: 'created', repository: { full_name: REPO }, sender: { type: 'User', login: 'alice' },
  issue: { number: 12, state: 'open', pull_request: {} },
  comment: { id: 555, body: '/automation review', author_association: 'MEMBER', user: { login: 'alice', type: 'User' } }, ...over,
})
const setup = (gh, runReview, extra = {}) => {
  const handler = createHandler({ settings, github: gh, runReview, state: createState(join(tmp(), 'state.json')), ...extra })
  return handler
}
const passing = async () => ({ verdict: 'passed', summary: { passed: 4, failed: [], flaky: 0, skipped: 1 }, durationMs: 5000, tests: { repository: 'globalmpc/mpc-automation', ref: 'review', sha: 'b'.repeat(40) } })
const names = gh => gh.calls.map(c => c[0])

test('authorized member: 👀 reaction first, then one pass comment that names the PR commit and preview', async () => {
  const gh = fakeGitHub(), seen = []
  const handler = setup(gh, async args => { seen.push(args); return passing() })
  const out = await handler.handle({ event: 'issue_comment', payload: payload() })
  assert.deepEqual(out, { status: 'accepted', reason: 'queued' })
  await handler.idle()
  assert.deepEqual(gh.calls.find(c => c[0] === 'react').slice(1), [REPO, 555, 'eyes'])
  assert.ok(names(gh).indexOf('react') < names(gh).indexOf('comment'))
  assert.equal(names(gh).filter(n => n === 'comment').length, 1)
  const body = gh.calls.find(c => c[0] === 'comment')[3]
  assert.match(body, /Automation review passed/); assert.match(body, /`aaaaaaa`/); assert.match(body, /web-git-feat-team\.vercel\.app/)
  assert.equal(seen[0].baseUrl, 'https://web-git-feat-team.vercel.app'); assert.equal(seen[0].chainId, 97)
})

test('a repository with a fixed target tests it without looking for a preview', async () => {
  const gh = fakeGitHub(), seen = []
  const fixedSettings = () => parseSettings({ testsRepository: 'globalmpc/mpc-automation', testsRef: 'review', repositories: { [REPO]: { target: { baseUrl: 'https://demo-git-x-team.vercel.app/' } } } })
  const handler = createHandler({ settings: fixedSettings, github: gh, runReview: async a => { seen.push(a); return passing() }, state: createState(join(tmp(), 'state.json')) })
  await handler.handle({ event: 'issue_comment', payload: payload() }); await handler.idle()
  assert.equal(seen[0].baseUrl, 'https://demo-git-x-team.vercel.app'); assert.ok(!names(gh).includes('deployments'))
})

test('a local-stack repository skips preview lookup and labels the target it tested', async () => {
  const gh = fakeGitHub(), seen = []
  const s = () => parseSettings({ testsRepository: 'globalmpc/mpc-automation', testsRef: 'review', repositories: { [REPO]: { target: { type: 'local-stack' } } } })
  const handler = createHandler({ settings: s, github: gh, runReview: async a => { seen.push(a); return { ...(await passing()), targetLabel: 'local test stack · local-docker · chain 97' } }, state: createState(join(tmp(), 'state.json')) })
  await handler.handle({ event: 'issue_comment', payload: payload() }); await handler.idle()
  assert.equal(seen[0].localStack, 'local-docker'); assert.ok(!names(gh).includes('deployments'))
  assert.match(gh.calls.find(c => c[0] === 'comment')[3], /Target tested:\*\* local test stack · local-docker · chain 97/)
})

test('local stack: refuses when the stack is down or not isolated, otherwise uses the profile (never the PR) for the target', async () => {
  const workRoot = tmp(), lockDirectory = tmp(), calls = []
  const github = { resolveCommit: async () => 'a1'.repeat(20), contentsToken: async () => 't' }
  const run = async (command, args, options) => { calls.push({ args, options }); if (args[1] === 'test') writeFileSync(options.env.PLAYWRIGHT_JSON_OUTPUT_NAME, JSON.stringify({ suites: [{ title: 'f', specs: [{ title: 'T', tests: [{ status: 'expected' }] }] }] })); return { code: 0, durationMs: 1 } }
  const profile = { name: 'local-docker', isolated: true, allowWrites: true, baseUrl: 'http://localhost:3460', appOrigin: 'http://localhost:3460', chainId: 97, chainName: 'Local Anvil', navigation: 'activities', stack: { composeProject: 'p1', verificationRuntime: true } }
  const warmed = []
  const make = over => createReviewer({ github, workRoot, run, env: { QA_SEED_PHRASE: 'x'.repeat(20), WALLET_ADDRESS: '0x1' }, lockOptions: { pollMs: 5, waitMs: 50, lockDirectory },
    local: { resolveEnvironment: () => profile, stackStatus: async () => ({ healthy: true }), warmBrowserRuntime: async p => { warmed.push(p.name) }, ...over } })
  const args = { repo: REPO, number: 3, sha: SHA, localStack: 'local-docker', chainId: 97, settings: settings(), repoSettings: settings().repositories.get(REPO) }
  await assert.rejects(make({ stackStatus: async () => ({ healthy: false, unhealthyServices: ['web'] }) })(args), /not running: web\..*npm run stack:up|not running: web\. Start it with "npm run stack:up"/)
  await assert.rejects(make({ stackStatus: async () => ({ healthy: false, error: 'Docker is not running' }) })(args), /Docker is not running/)
  await assert.rejects(make({ resolveEnvironment: () => ({ ...profile, isolated: false }) })(args), /not an isolated local stack/)
  await assert.rejects(make({ warmBrowserRuntime: async () => { throw new Error('boom') } })(args), /not answering/)
  assert.equal(calls.length, 0)
  const result = await make()({ ...args, baseUrl: 'https://attacker.vercel.app' })
  assert.equal(result.verdict, 'passed'); assert.equal(result.targetLabel, 'local test stack · local-docker · chain 97'); assert.deepEqual(warmed, ['local-docker'])
  const e = calls.find(c => c.args[1] === 'test').options.env
  assert.equal(e.BASE_URL, 'http://localhost:3460'); assert.equal(e.QA_CHAIN_ID, '97'); assert.equal(e.QA_ALLOW_WRITES, '1'); assert.equal(e.QA_ENVIRONMENT, 'local-docker'); assert.equal(e.QA_WEB_FIXTURE_CONTAINER, 'p1-web-1')
})

test('failed run posts a failure comment', async () => {
  const gh = fakeGitHub(), handler = setup(gh, async () => ({ verdict: 'failed', summary: { passed: 1, failed: ['Wallet › sign in'], flaky: 0, skipped: 0 }, tests: null }))
  await handler.handle({ event: 'issue_comment', payload: payload() }); await handler.idle()
  const body = gh.calls.filter(c => c[0] === 'comment').at(-1)[3]
  assert.match(body, /Automation review failed/); assert.match(body, /Wallet › sign in/)
})

test('unauthorized commenters cause no GitHub side effects and never reach the runner', async () => {
  for (const association of ['NONE', 'CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', undefined]) {
    const gh = fakeGitHub({ permissionOf: async () => 'read' }); let ran = false
    const handler = setup(gh, async () => { ran = true })
    const out = await handler.handle({ event: 'issue_comment', payload: payload({ comment: { ...payload().comment, author_association: association } }) })
    await handler.idle()
    assert.deepEqual(out, { status: 'rejected', reason: 'not-authorized' }); assert.deepEqual(gh.calls, []); assert.equal(ran, false)
  }
})

test('ignored: other events/actions, other repositories, issues, closed PRs, non-commands, bots, edits', async () => {
  const cases = [
    ['pull_request', payload()], ['issue_comment', payload({ action: 'edited' })], ['issue_comment', payload({ action: 'deleted' })],
    ['issue_comment', payload({ repository: { full_name: 'globalmpc/other' } })], ['issue_comment', payload({ issue: { number: 1, state: 'open' } })],
    ['issue_comment', payload({ issue: { number: 1, state: 'closed', pull_request: {} } })],
    ['issue_comment', payload({ comment: { ...payload().comment, body: 'looks good' } })],
    ['issue_comment', payload({ comment: { ...payload().comment, user: { login: 'bot[bot]', type: 'Bot' } } })],
    ['issue_comment', payload({ sender: { type: 'Bot', login: 'x[bot]' } })], ['issue_comment', {}], ['issue_comment', payload({ issue: { number: '12', state: 'open', pull_request: {} } })],
  ]
  for (const [event, body] of cases) {
    const gh = fakeGitHub(), handler = setup(gh, passing)
    assert.equal((await handler.handle({ event, payload: body })).status, 'ignored')
    assert.deepEqual(gh.calls, [])
  }
})

test('the same comment is never processed twice, even after a restart', async () => {
  const file = join(tmp(), 'state.json'), gh = fakeGitHub(); let runs = 0
  const make = () => createHandler({ settings, github: gh, runReview: async () => { runs++; return passing() }, state: createState(file) })
  const first = make()
  await first.handle({ event: 'issue_comment', payload: payload() }); await first.idle()
  const again = make()
  assert.deepEqual(await again.handle({ event: 'issue_comment', payload: payload() }), { status: 'ignored', reason: 'duplicate' })
  assert.equal(runs, 1)
})

test('fork pull requests and closed PRs are refused with a notice and never run', async () => {
  for (const [pull, text] of [[{ state: 'open', head: { sha: SHA, repo: { full_name: 'stranger/web' } } }, /forks/], [{ state: 'open', head: { sha: SHA, repo: null } }, /forks/], [{ state: 'closed', head: { sha: SHA, repo: { full_name: REPO } } }, /no longer open/]]) {
    const gh = fakeGitHub({ pull: () => pull }); let ran = false
    const handler = setup(gh, async () => { ran = true })
    await handler.handle({ event: 'issue_comment', payload: payload() }); await handler.idle()
    assert.equal(ran, false); assert.match(gh.calls.find(c => c[0] === 'comment')[3], text)
  }
})

test('no ready Vercel preview: explains instead of guessing a target', async () => {
  for (const overrides of [{ deployments: () => [] }, { deploymentStatuses: () => [{ state: 'pending', environment_url: 'https://web-a.vercel.app/' }] },
    { deployments: () => [{ id: 1, sha: SHA, environment: 'Preview', creator: { login: 'mallory' } }] }, { deployments: () => [{ id: 1, sha: 'c'.repeat(40), environment: 'Preview', creator: { login: 'vercel[bot]' } }] },
    { deployments: () => [{ id: 1, sha: SHA, environment: 'Production', creator: { login: 'vercel[bot]' } }] }, { deploymentStatuses: () => [{ state: 'success', environment_url: 'https://evil.example.com/' }] }]) {
    const gh = fakeGitHub(overrides); let ran = false
    const handler = setup(gh, async () => { ran = true })
    await handler.handle({ event: 'issue_comment', payload: payload() }); await handler.idle()
    assert.equal(ran, false); assert.match(gh.calls.find(c => c[0] === 'comment')[3], /No preview to test/)
  }
})

test('internal errors are reported generically; setup errors give their reason; secrets from errors are not echoed', async () => {
  let gh = fakeGitHub(), handler = setup(gh, async () => { throw new Error('token ghs_SECRET leaked in stack') })
  await handler.handle({ event: 'issue_comment', payload: payload() }); await handler.idle()
  let body = gh.calls.find(c => c[0] === 'comment')[3]
  assert.match(body, /internal error/); assert.ok(!body.includes('ghs_SECRET'))
  gh = fakeGitHub(); handler = setup(gh, async () => { throw new SetupError('the test wallet credentials are not configured on the automation server') })
  await handler.handle({ event: 'issue_comment', payload: payload() }); await handler.idle()
  assert.match(gh.calls.find(c => c[0] === 'comment')[3], /wallet credentials are not configured/)
})

test('reviews run one at a time and a PR already in the queue is not queued twice', async () => {
  const gh = fakeGitHub(); let active = 0, peak = 0, release
  const gate = new Promise(resolve => { release = resolve })
  const handler = setup(gh, async () => { active++; peak = Math.max(peak, active); await gate; active--; return passing() })
  const p = (n, id) => payload({ issue: { number: n, state: 'open', pull_request: {} }, comment: { ...payload().comment, id } })
  assert.equal((await handler.handle({ event: 'issue_comment', payload: p(1, 1) })).status, 'accepted')
  assert.equal((await handler.handle({ event: 'issue_comment', payload: p(2, 2) })).status, 'accepted')
  assert.deepEqual(await handler.handle({ event: 'issue_comment', payload: p(1, 3) }), { status: 'rejected', reason: 'already-active' })
  release(); await handler.idle()
  assert.equal(peak, 1); assert.equal(names(gh).filter(n => n === 'comment').length, 3)
})

test('queue limit', async () => {
  const gh = fakeGitHub(); let release
  const handler = setup(gh, async () => { await new Promise(r => { release = r }); return passing() }, { queueLimit: 1 })
  const p = n => payload({ issue: { number: n, state: 'open', pull_request: {} }, comment: { ...payload().comment, id: n } })
  const r = []
  for (const n of [1, 2, 3]) r.push((await handler.handle({ event: 'issue_comment', payload: p(n) })).reason)
  assert.deepEqual(r, ['queued', 'queued', 'queue-full'])
})

test('HTTP: bad or missing signatures get 401 and nothing runs; valid ones are acknowledged; healthz works', async () => {
  const secret = 'webhook-secret-for-tests-only', calls = []
  const server = createWebhookServer({ secret, handler: { handle: async a => { calls.push(a); return { status: 'accepted', reason: 'queued' } } } })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  const body = JSON.stringify(payload())
  const post = (headers, b = body) => fetch(`${base}/webhooks/github`, { method: 'POST', body: b, headers: { 'content-type': 'application/json', 'x-github-event': 'issue_comment', ...headers } })
  try {
    assert.equal((await post({})).status, 401)
    assert.equal((await post({ 'x-hub-signature-256': sign('wrong-secret-wrong-secret', body) })).status, 401)
    assert.equal((await post({ 'x-hub-signature-256': sign(secret, body) }, body + ' ')).status, 401)
    assert.equal(calls.length, 0)
    const ok = await post({ 'x-hub-signature-256': sign(secret, body), 'x-github-delivery': 'd1' })
    assert.equal(ok.status, 202); assert.equal(calls.length, 1); assert.equal(calls[0].event, 'issue_comment'); assert.equal(calls[0].payload.comment.id, 555)
    const bad = '{not json'; assert.equal((await post({ 'x-hub-signature-256': sign(secret, bad) }, bad)).status, 400)
    assert.equal((await fetch(`${base}/healthz`)).status, 200)
    assert.equal((await fetch(`${base}/webhooks/github`)).status, 404)
    assert.equal((await fetch(`${base}/nope`, { method: 'POST' })).status, 404)
    const huge = 'x'.repeat(6 * 1024 * 1024)
    await post({ 'x-hub-signature-256': sign(secret, huge) }, huge).then(r => assert.equal(r.status, 413), () => {})
    assert.equal(calls.length, 1)
  } finally { server.close(); server.closeAllConnections?.() }
})

test('GitHub client signs an app JWT and scopes installation tokens to one repository, caching them', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const seen = []
  const fetchImpl = async (url, init) => {
    seen.push([url, init.method, init.headers.authorization.slice(0, 20), init.body])
    const json = body => ({ ok: true, status: 200, text: async () => JSON.stringify(body) })
    if (url.endsWith('/installation')) return json({ id: 77 })
    if (url.includes('/access_tokens')) return json({ token: 'ghs_x', expires_at: new Date(Date.now() + 3600_000).toISOString() })
    return json({ id: 1 })
  }
  const gh = createGitHub({ appId: '123', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }), fetchImpl, apiUrl: 'https://api.test' })
  await gh.react(REPO, 5, 'eyes'); await gh.comment(REPO, 3, 'hi')
  const tokenCalls = seen.filter(s => s[0].includes('/access_tokens'))
  assert.equal(tokenCalls.length, 1); assert.deepEqual(JSON.parse(tokenCalls[0][3]), { repositories: ['web'] })
  assert.match(seen[0][2], /^Bearer eyJ/)
  const reaction = seen.find(s => s[0].endsWith('/issues/comments/5/reactions')); assert.deepEqual(JSON.parse(reaction[3]), { content: 'eyes' })
  await gh.contentsToken('globalmpc/mpc-automation')
  assert.deepEqual(JSON.parse(seen.filter(s => s[0].includes('/access_tokens')).at(-1)[3]), { repositories: ['mpc-automation'], permissions: { contents: 'read', metadata: 'read' } })
})

test('findPreview ignores deployments not created by the trusted integration', async () => {
  const gh = fakeGitHub({ deployments: () => [{ id: 1, sha: SHA, environment: 'Preview', creator: { login: 'mallory' } }, { id: 2, sha: SHA, environment: 'Preview – web', creator: { login: 'vercel[bot]' } }] })
  assert.equal(await findPreview(gh, REPO, SHA, { prefix: 'web' }), 'https://web-git-feat-team.vercel.app')
  assert.deepEqual(gh.calls.filter(c => c[0] === 'deploymentStatuses').map(c => c[2]), [2])
})

test('reviewer: refuses without wallet credentials; passes only allowlisted env; wallet secret only to the test step; no token in argv', async () => {
  const workRoot = tmp(), lockDirectory = tmp(), calls = []
  const github = { resolveCommit: async () => 'd'.repeat(40), contentsToken: async () => 'ghs_CHECKOUT_TOKEN' }
  const run = async (command, args, options) => {
    calls.push({ command, args, options })
    if (args[0] === 'playwright' && args[1] === 'test') writeFileSync(options.env.PLAYWRIGHT_JSON_OUTPUT_NAME, JSON.stringify({ suites: [{ title: 'f', specs: [{ title: 'T1', tests: [{ status: 'expected' }] }] }] }))
    return { code: 0, durationMs: 1234 }
  }
  const base = { github, workRoot, run, lockOptions: { pollMs: 5, waitMs: 100, lockDirectory } }
  const args = { repo: REPO, number: 3, sha: SHA, baseUrl: 'https://web-a.vercel.app', chainId: 97, settings: settings(), repoSettings: settings().repositories.get(REPO) }
  await assert.rejects(createReviewer({ ...base, env: {} })(args), SetupError)
  const env = { QA_SEED_PHRASE: 'test test test test test test test test test test test junk', WALLET_ADDRESS: '0xabc', GITHUB_WEBHOOK_SECRET: 'whsec', SLACK_BOT_TOKEN: 'xoxb' }
  const result = await createReviewer({ ...base, env })(args)
  assert.equal(result.verdict, 'passed'); assert.equal(result.tests.sha, 'd'.repeat(40))
  const playwright = calls.find(c => c.args[0] === 'playwright' && c.args[1] === 'test')
  assert.deepEqual(playwright.args.slice(0, 3), ['playwright', 'test', '--project=chromium']); assert.ok(playwright.args.includes('--reporter=json'))
  assert.deepEqual(playwright.options.passSecrets, ['QA_SEED_PHRASE']); assert.equal(playwright.options.env.BASE_URL, 'https://web-a.vercel.app'); assert.equal(playwright.options.env.QA_CHAIN_ID, '97')
  assert.ok(!playwright.options.onlyEnv.some(k => /SECRET|TOKEN|KEY/.test(k)))
  for (const c of calls.filter(c => c !== playwright)) { assert.equal(c.options.passSecrets, undefined); assert.ok(!c.options.env.QA_SEED_PHRASE); assert.ok(!JSON.stringify(c.args).includes('CHECKOUT_TOKEN')) }
  const fetchCall = calls.find(c => c.args[0] === 'fetch'); assert.match(fetchCall.options.env.GIT_CONFIG_VALUE_0, /^AUTHORIZATION: basic /)
  assert.ok(!JSON.stringify(calls.map(c => c.args)).includes('x-access-token'))
  // Second review of the same tests commit reuses the prepared checkout.
  const before = calls.length
  await createReviewer({ ...base, env })(args)
  assert.deepEqual(calls.slice(before).map(c => c.args[0]), ['playwright'])
})

test('reviewer: all-skipped run is blocked; a failing run keeps its failures; lock is released', async () => {
  const workRoot = tmp(), lockDirectory = tmp()
  const github = { resolveCommit: async () => 'e'.repeat(40), contentsToken: async () => 't' }
  const mk = (results, code) => async (command, args, options) => { if (args[1] === 'test') writeFileSync(options.env.PLAYWRIGHT_JSON_OUTPUT_NAME, JSON.stringify(results)); return { code: args[1] === 'test' ? code : 0, durationMs: 1 } }
  const env = { QA_SEED_PHRASE: 'x'.repeat(20), WALLET_ADDRESS: '0x1' }
  const args = { repo: REPO, number: 3, sha: SHA, baseUrl: 'https://web-a.vercel.app', chainId: 97, settings: settings(), repoSettings: settings().repositories.get(REPO) }
  const lockOptions = { pollMs: 5, waitMs: 100, lockDirectory }
  const skipped = await createReviewer({ github, workRoot, env, lockOptions, run: mk({ suites: [{ title: 'f', specs: [{ title: 'T', tests: [{ status: 'skipped' }] }] }] }, 0) })(args)
  assert.equal(skipped.verdict, 'blocked')
  const failed = await createReviewer({ github, workRoot, env, lockOptions, run: mk({ suites: [{ title: 'f', specs: [{ title: 'Bad', tests: [{ status: 'unexpected' }] }] }] }, 1) })(args)
  assert.equal(failed.verdict, 'failed'); assert.deepEqual(failed.summary.failed, ['Bad'])
  const missing = await createReviewer({ github, workRoot, env, lockOptions, run: async (c, a) => ({ code: a[1] === 'test' ? 1 : 0, durationMs: 1 }) })(args)
  assert.equal(missing.verdict, 'blocked')
  assert.equal(existsSync(join(lockDirectory, 'pipeline.lock')), false)
})

test('reviewer: waits for the shared pipeline lock and gives up with a clear reason', async () => {
  const { acquireLock } = await import('../../pipeline/lib/lock.mjs')
  const lockDirectory = tmp(), held = acquireLock('other-run', 'pipeline', { directory: lockDirectory })
  const github = { resolveCommit: async () => 'f'.repeat(40), contentsToken: async () => 't' }
  const reviewer = createReviewer({ github, workRoot: tmp(), env: { QA_SEED_PHRASE: 'x'.repeat(20), WALLET_ADDRESS: '0x1' }, run: async () => ({ code: 0 }), lockOptions: { pollMs: 5, waitMs: 30, lockDirectory } })
  try { await assert.rejects(reviewer({ repo: REPO, number: 1, sha: SHA, baseUrl: 'https://a.vercel.app', chainId: 97, settings: settings(), repoSettings: settings().repositories.get(REPO) }), /held the shared test wallet/) }
  finally { held.release() }
})

test('doctor reports every gap the live App has, and passes a correctly configured one', () => {
  const s = settings()
  const good = { app: { permissions: { metadata: 'read', contents: 'read', issues: 'read', pull_requests: 'write', deployments: 'read' }, events: ['issue_comment', 'pull_request'] }, hook: { url: 'https://x.test/webhooks/github', insecure_ssl: '0' },
    installations: [{ account: 'globalmpc', selection: 'selected', repositories: ['globalmpc/web', 'globalmpc/mpc-automation'], permissions: { metadata: 'read', contents: 'read', issues: 'read', pull_requests: 'write', deployments: 'read' } }], settings: s }
  assert.deepEqual(diagnose(good).gaps, [])
  const missingIssues = diagnose({ ...good, app: { ...good.app, permissions: { ...good.app.permissions, issues: undefined } } })
  assert.equal(missingIssues.ok, false)
  assert.match(missingIssues.gaps.join('\n'), /issues/)
  const fixedOnly = parseSettings({ testsRepository: 'globalmpc/mpc-automation', testsRef: 'r', repositories: { [REPO]: { target: { baseUrl: 'https://d-x.vercel.app/' } } } })
  const noDeploy = { ...good, settings: fixedOnly, app: { ...good.app, permissions: { metadata: 'read', contents: 'read', issues: 'read', pull_requests: 'write' } } }
  assert.deepEqual(diagnose(noDeploy).gaps, [])
  const personal = { account: 'someone', selection: 'selected', repositories: ['someone/x'], permissions: {} }
  assert.deepEqual(diagnose({ ...good, installations: [...good.installations, personal] }).gaps, [])
  const bad = diagnose({ ...good, app: { permissions: { metadata: 'read', contents: 'read', pull_requests: 'read' }, events: ['push'] }, installations: [{ account: 'globalmpc', selection: 'selected', repositories: ['globalmpc/other'], permissions: { pull_requests: 'read' } }], hook: {} })
  const text = bad.gaps.join('\n')
  for (const needle of ['pull_requests', 'deployments', 'issue_comment', 'pull_request"', 'No webhook URL', 'globalmpc/web', 'globalmpc/mpc-automation']) assert.match(text, new RegExp(needle))
})

test('a crash after claiming a review recovers the job at startup without redelivery', async () => {
  const file = join(tmp(), 'state.json')
  const firstState = createState(file)
  const first = setup(fakeGitHub(), passing, { state: firstState, log: event => { if (event === 'accepted') throw new Error('simulated exit') } })
  await assert.rejects(first.handle({ event: 'issue_comment', payload: payload() }), /simulated exit/)
  const gh = fakeGitHub(); let runs = 0
  const recovered = createHandler({ settings, github: gh, state: createState(file), runReview: async () => { runs++; return passing() } })
  await recovered.idle()
  assert.equal(runs, 1)
  const restarted = createHandler({ settings, github: gh, state: createState(file), runReview: async () => { runs++; return passing() } })
  await restarted.idle()
  assert.equal(runs, 1)
  assert.equal((await restarted.handle({ event: 'issue_comment', payload: payload() })).reason, 'duplicate')
})

for (const resultFile of ['missing', 'invalid', 'unreadable']) test(`reviewer reports ${resultFile} results as unverified`, async () => {
  const { mkdirSync } = await import('node:fs')
  const reviewer = createReviewer({ github: { resolveCommit: async () => SHA, contentsToken: async () => 'test-token' }, workRoot: tmp(),
    env: { QA_SEED_PHRASE: 'test wallet secret', WALLET_ADDRESS: '0x1' }, lockOptions: { lockDirectory: tmp() },
    run: async (cmd, args, options) => {
      if (args[1] === 'test') {
        if (resultFile === 'invalid') writeFileSync(options.env.PLAYWRIGHT_JSON_OUTPUT_NAME, '{broken')
        if (resultFile === 'unreadable') mkdirSync(options.env.PLAYWRIGHT_JSON_OUTPUT_NAME)
        return { code: 1 }
      }
      return { code: 0 }
    } })
  const result = await reviewer({ repo: REPO, number: 1, sha: SHA, baseUrl: 'https://web-a.vercel.app', chainId: 97, settings: settings(), repoSettings: settings().repositories.get(REPO) })
  assert.equal(result.verdict, 'blocked')
  assert.equal(result.summary, null)
})

test('pending jobs survive history pruning and legacy completed IDs stay deduplicated', () => {
  const file = join(tmp(), 'state.json')
  writeFileSync(file, JSON.stringify({ handled: { 1: '2026-01-01T00:00:00.000Z' } }))
  const state = createState(file, { limit: 1 })
  assert.equal(state.claim(1), false)
  assert.equal(state.claim(2, { repo: REPO, number: 12, actor: 'alice' }), true)
  state.claim(3)
  state.claim(4)
  const recovered = createState(file)
  assert.equal(recovered.claim(2), false)
  assert.deepEqual(recovered.pending(), [{ repo: REPO, number: 12, actor: 'alice', commentId: 2 }])
  recovered.complete(2)
  assert.deepEqual(createState(file).pending(), [])
  assert.equal(createState(file).claim(2), false)
})

test('a job interrupted during its reaction is recovered and reserves its PR immediately', async () => {
  const file = join(tmp(), 'state.json')
  const first = setup(fakeGitHub({ react: () => new Promise(() => {}) }), passing, { state: createState(file) })
  await first.handle({ event: 'issue_comment', payload: payload() })
  const duplicatePR = payload({ comment: { ...payload().comment, id: 556 } })
  assert.equal((await first.handle({ event: 'issue_comment', payload: duplicatePR })).reason, 'already-active')
  let runs = 0
  const recovered = createHandler({ settings, github: fakeGitHub(), state: createState(file), runReview: async () => { runs++; return passing() } })
  await recovered.idle()
  assert.equal(runs, 1)
})

test('failed result delivery stays pending and restart posts the saved result without rerunning', async () => {
  const file = join(tmp(), 'state.json')
  const gh = fakeGitHub({ comment: async () => { throw new Error('GitHub unavailable') } })
  let runs = 0
  const first = setup(gh, async () => { runs++; return passing() }, { state: createState(file) })
  await first.handle({ event: 'issue_comment', payload: payload() }); await first.idle()
  const attempts = gh.calls.filter(c => c[0] === 'comment')
  assert.equal(attempts.length, 1)
  assert.match(attempts[0][3], /Automation review passed/)
  assert.equal(createState(file).pending().length, 1)
  const recovered = fakeGitHub()
  const second = setup(recovered, async () => { runs++; return passing() }, { state: createState(file) })
  await second.idle()
  assert.equal(runs, 1)
  assert.equal(recovered.calls.find(c => c[0] === 'comment')[3], attempts[0][3])
  assert.deepEqual(createState(file).pending(), [])
})

test('failed error notice delivery stays pending', async () => {
  const file = join(tmp(), 'state.json')
  const gh = fakeGitHub({ comment: async () => { throw new Error('GitHub unavailable') } })
  const handler = setup(gh, async () => { throw new SetupError('Missing configuration') }, { state: createState(file) })
  await handler.handle({ event: 'issue_comment', payload: payload() }); await handler.idle()
  assert.equal(createState(file).pending().length, 1)
})

for (const permission of ['read', 'triage', 'none', 'error']) test(`member comment denied for live permission ${permission}`, async () => {
  const state = createState(join(tmp(), 'state.json'))
  const gh = fakeGitHub({ permissionOf: async (repo, actor) => {
    assert.equal(repo, REPO); assert.equal(actor, 'alice')
    if (permission === 'error') throw new Error('permission unavailable')
    return permission
  } })
  const handler = setup(gh, async () => assert.fail('must not run'), { state })
  assert.deepEqual(await handler.handle({ event: 'issue_comment', payload: payload() }), { status: 'rejected', reason: 'not-authorized' })
  await handler.idle()
  assert.equal(state.has(555), false)
  assert.deepEqual(gh.calls, [])
})

for (const permission of ['write', 'maintain', 'admin']) test(`live ${permission} permission accepts a stale commenter association`, async () => {
  let runs = 0
  const gh = fakeGitHub({ permissionOf: async () => permission })
  const handler = setup(gh, async () => { runs++; return passing() })
  const body = payload()
  body.comment.author_association = 'CONTRIBUTOR'
  assert.equal((await handler.handle({ event: 'issue_comment', payload: body })).status, 'accepted')
  await handler.idle()
  assert.equal(runs, 1)
})

for (const failure of [false, true]) test(`workflow run listing paginates and propagates later page failures: ${failure}`, async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const pages = []
  const github = createGitHub({ appId: '123', privateKey, fetchImpl: async url => {
    const json = data => ({ ok: true, text: async () => JSON.stringify(data) })
    if (url.endsWith('/installation')) return json({ id: 77 })
    if (url.includes('/access_tokens')) return json({ token: 'test', expires_at: new Date(Date.now() + 3600000).toISOString() })
    const page = Number(new URL(url).searchParams.get('page') ?? 1)
    pages.push(page)
    if (page === 2 && failure) throw new Error('lookup unavailable')
    return json({ workflow_runs: page === 1 ? Array.from({ length: 100 }, (_, id) => ({ id })) : [{ id: 999, display_title: 'automation-review older-review' }] })
  } })
  if (failure) await assert.rejects(github.listWorkflowRuns(REPO), /lookup unavailable/)
  else {
    const runs = await github.listWorkflowRuns(REPO)
    assert.equal(runs.length, 101)
    assert.equal(runs.at(-1).id, 999)
  }
  assert.deepEqual(pages, [1, 2])
})
