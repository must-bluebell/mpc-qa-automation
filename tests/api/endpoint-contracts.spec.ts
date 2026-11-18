import { test } from '@playwright/test'
import { contracts, configuredCases, contractCall, assertContract, requireIsolatedApi } from '../../fixtures/api-contracts'

test.describe('Unity collection contracts', { tag: ['@api', '@regression', '@collection'] }, () => {
  test.beforeEach(() => requireIsolatedApi())
  for (const c of contracts) {
    const expected = configuredCases[c.id]?.baseline ?? c.baseline
    test(`${c.id} ${c.method} ${c.route} — baseline contract`, async ({ request }, info) => {
      info.annotations.push({ type: 'source', description: c.source })
      test.skip(!expected, c.blocked)
      const result = await contractCall(request, info, c.method, c.path, {
        body: c.body ?? (['GET', 'OPTIONS'].includes(c.method) ? undefined : {}), headers: c.headers,
      })
      assertContract(result, expected!)
    })
    if (expected?.status === 401) {
      test(`${c.id} ${c.method} ${c.route} — forged credentials cannot bypass authorization`, async ({ request }, info) => {
        const result = await contractCall(request, info, c.method, c.path, {
          body: c.method === 'GET' ? undefined : {},
          headers: { authorization: 'Bearer qa-invalid-token', cookie: 'mpc_session=invalid; __Host-mpc_session=invalid; mpc_admin=invalid; __Host-mpc_admin=invalid' },
        })
        assertContract(result, expected!)
      })
    }
    if (c.originCheck) {
      test(`${c.id} ${c.method} ${c.route} — foreign origin is rejected`, async ({ request }, info) => {
        const result = await contractCall(request, info, c.method, c.path, {
          body: c.method === 'GET' ? undefined : {}, origin: 'https://attacker.example',
        })
        assertContract(result, { status: 403, error: 'cross_origin' })
      })
    }
  }
})
