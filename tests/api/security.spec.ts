import { expect, test } from '@playwright/test'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { createSiweMessage } from 'viem/siwe'
import { appOrigin, call, requireWrites, signIn } from '../../fixtures/api'
import { target } from '../../config/target'

test.describe('Authentication security boundaries', { tag: ['@api', '@security', '@regression', '@critical', '@feature-auth'] }, () => {
  test.beforeEach(() => requireWrites())

  for (const [index, variant] of (['foreign domain', 'wrong chain', 'expired message', 'different signer'] as const).entries()) {
    test(`A${String(8 + index).padStart(2, '0')} - Reject SIWE with ${variant}`, { tag: ['@AUTH-03'] }, async ({ request }, info) => {
      const account = privateKeyToAccount(generatePrivateKey())
      const nonce = await call(request, info, 'POST', '/api/auth/nonce', { body: {} })
      expect(nonce.status).toBe(200)
      expect(typeof nonce.json?.nonce).toBe('string')
      const origin = new URL(appOrigin())
      const message = createSiweMessage({
        address: account.address, domain: variant === 'foreign domain' ? 'attacker.example' : origin.host,
        scheme: origin.protocol.slice(0, -1), uri: origin.origin, version: '1',
        chainId: variant === 'wrong chain' ? target().chainId + 1 : target().chainId,
        nonce: nonce.json!.nonce as string,
        issuedAt: new Date(Date.now() - 120_000),
        expirationTime: new Date(Date.now() + (variant === 'expired message' ? -60_000 : 300_000)),
      })
      const signer = variant === 'different signer' ? privateKeyToAccount(generatePrivateKey()) : account
      const signature = await signer.signMessage({ message })
      const result = await call(request, info, 'POST', '/api/auth/verify', { body: { message, signature } })
      expect(result.status).toBe(401)
      const session = await call(request, info, 'GET', '/api/auth/session')
      expect(session.status).toBe(200)
      expect(session.json?.address ?? null).toBeNull()
    })
  }

  test('A12 - Cross-origin logout preserves the signed-in session', { tag: ['@AUTH-04'] }, async ({ request }, info) => {
    const user = await signIn(request, info)
    const result = await call(request, info, 'POST', '/api/auth/logout', { body: {}, origin: 'https://attacker.example' })
    expect(result.status).toBe(403)
    const session = await call(request, info, 'GET', '/api/auth/session')
    expect(session.json?.address).toBe(user.address)
  })

  test('A13 - Logout removes access to private notifications', { tag: ['@AUTH-05', '@PERM-01'] }, async ({ request }, info) => {
    await signIn(request, info)
    expect((await call(request, info, 'POST', '/api/auth/logout', { body: {} })).status).toBe(200)
    expect((await call(request, info, 'GET', '/api/notifications')).status).toBe(401)
    expect((await call(request, info, 'POST', '/api/auth/logout', { body: {} })).status).toBe(200)
  })
})
