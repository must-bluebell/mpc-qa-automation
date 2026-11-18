import { test } from '@playwright/test'
import { signIn } from '../../fixtures/api'
import { contracts, configuredCases, contractCall, assertContract, requireIsolatedApi } from '../../fixtures/api-contracts'
import { target } from '../../config/target'
import type { SuccessCase } from '../../fixtures/api-case-config.mjs'

// Deterministic successes that need no seeded IDs, funded wallets or third-party services.
const defaults: Record<string, SuccessCase> = {
  API002: { auth: 'anonymous', path: '/api/auth/logout', body: {}, expected: { status: 200, fields: { ok: true } } },
  API003: { auth: 'anonymous', path: '/api/auth/nonce', body: {}, expected: { status: 200, types: { nonce: 'string' } } },
  API004: { auth: 'anonymous', path: '/api/auth/session', expected: { status: 200, fields: { address: null } } },
  API011: { auth: 'wallet', path: '/api/activities', expected: { status: 200, fields: { activities: [] } } },
  API014: { auth: 'admin', path: '/api/admin/admins', expected: { status: 200, types: { admins: 'array' } } },
  API041: { auth: 'admin', path: '/api/admin/roles', expected: { status: 200, types: { roles: 'array' } } },
  API024: { auth: 'anonymous', path: '/api/admin/logout', body: {}, expected: { status: 200, fields: { ok: true } } },
  API092: { auth: 'anonymous', path: '/api/home', expected: { status: 200, fields: { address: null, member: false } } },
  API124: { auth: 'wallet', path: '/my-mine/run', expected: { status: 200, fields: { script: [], records: [] } } },
  API125: { auth: 'wallet', path: '/my-mine/run', body: { script: [] }, expected: { status: 200, fields: { records: [] } } },
  API138: { auth: 'anonymous', path: '/api/quests', expected: { status: 200, fields: { viewer: 'signed_out' }, types: { quests: 'array' } } },
  API146: { auth: 'anonymous', path: '/api/register/status', expected: { status: 200, fields: { registered: false }, types: { skipEmailOtp: 'boolean' } } },
  API156: { auth: 'anonymous', path: '/.well-known/security.txt', expected: { status: 200, text: 'Contact:', contentType: 'text/plain' } },
  API162: { auth: 'anonymous', path: '/api/telemetry/latency', body: { samples: [] }, expected: { status: 204, empty: true } },
  API163: { auth: 'anonymous', path: '/api/telemetry/website', headers: { 'sec-gpc': '1' }, body: {}, expected: { status: 204, empty: true } },
  API166: { auth: 'anonymous', path: '/api/vote/proposals', expected: { status: 200, types: { proposals: 'array|null' } } },
}

test.use({ trace: 'off' })

test.describe('Unity success contracts', { tag: ['@api', '@collection-success'] }, () => {
  // A configured admin or transaction response must never appear in a Playwright trace.
  test.beforeEach(() => requireIsolatedApi())
  for (const c of contracts) {
    test(`${c.id} ${c.method} ${c.route} — successful fixture contract`, async ({ playwright }, info) => {
      const fixture = configuredCases[c.id]?.success ?? defaults[c.id]
      test.skip(!fixture, `Requires QA_API_CASES_FILE entry ${c.id}.success with seeded inputs and an exact response contract.`)
      const selected = fixture!
      const stateEnv = selected.auth === 'admin' ? 'QA_API_ADMIN_STATE_FILE' : selected.storageStateEnv
      const state = stateEnv ? process.env[stateEnv] : undefined
      if (selected.auth === 'admin' || selected.auth === 'fixture') test.skip(!state, `Requires ${stateEnv}`)
      if (selected.auth === 'cron') test.skip(!process.env.QA_API_CRON_SECRET, 'Requires isolated QA_API_CRON_SECRET')
      const context = await playwright.request.newContext({ baseURL: target().baseUrl, ...(state ? { storageState: state } : {}) })
      try {
        if (selected.auth === 'wallet') await signIn(context, info)
        const headers = { ...selected.headers, ...(selected.auth === 'cron' ? { authorization: `Bearer ${process.env.QA_API_CRON_SECRET}` } : {}) }
        assertContract(await contractCall(context, info, c.method, selected.path, { body: selected.body, headers }), selected.expected)
      } finally { await context.dispose() }
    })
  }
})
