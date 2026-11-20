import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  authorizationUrl, checkIdTokenClaims, decodeIdToken, exchangeCode, googleConfig, sessionKey, signPayload, verifyPayload,
} from '../../dashboard/google-auth.mjs'

const config = googleConfig({ QA_GOOGLE_CLIENT_ID: 'client.apps', QA_GOOGLE_CLIENT_SECRET: 'csecret', QA_GOOGLE_ALLOWED_DOMAIN: 'company.example', QA_GOOGLE_ALLOWED_EMAILS: 'Contractor@Other.example' })
const NOW = Date.UTC(2026, 10, 20, 1, 0, 0)
const claims = (over = {}) => ({
  iss: 'https://accounts.google.com', aud: 'client.apps', exp: NOW / 1000 + 600, nonce: 'n1',
  email: 'dev@company.example', email_verified: true, hd: 'company.example', ...over,
})

test('sign-in stays off without all three settings', () => {
  assert.equal(googleConfig({}), null)
  assert.equal(googleConfig({ QA_GOOGLE_CLIENT_ID: 'a', QA_GOOGLE_CLIENT_SECRET: 'b' }), null)
  assert.throws(() => googleConfig({ QA_GOOGLE_CLIENT_ID: 'a', QA_GOOGLE_CLIENT_SECRET: 'b', QA_GOOGLE_ALLOWED_DOMAIN: 'not a domain' }), /bare domain/)
})

test('a company account with a verified email and the hosted-domain claim is admitted', () => {
  assert.deepEqual(checkIdTokenClaims(claims(), { config, nonce: 'n1', now: NOW }), { ok: true, email: 'dev@company.example' })
})

test('a listed outside email is admitted, case-insensitively', () => {
  const verdict = checkIdTokenClaims(claims({ email: 'contractor@other.example', hd: undefined }), { config, nonce: 'n1', now: NOW })
  assert.equal(verdict.ok, true)
})

test('other domains, consumer accounts and spoofed domains are refused', () => {
  assert.equal(checkIdTokenClaims(claims({ email: 'x@gmail.com', hd: undefined }), { config, nonce: 'n1', now: NOW }).reason, 'not_allowed')
  assert.equal(checkIdTokenClaims(claims({ email: 'x@company.example.evil.test', hd: undefined }), { config, nonce: 'n1', now: NOW }).reason, 'not_allowed')
  // A company-looking address without the hosted-domain claim is not enough.
  assert.equal(checkIdTokenClaims(claims({ hd: undefined }), { config, nonce: 'n1', now: NOW }).reason, 'not_allowed')
})

test('wrong issuer, audience, nonce, expiry or unverified email are each refused', () => {
  const check = over => checkIdTokenClaims(claims(over), { config, nonce: 'n1', now: NOW })
  assert.equal(check({ iss: 'https://evil.example' }).reason, 'wrong_issuer')
  assert.equal(check({ aud: 'someone-else' }).reason, 'wrong_audience')
  assert.equal(check({ nonce: 'stale' }).reason, 'nonce_mismatch')
  assert.equal(check({ exp: NOW / 1000 - 1 }).reason, 'token_expired')
  assert.equal(check({ email_verified: false }).reason, 'email_not_verified')
})

test('the authorization URL carries state, nonce and the hosted-domain hint', () => {
  const url = new URL(authorizationUrl(config, { redirectUri: 'https://dash.example/auth/google/callback', state: 's1', nonce: 'n1' }))
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth')
  assert.equal(url.searchParams.get('state'), 's1')
  assert.equal(url.searchParams.get('nonce'), 'n1')
  assert.equal(url.searchParams.get('hd'), 'company.example')
  assert.equal(url.searchParams.get('response_type'), 'code')
})

test('signed cookies verify only with the right key, and expire', () => {
  const key = sessionKey('a'.repeat(32))
  const token = signPayload({ role: 'viewer', email: 'dev@company.example', exp: NOW / 1000 + 60 }, key)
  assert.equal(verifyPayload(token, key, NOW).email, 'dev@company.example')
  assert.equal(verifyPayload(token, sessionKey('b'.repeat(32)), NOW), null)
  assert.equal(verifyPayload(token, key, NOW + 120_000), null)
  assert.equal(verifyPayload(token + 'x', key, NOW), null)
  assert.equal(verifyPayload(undefined, key, NOW), null)
})

