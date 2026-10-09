import { expect, test } from '@playwright/test'
import { appOrigin, call, requireWrites, signIn, skipIfMineClosed } from '../../fixtures/api'

test.describe('Permissions API', { tag: ['@api', '@feature-permissions', '@critical', '@regression'] }, () => {
  test('P01 - Notifications require a session', { tag: ['@smoke', '@PERM-01'] }, async ({ request }, info) => {
    const res = await call(request, info, 'GET', '/api/notifications')
    expect(res.status).toBe(401)
    expect(res.json?.error).toBe('not_signed_in')
  })

  test('P02 - My Mine run requires a session', { tag: ['@smoke', '@PERM-01', '@feature-mine'] }, async ({ request }, info) => {
    const res = await call(request, info, 'GET', '/my-mine/run')
    skipIfMineClosed(res.status)
    expect(res.status).toBe(401)
    expect(res.json?.error).toBe('not_signed_in')
  })

  test('P03 - A new wallet sees only its own empty notifications', { tag: ['@PERM-01'] }, async ({ request }, info) => {
    requireWrites()
    await signIn(request, info)
    const res = await call(request, info, 'GET', '/api/notifications')
    expect(res.status).toBe(200)
    const items = Array.isArray(res.json) ? res.json : (res.json?.items ?? res.json?.notifications ?? [])
    expect(Array.isArray(items)).toBe(true)
    expect((items as unknown[]).length).toBe(0)
  })

  test('P04 - Cron endpoints refuse requests without the bearer secret', { tag: ['@smoke', '@PERM-02'] }, async ({ request }, info) => {
    for (const path of ['/api/cron/relay-sweep', '/api/cron/funnel-failures']) {
      const anonymous = await call(request, info, 'GET', path)
      expect([401, 403], path).toContain(anonymous.status)
      const wrong = await call(request, info, 'GET', path, { headers: { authorization: 'Bearer not-the-secret' } })
      expect([401, 403], path).toContain(wrong.status)
    }
  })

  test('P05 - Admin APIs refuse requests without an admin session', { tag: ['@smoke', '@PERM-03'] }, async ({ request }, info) => {
    for (const path of ['/api/admin/admins', '/api/admin/quests', '/api/admin/ledger/export']) {
      // Same-origin, so the request reaches the admin check instead of stopping at the origin guard.
      const res = await call(request, info, 'GET', path, { origin: appOrigin() })
      expect(res.status, path).toBe(401)
      expect(res.json?.error, path).toBe('not_admin')
    }
  })

  test('P06 - A wallet session is not an admin session', { tag: ['@PERM-03'] }, async ({ request }, info) => {
    requireWrites()
    await signIn(request, info)
    const res = await call(request, info, 'GET', '/api/admin/admins', { origin: appOrigin() })
    expect(res.status).toBe(401)
    expect(res.json?.error).toBe('not_admin')
  })
})
