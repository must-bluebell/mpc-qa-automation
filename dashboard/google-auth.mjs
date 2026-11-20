import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Google sign-in for the dashboard's viewers. Signed-in people can read runs; only the admin key (the
 * existing private access token) can start runs or send tests. Sign-in is an OpenID Connect
 * authorization-code flow against Google's token endpoint, so the ID token arrives over TLS directly
 * from Google and its claims are checked here (issuer, audience, nonce, expiry, verified email, domain).
 */
export const VIEWER_SESSION_SECONDS = 8 * 60 * 60
export const OAUTH_STATE_SECONDS = 10 * 60
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com']

/**
 * Reads the settings. Sign-in is on only when the client ID, client secret and company domain are all set;
 * the optional email list further restricts accounts within that domain.
 */
export function googleConfig(env = process.env) {
  const clientId = (env.QA_GOOGLE_CLIENT_ID || '').trim()
  const clientSecret = (env.QA_GOOGLE_CLIENT_SECRET || '').trim()
  const domain = (env.QA_GOOGLE_ALLOWED_DOMAIN || '').trim().toLowerCase()
  if (!clientId || !clientSecret || !domain) return null
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) throw new Error('QA_GOOGLE_ALLOWED_DOMAIN must be a bare domain such as example.com')
  const emails = new Set((env.QA_GOOGLE_ALLOWED_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean))
  return { clientId, clientSecret, domain, emails }
}

/** Signing key for every cookie this module issues, derived from the admin key so no extra secret is needed. */
export function sessionKey(accessToken) {
  return createHmac('sha256', accessToken).update('mpc-qa-dashboard-session-v1').digest()
}

const b64url = buf => Buffer.from(buf).toString('base64url')

export function signPayload(payload, key) {
  const body = b64url(JSON.stringify(payload))
  const mac = b64url(createHmac('sha256', key).update(body).digest())
  return `${body}.${mac}`
}

/** Returns the payload when the signature is valid and not expired; otherwise null. */
export function verifyPayload(token, key, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 2048) return null
  const [body, mac, extra] = token.split('.')
  if (!body || !mac || extra !== undefined) return null
  const want = createHmac('sha256', key).update(body).digest()
  const given = Buffer.from(mac, 'base64url')
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null
  let payload
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) } catch { return null }
  if (!payload || typeof payload.exp !== 'number' || payload.exp * 1000 <= now) return null
  return payload
}

export function newOauthState(now = Date.now()) {
  return { state: randomBytes(24).toString('base64url'), nonce: randomBytes(24).toString('base64url'), exp: Math.floor(now / 1000) + OAUTH_STATE_SECONDS }
}

export function authorizationUrl(config, { redirectUri, state, nonce }) {
  const url = new URL(AUTH_ENDPOINT)
  url.search = new URLSearchParams({
    client_id: config.clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'openid email',
    state, nonce, hd: config.domain, prompt: 'select_account',
  }).toString()
  return url.href
}

/**
 * Pure claim check. Returns { ok: true, email } or { ok: false, reason } where reason is a fixed code
 * (never the raw claim) so the page can say why sign-in was refused without leaking anything.
 */
export function checkIdTokenClaims(claims, { config, nonce, now = Date.now() }) {
  if (!claims || typeof claims !== 'object') return { ok: false, reason: 'invalid_token' }
  if (!ISSUERS.includes(claims.iss)) return { ok: false, reason: 'wrong_issuer' }
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (!audiences.includes(config.clientId)) return { ok: false, reason: 'wrong_audience' }
  if (audiences.length > 1 && claims.azp !== config.clientId) return { ok: false, reason: 'wrong_audience' }
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now) return { ok: false, reason: 'token_expired' }
  if (claims.nonce !== nonce) return { ok: false, reason: 'nonce_mismatch' }
  if (typeof claims.email !== 'string' || claims.email_verified !== true) return { ok: false, reason: 'email_not_verified' }
  const email = claims.email.trim().toLowerCase()
  const emailDomain = email.split('@')[1] ?? ''
  const onDomain = emailDomain === config.domain && claims.hd === config.domain
  if (!onDomain || (config.emails.size > 0 && !config.emails.has(email))) return { ok: false, reason: 'not_allowed' }
  return { ok: true, email }
}

/** Decodes the ID token's payload. Its signature is not re-checked: it came straight from the token endpoint over TLS. */
export function decodeIdToken(idToken) {
  const parts = typeof idToken === 'string' ? idToken.split('.') : []
  if (parts.length !== 3) return null
  try { return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) } catch { return null }
}

/** Exchanges the one-time code for tokens. Returns the ID token, or null on any refusal. */
export async function exchangeCode(config, { code, redirectUri, fetchImpl = fetch }) {
  const res = await fetchImpl(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }).toString(),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) return null
  const data = await res.json().catch(() => null)
  return typeof data?.id_token === 'string' ? data.id_token : null
}
