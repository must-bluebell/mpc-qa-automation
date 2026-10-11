import { expect, test } from '@playwright/test'
import { call, requireWrites, signIn } from '../../fixtures/api'
import { target } from '../../config/target'

test.describe('Account access acceptance journeys', { tag: ['@uat', '@critical', '@feature-auth'] }, () => {
  test.beforeEach(() => requireWrites())

  test('U01 - A returning user restores their session and can sign out', async ({ request, playwright }, info) => {
    const user = await signIn(request, info)
    const returning = await playwright.request.newContext({ baseURL: target().baseUrl, storageState: await request.storageState() })
    try {
      const session = await call(returning, info, 'GET', '/api/auth/session')
      expect(session.json?.address).toBe(user.address)
      expect((await call(returning, info, 'GET', '/api/notifications')).status).toBe(200)
      expect((await call(returning, info, 'POST', '/api/auth/logout', { body: {} })).status).toBe(200)
      expect((await call(returning, info, 'GET', '/api/notifications')).status).toBe(401)
    } finally { await returning.dispose() }
  })

  test('U02 - Two users keep separate identities when one signs out', async ({ request, playwright }, info) => {
    const alice = await signIn(request, info)
    const other = await playwright.request.newContext({ baseURL: target().baseUrl })
    try {
      const bob = await signIn(other, info)
      expect(bob.address).not.toBe(alice.address)
      expect((await call(request, info, 'GET', '/api/auth/session')).json?.address).toBe(alice.address)
      expect((await call(other, info, 'GET', '/api/auth/session')).json?.address).toBe(bob.address)
      expect((await call(request, info, 'POST', '/api/auth/logout', { body: {} })).status).toBe(200)
      expect((await call(request, info, 'GET', '/api/auth/session')).json?.address).toBeNull()
      expect((await call(other, info, 'GET', '/api/auth/session')).json?.address).toBe(bob.address)
    } finally { await other.dispose() }
  })

  test('U03 - A user can sign in again after signing out', async ({ request }, info) => {
    await signIn(request, info)
    expect((await call(request, info, 'POST', '/api/auth/logout', { body: {} })).status).toBe(200)
    const next = await signIn(request, info)
    expect((await call(request, info, 'GET', '/api/auth/session')).json?.address).toBe(next.address)
  })
})
