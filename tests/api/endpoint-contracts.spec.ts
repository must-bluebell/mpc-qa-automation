import { test } from '@playwright/test'
import { contracts, configuredCases, contractCall, assertContract, requireIsolatedApi } from '../../fixtures/api-contracts'
import { isHostedReadBaseline } from '../../fixtures/api-case-config.mjs'

test.describe('Unity collection contracts', { tag: ['@api', '@regression', '@collection'] }, () => {
  for (const c of contracts) {
    const expected = configuredCases[c.id]?.baseline ?? c.baseline
    // Reviewed read-only GET probes run on hosted targets; every other case stays on the isolated stack.
    const gate = () => { if (!isHostedReadBaseline(c, Boolean(configuredCases[c.id]?.baseline))) requireIsolatedApi() }
    test(`${c.id} ${c.method} ${c.route} — baseline contract`, async ({ request }, info) => {
      gate()
      info.annotations.push({ type: 'source', description: c.source })
      test.skip(!expected, c.blocked)
      const result = await contractCall(request, info, c.method, c.path, {
        body: c.body ?? (['GET', 'OPTIONS'].includes(c.method) ? undefined : {}), headers: c.headers,
      })
      assertContract(result, expected!)
    })
    if (expected?.status === 401) {
      test(`${c.id} ${c.method} ${c.route} — forged credentials cannot bypass authorization`, async ({ request }, info) => {
        gate()
        const result = await contractCall(request, info, c.method, c.path, {
          body: c.method === 'GET' ? undefined : {},
          headers: { authorization: 'Bearer qa-invalid-token', cookie: 'mpc_session=invalid; __Host-mpc_session=invalid; mpc_admin=invalid; __Host-mpc_admin=invalid' },
        })
        assertContract(result, expected!)
      })
    }
    if (c.originCheck) {
      test(`${c.id} ${c.method} ${c.route} — foreign origin is rejected`, async ({ request }, info) => {
        gate()
        const result = await contractCall(request, info, c.method, c.path, {
          body: c.method === 'GET' ? undefined : {}, origin: 'https://attacker.example',
        })
        assertContract(result, { status: 403, error: 'cross_origin' })
      })
    }
  }
})