test('the code exchange returns the ID token only on success and sends the secret to Google alone', async () => {
  let sent
  const ok = await exchangeCode(config, { code: 'c', redirectUri: 'https://d/cb', fetchImpl: async (url, init) => { sent = { url, body: init.body }; return Response.json({ id_token: 'h.p.s' }) } })
  assert.equal(ok, 'h.p.s')
  assert.equal(sent.url, 'https://oauth2.googleapis.com/token')
  assert.match(sent.body, /client_secret=csecret/)
  assert.equal(await exchangeCode(config, { code: 'c', redirectUri: 'x', fetchImpl: async () => new Response('no', { status: 400 }) }), null)
})

test('decodeIdToken reads the payload of a JWT-shaped string and refuses anything else', () => {
  const payload = Buffer.from(JSON.stringify({ email: 'x' })).toString('base64url')
  assert.deepEqual(decodeIdToken(`h.${payload}.s`), { email: 'x' })
  assert.equal(decodeIdToken('nope'), null)
})

// --- End to end: the real dashboard server with Google settings ----------------------------------------

async function freePort() {
  const probe = createServer().listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  return port
}

test('dashboard routes: anonymous is asked to sign in, a viewer reads but cannot start runs, forged cookies are refused', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-google-dash-'))
  mkdirSync(join(dir, 'runs-x'), { recursive: true })
  const port = await freePort()
  const accessToken = 'k'.repeat(40)
  const host = 'dash.example.test'
  const child = spawn(process.execPath, ['dashboard/server.mjs'], {
    cwd: join(import.meta.dirname, '../..'),
    env: {
      ...process.env, QA_RUNS_DIR: dir, QA_HOSTED: '1', QA_DASHBOARD_HOST: '127.0.0.1', QA_DASHBOARD_PORT: String(port), QA_DASHBOARD_PUBLIC_HOST: host,
      QA_DASHBOARD_ACCESS_TOKEN: accessToken, QA_GOOGLE_CLIENT_ID: 'client.apps', QA_GOOGLE_CLIENT_SECRET: 'csecret', QA_GOOGLE_ALLOWED_DOMAIN: 'company.example',
      QA_WATCHDOG: '0', SLACK_BOT_TOKEN: '', SLACK_ALERT_WEBHOOK_URL: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(() => { child.kill(); rmSync(dir, { recursive: true, force: true }) })
  let boot = ''
  child.stdout.on('data', d => { boot += d })
  child.stderr.on('data', d => { boot += d })
  // The listening line and the Google line are written back to back and may arrive in separate chunks.
  for (let i = 0; i < 100 && !(boot.includes('listening') && boot.includes('Google sign-in: viewers at')); i++) await new Promise(r => setTimeout(r, 100))
  assert.ok(boot.includes('Google sign-in: viewers at'), boot)

  const base = `http://127.0.0.1:${port}`
  const get = (path, headers = {}) => fetch(base + path, { headers: { host, ...headers }, redirect: 'manual' })

  const anon = await get('/api/status')
  assert.equal(anon.status, 403)
  assert.equal((await anon.json()).signIn, true)

  const start = await get('/auth/google/start')
  assert.equal(start.status, 302)
  const location = new URL(start.headers.get('location'))
  assert.equal(location.hostname, 'accounts.google.com')
  const oauthCookie = start.headers.get('set-cookie').split(';')[0]
  assert.match(oauthCookie, /^mpc_qa_oauth_\d+=/)

  // A forged viewer cookie is not a session.
  const forged = await get('/api/status', { cookie: `mpc_qa_viewer_${port}=${signPayload({ role: 'viewer', email: 'x@company.example', exp: NOW / 1000 + 600 }, sessionKey('z'.repeat(40)))}` })
  assert.equal(forged.status, 403)

  // A genuine viewer session (signed with the same key the server derives) reads, but cannot write.
  const viewer = `mpc_qa_viewer_${port}=${signPayload({ role: 'viewer', email: 'dev@company.example', exp: Math.floor(Date.now() / 1000) + 600 }, sessionKey(accessToken))}`
  const status = await get('/api/status', { cookie: viewer })
  assert.equal(status.status, 200)
  const body = await status.json()
  assert.equal(body.role, 'viewer')
  assert.equal(body.viewerEmail, 'dev@company.example')
  const page = await get('/')
  const token = (await page.text()).match(/name="qa-token" content="([^"]+)"/)[1]
  const write = await fetch(base + '/api/runs', { method: 'POST', headers: { host, cookie: viewer, 'content-type': 'application/json', 'x-qa-token': token }, body: JSON.stringify({ suite: 'smoke', env: 'production' }) })
  assert.equal(write.status, 403)
  assert.match((await write.json()).error, /admin key/)
})
