import { test } from '@playwright/test'
import { contracts, configuredCases, contractCall, assertContract, requireApiWrites } from '../../fixtures/api-contracts'
import { isHostedReadBaseline, baselineForEnvironment, originForEnvironment } from '../../fixtures/api-case-config.mjs'

test.describe('Unity collection contracts', { tag: ['@api', '@regression', '@collection'] }, () => {
  for (const c of contracts) {
    const expected = baselineForEnvironment(c, process.env.QA_ENVIRONMENT, configuredCases[c.id]?.baseline)
    // Reviewed reads run by default; other built-in probes require explicit API write authorization.
    const gate = () => { if (!isHostedReadBaseline(c, Boolean(configuredCases[c.id]?.baseline))) requireApiWrites() }
    test(`${c.id} ${c.method} ${c.route} — baseline contract`, async ({ request }, info) => {
      gate()
      info.annotations.push({ type: 'source', description: c.source })
      test.skip(!expected, c.blocked)
      const result = await contractCall(request, info, c.method, c.path, {
        body: c.body ?? (['GET', 'OPTIONS'].includes(c.method) ? undefined : {}), headers: c.headers,
      })
      assertContract(result, expected!)
    })
    if (c.baseline?.status === 401 || expected?.status === 401) {
      test(`${c.id} ${c.method} ${c.route} — forged credentials preserve the rejection contract`, async ({ request }, info) => {
        gate()
        const result = await contractCall(request, info, c.method, c.path, {
          body: c.method === 'GET' ? undefined : c.body ?? {},
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
        assertContract(result, originForEnvironment(c, process.env.QA_ENVIRONMENT))
      })
    }
  }
})
