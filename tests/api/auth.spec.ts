import { expect, test } from '@playwright/test'
import { call, requireWrites, signIn } from '../../fixtures/api'

test.describe('Authentication API', { tag: ['@api', '@feature-auth', '@critical', '@regression'] }, () => {
  test('A01 - Anonymous session reports no address', { tag: ['@smoke'] }, async ({ request }, info) => {
    const session = await call(request, info, 'GET', '/api/auth/session')
    expect(session.status).toBe(200)
    expect(session.json?.address ?? null).toBeNull()
    expect(session.headers['cache-control'] ?? '').toContain('no-store')
  })

  test('A02 - Foreign-origin write is refused', { tag: ['@smoke', '@AUTH-04'] }, async ({ request }, info) => {
    const refused = await call(request, info, 'POST', '/api/auth/nonce', { body: {}, origin: 'https://attacker.example' })
    expect(refused.status).toBe(403)
    const session = await call(request, info, 'GET', '/api/auth/session')
    expect(session.json?.address ?? null).toBeNull()
  })

  test('A03 - SIWE sign-in creates a session for the signing wallet', { tag: ['@smoke', '@AUTH-01'] }, async ({ request }, info) => {
    requireWrites()
    const user = await signIn(request, info)
    const session = await call(request, info, 'GET', '/api/auth/session')
    expect(session.status).toBe(200)
    expect(String(session.json?.address).toLowerCase()).toBe(user.address)
  })

  test('A04 - A signed SIWE message cannot be replayed', { tag: ['@AUTH-02'] }, async ({ request }, info) => {
    requireWrites()
    const user = await signIn(request, info)
    const replay = await call(request, info, 'POST', '/api/auth/verify', { body: { message: user.message, signature: user.signature } })
    expect(replay.status).toBe(401)
    expect(['nonce_replayed', 'nonce_missing', 'nonce_expired']).toContain(replay.json?.error)
  })

  test('A05 - Malformed sign-in requests are rejected without a session', { tag: ['@AUTH-03'] }, async ({ request }, info) => {
    requireWrites()
    // The app burns the nonce on every verify attempt, failed ones included, so each case gets its own.
    const cases = [
      { raw: '{not json', error: 'bad_json' },
      { raw: '{}', error: 'missing_fields' },
      { raw: JSON.stringify({ message: 'hello', signature: '0x1234' }), error: 'bad_signature_format' },
    ]
    for (const c of cases) {
      await call(request, info, 'POST', '/api/auth/nonce', { body: {} })
      const res = await call(request, info, 'POST', '/api/auth/verify', { raw: c.raw })
      expect(res.status, c.raw).toBe(400)
      expect(res.json?.error, c.raw).toBe(c.error)
    }
    const session = await call(request, info, 'GET', '/api/auth/session')
    expect(session.json?.address ?? null).toBeNull()
  })

  test('A06 - Oversized sign-in body is rejected', { tag: ['@VAL-03'] }, async ({ request }, info) => {
    requireWrites()
    await call(request, info, 'POST', '/api/auth/nonce', { body: {} })
    const res = await call(request, info, 'POST', '/api/auth/verify', { raw: JSON.stringify({ message: 'x'.repeat(16_000), signature: `0x${'a'.repeat(130)}` }) })
    expect(res.status).toBe(413)
    expect(res.json?.error).toBe('body_too_large')
    // A rejected attempt burns the nonce: a valid-looking retry cannot reuse it.
    const retry = await call(request, info, 'POST', '/api/auth/verify', { body: { message: 'x', signature: `0x${'a'.repeat(130)}` } })
    expect(retry.status).toBe(401)
  })

  test('A07 - Logout destroys the session', { tag: ['@AUTH-05'] }, async ({ request }, info) => {
    requireWrites()
    await signIn(request, info)
    const out = await call(request, info, 'POST', '/api/auth/logout', { body: {} })
    expect(out.status).toBe(200)
    const session = await call(request, info, 'GET', '/api/auth/session')
    expect(session.json?.address ?? null).toBeNull()
  })
})
