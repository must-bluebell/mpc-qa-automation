import { test, type APIRequestContext, type APIResponse, type TestInfo } from '@playwright/test'
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import { createSiweMessage } from 'viem/siwe'
import { target } from '../config/target'

/**
 * Host-side HTTP contract helpers for tests/api.
 *
 * The request may go through the chaos proxy (seeded defects), so the URL we call and the origin the
 * app trusts are separate: `QA_APP_ORIGIN` is what the app's guardSameOrigin and SIWE domain expect.
 */
export function appOrigin(): string {
  return (process.env.QA_APP_ORIGIN || target().baseUrl).replace(/\/+$/, '')
}

/** Writes (sign-in, run saves) only run against an environment the pipeline marked isolated. */
export function writesAllowed(): boolean {
  return process.env.QA_ALLOW_WRITES === '1'
}

export function requireWrites() {
  test.skip(!writesAllowed(), 'Write checks run only on an isolated environment (QA_ALLOW_WRITES=1).')
}

type CallOptions = { body?: unknown; raw?: string; origin?: string | null; headers?: Record<string, string> }

const confidential = new Set(['nonce', 'message', 'signature', 'password', 'token', 'accesstoken', 'refreshtoken', 'authorization', 'cookie', 'setcookie', 'email', 'address', 'wallet', 'privatekey', 'seedphrase'])
function evidenceBody(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(evidenceBody)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    confidential.has(key.replace(/[-_]/g, '').toLowerCase()) ? '[REDACTED]' : evidenceBody(item)]))
  return value
}

/**
 * Attach a redacted response as evidence; assertions still receive the original response.
 */
export async function call(request: APIRequestContext, info: TestInfo, method: 'GET' | 'POST' | 'PATCH', path: string, options: CallOptions = {}) {
  const headers: Record<string, string> = { ...options.headers }
  // Browsers send Origin on writes; GETs only carry it when a test asks (admin GETs are origin-guarded).
  if (options.origin !== null && (method !== 'GET' || options.origin !== undefined)) headers.origin = options.origin ?? appOrigin()
  const started = Date.now()
  // A Buffer is sent byte-for-byte; Playwright would re-encode an invalid JSON string.
  const data = options.raw !== undefined ? Buffer.from(options.raw) : options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body))
  if (data !== undefined) headers['content-type'] = 'application/json'
  const response: APIResponse = await request.fetch(path, { method, headers, data, failOnStatusCode: false, maxRedirects: 0 })
  const text = await response.text()
  let json: unknown = null
  try { json = text ? JSON.parse(text) : null } catch { json = null }
  await info.attach(`api ${method} ${path} → ${response.status()}`, {
    contentType: 'application/json',
    body: JSON.stringify({ method, path, status: response.status(), durationMs: Date.now() - started, body: evidenceBody(json ?? text.slice(0, 2_000)) }, null, 2),
  })
  return { status: response.status(), json: json as Record<string, unknown> | null, text, headers: response.headers() }
}

export type SignedIn = { account: PrivateKeyAccount; address: string; message: string; signature: `0x${string}` }

/** Fresh throwaway wallet → nonce → SIWE message → verify. No funds are needed to sign in. */
export async function prepareSignIn(request: APIRequestContext, info: TestInfo): Promise<SignedIn> {
  const account = privateKeyToAccount(generatePrivateKey())
  const nonce = await call(request, info, 'POST', '/api/auth/nonce', { body: {} })
  if (nonce.status !== 200 || typeof nonce.json?.nonce !== 'string') throw new Error(`nonce failed: ${nonce.status} ${nonce.text.slice(0, 200)}`)
  const origin = new URL(appOrigin())
  const message = createSiweMessage({
    address: account.address, chainId: target().chainId, domain: origin.host, scheme: origin.protocol.replace(':', ''),
    uri: origin.origin, version: '1', nonce: nonce.json.nonce, issuedAt: new Date(), expirationTime: new Date(Date.now() + 300_000),
  })
  const signature = await account.signMessage({ message })
  return { account, address: account.address.toLowerCase(), message, signature }
}

export async function signIn(request: APIRequestContext, info: TestInfo): Promise<SignedIn> {
  const prepared = await prepareSignIn(request, info)
  const { message, signature } = prepared
  const verified = await call(request, info, 'POST', '/api/auth/verify', { body: { message, signature } })
  if (verified.status !== 200) throw new Error(`verify failed: ${verified.status} ${verified.text.slice(0, 200)}`)
  return prepared
}

/** My Mine routes answer 404 where the mine is not deployed; that is "not covered", not a defect. */
export function skipIfMineClosed(status: number) {
  test.skip(status === 404, 'My Mine is not open on this deployment (404).')
}
