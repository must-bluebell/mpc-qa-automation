import test from 'node:test'
import assert from 'node:assert/strict'
import { sign, verifySignature } from '../../pipeline/github-app/signature.mjs'
import { isAuthorized, parseCommand, parseSettings, validatePreviewUrl } from '../../pipeline/github-app/policy.mjs'

const secret = 'a-long-enough-webhook-secret'

test('signature accepts the exact body and rejects tampering, bad formats and weak secrets', () => {
  const body = Buffer.from('{"a":1}')
  assert.equal(verifySignature(secret, body, sign(secret, body)), true)
  assert.equal(verifySignature(secret, Buffer.from('{"a":2}'), sign(secret, body)), false)
  assert.equal(verifySignature('another-long-enough-secret', body, sign(secret, body)), false)
  for (const header of [undefined, '', 'sha256=', 'sha1=' + 'a'.repeat(40), 'sha256=' + 'z'.repeat(64), sign(secret, body).slice(0, -2)]) assert.equal(verifySignature(secret, body, header), false)
  assert.equal(verifySignature('short', body, sign('short', body)), false)
  assert.equal(verifySignature('', body, sign('', body)), false)
})

test('command must be the first line and exactly "/automation review"', () => {
  for (const ok of ['/automation review', '  /automation   review  ', '/AUTOMATION Review', '/automation review\nplease', '/automation review\r\nthanks', '\r\n/automation review\r\n', '\n\n  /automation review']) assert.equal(parseCommand(ok), true, JSON.stringify(ok))
  for (const bad of ['/automation', '/automation review now', 'please /automation review', '> /automation review', 'hi\n/automation review', '/automation reviews', '/automations review', '', null, undefined, 42]) assert.equal(parseCommand(bad), false, String(bad))
})

test('only owners, members and collaborators are authorized', () => {
  for (const a of ['OWNER', 'MEMBER', 'COLLABORATOR']) assert.equal(isAuthorized(a), true)
  for (const a of ['CONTRIBUTOR', 'FIRST_TIMER', 'FIRST_TIME_CONTRIBUTOR', 'NONE', 'MANNEQUIN', '', undefined, 'member']) assert.equal(isAuthorized(a), false, String(a))
})

test('policy validation rejects unsafe values and lets an env override switch the tests ref', () => {
  const base = { testsRepository: 'globalmpc/mpc-automation', testsRef: 'review', repositories: { 'globalmpc/Web': { previewHostPrefix: 'webapp' } } }
  const parsed = parseSettings(base, {})
  assert.equal(parsed.testsRef, 'review')
  assert.equal(parseSettings(base, { QA_GITHUB_TESTS_REF: 'main' }).testsRef, 'main')
  assert.equal(parsed.repositories.get('globalmpc/web').name, 'globalmpc/Web')
  assert.throws(() => parseSettings({ ...base, testsRef: '--upload-pack=x' }), /testsRef/)
  assert.throws(() => parseSettings({ ...base, testsRepository: 'nope' }), /testsRepository/)
  assert.throws(() => parseSettings({ ...base, playwrightArgs: ['--reporter=html'] }), /playwrightArgs/)
  assert.throws(() => parseSettings({ ...base, playwrightArgs: ['; rm -rf /'] }), /playwrightArgs/)
  assert.throws(() => parseSettings({ ...base, repositories: { 'a/b': { chainId: 56 } } }), /chain 97/)
  assert.throws(() => parseSettings({ ...base, repositories: { bad: {} } }), /owner\/repository/)
  assert.equal(parseSettings({ ...base, repositories: { 'o/demo': { target: { type: 'local-stack' } } } }).repositories.get('o/demo').localStack, 'local-docker')
  assert.throws(() => parseSettings({ ...base, repositories: { 'o/demo': { target: { type: 'local-stack', environment: '../x' } } } }), /environment/)
  const fixed = parseSettings({ ...base, repositories: { 'o/demo': { target: { baseUrl: 'https://demo-git-x-team.vercel.app/' } } } })
  assert.equal(fixed.repositories.get('o/demo').fixedBaseUrl, 'https://demo-git-x-team.vercel.app')
  for (const baseUrl of ['https://app.globalmpc.tech/', 'http://a.vercel.app/', 'https://a.vercel.app/path', undefined]) assert.throws(() => parseSettings({ ...base, repositories: { 'o/demo': { target: { baseUrl } } } }), /target must be/)
})

test('preview URLs must be a bare https vercel.app origin', () => {
  assert.equal(validatePreviewUrl('https://webapp-git-fix-team.vercel.app/'), 'https://webapp-git-fix-team.vercel.app')
  assert.equal(validatePreviewUrl('https://webapp-git-fix-team.vercel.app/', { prefix: 'webapp' }), 'https://webapp-git-fix-team.vercel.app')
  assert.equal(validatePreviewUrl('https://evil-webapp.vercel.app/', { prefix: 'webapp' }), null)
  assert.equal(validatePreviewUrl('https://webappx.vercel.app/', { prefix: 'webapp' }), null)
  for (const bad of ['http://a.vercel.app/', 'https://a.vercel.app.evil.com/', 'https://u:p@a.vercel.app/', 'https://a.vercel.app:8443/', 'https://a.vercel.app/x', 'https://a.vercel.app/?q=1', 'https://a.vercel.app/#h', 'https://evil.com/', 'nonsense', undefined]) assert.equal(validatePreviewUrl(bad), null, String(bad))
})

test('testsDirectory is one directory name in the tests checkout, per repository or global', () => {
  const base = { testsRepository: 'MSQ-AI-Testing/mpc-automation', testsRef: 'review', repositories: { 'MSQ-AI-Testing/demo-repository': { target: { type: 'local-stack' } } } }
  assert.equal(parseSettings(base, {}).repositories.get('msq-ai-testing/demo-repository').testsDirectory, '.')
  assert.equal(parseSettings({ ...base, testsDirectory: 'chrom extension' }, {}).repositories.get('msq-ai-testing/demo-repository').testsDirectory, 'chrom extension')
  const perRepo = { ...base, repositories: { 'MSQ-AI-Testing/demo-repository': { target: { type: 'local-stack' }, testsDirectory: 'chrom extension' } } }
  assert.equal(parseSettings(perRepo, {}).repositories.get('msq-ai-testing/demo-repository').testsDirectory, 'chrom extension')
  for (const bad of ['..', '../x', '/etc', 'a/b', 'a/../b', '.hidden/x', '', ' x', 'x;rm']) {
    assert.throws(() => parseSettings({ ...base, testsDirectory: bad }, {}), /testsDirectory/, bad)
    assert.throws(() => parseSettings({ ...base, repositories: { 'MSQ-AI-Testing/demo-repository': { testsDirectory: bad } } }, {}), /testsDirectory/, bad)
  }
})

test('repository Playwright overrides obey the global argument validation', () => {
  const parse = playwrightArgs => parseSettings({ testsRepository: 'globalmpc/mpc-automation', testsRef: 'main', repositories: { 'globalmpc/web': { playwrightArgs } } })
  for (const bad of [42, 'chromium', {}, [42], ['--reporter=html'], ['--output=/tmp'], ['; echo bad']]) {
    assert.throws(() => parse(bad), /globalmpc\/web: playwrightArgs/)
  }
  assert.deepEqual(parse(['--project=chromium']).repositories.get('globalmpc/web').playwrightArgs, ['--project=chromium'])
})
