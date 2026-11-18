import { test, expect } from '@playwright/test'
import { signIn } from '../../fixtures/api'
import { contractCall, assertContract, requireIsolatedApi } from '../../fixtures/api-contracts'
import { target } from '../../config/target'

test.describe('Authenticated API workflows', { tag: ['@api', '@regression', '@collection-workflow'] }, () => {
  test.beforeEach(() => requireIsolatedApi())

  test('FLOW01 — two wallet sessions remain independent after logout', async ({ request, playwright }, info) => {
    const first = await signIn(request, info)
    const other = await playwright.request.newContext({ baseURL: target().baseUrl })
    try {
      const second = await signIn(other, info)
      expect(first.address).not.toBe(second.address)
      assertContract(await contractCall(request, info, 'GET', '/api/auth/session'), { status: 200, fields: { address: first.address } })
      assertContract(await contractCall(request, info, 'POST', '/api/auth/logout', { body: {} }), { status: 200, fields: { ok: true } })
      assertContract(await contractCall(request, info, 'GET', '/api/notifications'), { status: 401, error: 'not_signed_in' })
      assertContract(await contractCall(other, info, 'GET', '/api/auth/session'), { status: 200, fields: { address: second.address } })
      assertContract(await contractCall(other, info, 'GET', '/api/activities'), { status: 200, fields: { activities: [] } })
    } finally { await other.dispose() }
  })

  test('FLOW02 — run save is repeatable and rejected updates preserve stored state', async ({ request }, info) => {
    await signIn(request, info)
    const initial = await contractCall(request, info, 'GET', '/my-mine/run')
    assertContract(initial, { status: 200, fields: { script: [], records: [] } })
    for (let i = 0; i < 2; i++) assertContract(await contractCall(request, info, 'POST', '/my-mine/run', { body: { script: [] } }), { status: 200, fields: { records: [] } })
    assertContract(await contractCall(request, info, 'POST', '/my-mine/run', { body: { script: 'invalid' } }), { status: 400, error: 'bad_run_body' })
    assertContract(await contractCall(request, info, 'GET', '/my-mine/run'), { status: 200, fields: { script: [], records: [] } })
  })

  test('FLOW03 — nonce rotation invalidates an earlier signed message', async ({ request }, info) => {
    const user = await signIn(request, info)
    assertContract(await contractCall(request, info, 'POST', '/api/auth/nonce', { body: {} }), { status: 200, types: { nonce: 'string' } })
    const replay = await contractCall(request, info, 'POST', '/api/auth/verify', { body: { message: user.message, signature: user.signature } })
    assertContract(replay, { status: 401, error: 'message_invalid' })
    // A failed attempt must not authenticate a different wallet.
    const session = await contractCall(request, info, 'GET', '/api/auth/session')
    expect(session.status).toBe(200)
    expect((session.json as { address: string | null }).address).toBe(user.address)
  })

  test('FLOW04 — registration belongs to one wallet and rejects duplicate registration', async ({ request, playwright }, info) => {
    const user = await signIn(request, info)
    const status = await contractCall(request, info, 'GET', '/api/register/status')
    assertContract(status, { status: 200, fields: { registered: false }, types: { skipEmailOtp: 'boolean' } })
    test.skip(!(status.json as { skipEmailOtp: boolean }).skipEmailOtp, 'Isolated join policy requires email OTP; provide an OTP fixture for that workflow.')
    const body = { email: `qa-${user.address.slice(2)}@example.com` }
    assertContract(await contractCall(request, info, 'POST', '/api/register/skip-otp', { body }), { status: 200, fields: { ok: true } })
    assertContract(await contractCall(request, info, 'GET', '/api/register/status'), { status: 200, fields: { registered: true } })
    assertContract(await contractCall(request, info, 'POST', '/api/register/skip-otp', { body }), { status: 409, error: 'already_registered' })
    const other = await playwright.request.newContext({ baseURL: target().baseUrl })
    try {
      await signIn(other, info)
      assertContract(await contractCall(other, info, 'GET', '/api/register/status'), { status: 200, fields: { registered: false } })
      assertContract(await contractCall(other, info, 'POST', '/api/register/skip-otp', { body }), { status: 409, error: 'email_taken' })
    } finally { await other.dispose() }
  })

  test('FLOW05 — wallet cookies cannot be promoted to administrator cookies', async ({ request, playwright }, info) => {
    await signIn(request, info)
    const state = await request.storageState()
    const renamed = state.cookies.filter(c => c.name.endsWith('mpc_session')).map(c => ({ ...c, name: c.name.replace('mpc_session', 'mpc_admin') }))
    expect(renamed.length).toBeGreaterThan(0)
    const attacker = await playwright.request.newContext({ baseURL: target().baseUrl, storageState: { cookies: renamed, origins: [] } })
    try {
      assertContract(await contractCall(attacker, info, 'GET', '/api/admin/admins'), { status: 401, error: 'not_admin' })
    } finally { await attacker.dispose() }
  })
})
