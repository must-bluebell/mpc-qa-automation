import { test, expect } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { appOrigin, call, requireWrites, signIn, prepareSignIn } from '../../fixtures/api'
import { storedActivity } from '../../fixtures/stored-activity'
import ts from 'typescript'

const exec = promisify(execFile)
test.describe('Security requirements', { tag: ['@api', '@security', '@critical', '@regression'] }, () => {
  test.beforeEach(() => requireWrites())

  for (const body of [null, [], 42, 'hostile']) {
    test(`SEC-01 - Non-object authentication input ${JSON.stringify(body)} is rejected safely`, async ({ request }, info) => {
      await call(request, info, 'POST', '/api/auth/nonce', { body: {} })
      const result = await call(request, info, 'POST', '/api/auth/verify', { body })
      expect(result.status).toBe(400)
      expect(result.json?.error).toBe('missing_fields')
      expect((await call(request, info, 'GET', '/api/auth/session')).json?.address ?? null).toBeNull()
    })
  }

  test('SEC-02 - Session cookies are protected and tampering cannot authenticate', async ({ request, playwright }, info) => {
    await signIn(request, info)
    const state = await request.storageState()
    const cookie = state.cookies.find(cookie => cookie.name.endsWith('mpc_session'))!
    expect(cookie).toBeTruthy()
    expect(cookie.httpOnly).toBe(true)
    expect(cookie.sameSite).toBe('Lax')
    expect(cookie.secure).toBe(new URL(appOrigin()).protocol === 'https:')
    const stranger = await playwright.request.newContext({ baseURL: appOrigin(), extraHTTPHeaders: { cookie: `${cookie.name}=tampered.${cookie.value.slice(-8)}` } })
    try {
      expect((await call(stranger, info, 'GET', '/api/auth/session')).json?.address ?? null).toBeNull()
      expect((await call(stranger, info, 'GET', '/api/notifications')).status).toBe(401)
    } finally { await stranger.dispose() }
  })

  test('SEC-03 - Another user cannot read or change an owned activity (BOLA/IDOR)', async ({ request, playwright }, info) => {
    const owner = await signIn(request, info)
    const record = await storedActivity(owner.address, 'failed')
    const stranger = await playwright.request.newContext({ baseURL: appOrigin() })
    try {
      await signIn(stranger, info)
      const before = await record.snapshot()
      const ownerFeed = await call(request, info, 'GET', '/api/activities')
      expect(ownerFeed.status).toBe(200)
      expect(Array.isArray(ownerFeed.json?.activities)).toBe(true)
      expect((ownerFeed.json!.activities as { activityId: string }[]).map(activity => activity.activityId)).toContain(record.id)
      expect((await call(stranger, info, 'GET', `/api/activities/${record.id}/status`)).status).toBe(404)
      for (const action of ['seen', 'dismiss']) expect((await call(stranger, info, 'POST', `/api/activities/${record.id}/${action}`, { body: {} })).status).toBe(404)
      const feed = await call(stranger, info, 'GET', `/api/activities?wallet=${owner.address}`)
      expect(feed.status).toBe(200)
      expect(Array.isArray(feed.json?.activities)).toBe(true)
      expect(JSON.stringify(feed.json)).not.toContain(`"activityId":"${record.id}"`)
      expect(await record.snapshot()).toEqual(before)
    } finally { await stranger.dispose(); await record.cleanup() }
  })

  test('SEC-04 - SQL injection strings cannot select or modify another record', async ({ request }, info) => {
    const user = await signIn(request, info)
    const record = await storedActivity(user.address, 'failed')
    try {
      const before = await record.snapshot()
      for (const id of ["1 OR 1=1", "1' UNION SELECT password FROM admins--", '1; DELETE FROM transaction_activities--']) {
        const result = await call(request, info, 'POST', `/api/activities/${encodeURIComponent(id)}/dismiss`, { body: {} })
        expect(result.status).toBe(400)
        expect(result.text).not.toMatch(/syntax error|postgres|SQLSTATE|stack|password=/i)
        expect((await call(request, info, 'PATCH', '/api/notifications', { body: { id } })).status).toBe(400)
      }
      expect(await record.snapshot()).toEqual(before)
    } finally { await record.cleanup() }
  })

  test('SEC-05 - A wallet cannot change admin roles or verification status', async ({ request }, info) => {
    await signIn(request, info)
    const denied = await call(request, info, 'PATCH', '/api/admin/admins/1', { body: { role: 'admin', verified: true, approved: true } })
    expect(denied.status).toBe(401)
    expect(denied.json?.error).toBe('not_admin')
    expect((await call(request, info, 'GET', '/api/admin/admins', { origin: appOrigin() })).status).toBe(401)
  })

  test('SEC-06 - Client status fields cannot promote a pending transaction', async ({ request }, info) => {
    const user = await signIn(request, info)
    const record = await storedActivity(user.address, 'pending')
    try {
      const before = await record.snapshot()
      const result = await call(request, info, 'POST', `/api/activities/${record.id}/seen`, { body: { status: 'succeeded', outcome: 'succeeded', verified: true } })
      expect(result.status).toBe(409)
      expect(await record.snapshot()).toEqual(before)
    } finally { await record.cleanup() }
  })

  for (const [name, body, status] of [
    ['null', null, 400], ['overflowing ID', { id: '9'.repeat(100) }, 400],
    ['overflowing snapshot ID', { all: true, throughId: '9'.repeat(100) }, 400],
    ['oversized payload', { id: '1', padding: 'x'.repeat(16_000) }, 413],
  ] as const) {
    test(`SEC-07 - Notifications reject ${name} without a server error`, async ({ request }, info) => {
      await signIn(request, info)
      const result = await call(request, info, 'PATCH', '/api/notifications', { body })
      expect(result.status).toBe(status)
      expect(result.text).not.toMatch(/postgres|SQLSTATE|stack|\/app\//i)
    })
  }

  test('SEC-08 - Concurrent duplicate dismissals preserve one terminal outcome', async ({ request }, info) => {
    const user = await signIn(request, info)
    const record = await storedActivity(user.address, 'failed')
    try {
      const before = await record.snapshot()
      const responses = await Promise.all(Array.from({ length: 5 }, () => call(request, info, 'POST', `/api/activities/${record.id}/dismiss`, { body: {} })))
      expect(responses.map(response => response.status)).toEqual([200, 200, 200, 200, 200])
      const after = await record.snapshot()
      expect(after.id).toBe(before.id)
      expect(after.outcome).toBe(before.outcome)
      expect(after.finished_at).toBe(before.finished_at)
      expect(after.dismissed_at).not.toBeNull()
      expect((await call(request, info, 'POST', `/api/activities/${record.id}/dismiss`, { body: {} })).status).toBe(200)
      expect((await record.snapshot()).dismissed_at).toBe(after.dismissed_at)
    } finally { await record.cleanup() }
  })

  test('SEC-09 - Authentication failures are auditable without logging credentials', async ({ request }, info) => {
    const container = process.env.QA_WEB_FIXTURE_CONTAINER
    expect(container, 'Audit verification requires the isolated app container').toBeTruthy()
    const cid = `qa-${crypto.randomUUID()}`
    const canary = `private-${crypto.randomUUID()}@example.test`
    const nonce = await call(request, info, 'POST', '/api/auth/nonce', { body: {} })
    const result = await call(request, info, 'POST', '/api/auth/verify', { body: { message: canary, signature: 'invalid', password: canary }, headers: { 'x-mpc-cid': cid } })
    expect(result.status).toBe(400)
    await expect.poll(async () => {
      const logs = await exec('docker', ['logs', '--since', '2m', container!], { maxBuffer: 8 * 1024 * 1024 })
      return `${logs.stdout}\n${logs.stderr}`.split('\n').filter(line => line.includes(cid)).join('\n')
    }).toContain('rejected')
    const logs = await exec('docker', ['logs', '--since', '2m', container!], { maxBuffer: 8 * 1024 * 1024 })
    const audit = `${logs.stdout}\n${logs.stderr}`.split('\n').filter(line => line.includes(cid)).join('\n')
    expect(audit).toContain('auth/verify')
    expect(audit).not.toContain(canary)
    expect(audit).not.toContain(String(nonce.json?.nonce))
    expect(result.text).not.toMatch(/stack|SESSION_SECRET|DATABASE_URL|\/app\//)
    await info.attach('Redacted audit event', { body: audit, contentType: 'text/plain' })
  })

  test('SEC-10 - Dashboard evidence does not publish issued authentication nonces', async ({ request }, info) => {
    const response = await call(request, info, 'POST', '/api/auth/nonce', { body: {} })
    expect(response.status).toBe(200)
    const evidence = info.attachments.find(attachment => attachment.name.startsWith('api POST /api/auth/nonce'))
    expect(evidence?.body?.toString().includes(String(response.json?.nonce)), 'Authentication nonce must be redacted from report attachments').toBe(false)
  })

  test('SEC-11 - Protected-record SQL stores bind parameters instead of executing raw SQL strings', async ({}, info) => {
    const container = process.env.QA_WEB_FIXTURE_CONTAINER
    expect(container).toBeTruthy()
    const evidence = []
    for (const path of ['notifications/server/store.ts', 'activity/server/activity-feed.ts', 'auth/server/nonce-store.ts']) {
      const source = await exec('docker', ['exec', container!, 'cat', `/app/src/modules/${path}`])
      const file = ts.createSourceFile(path, source.stdout, ts.ScriptTarget.Latest, true)
      const rawCalls: string[] = []
      let parameterized = 0
      function visit(node: ts.Node) {
        if (ts.isTaggedTemplateExpression(node) && /^(sql|getSql\(\))$/.test(node.tag.getText(file))) parameterized++
        if (ts.isCallExpression(node)) {
          const expression = node.expression.getText(file)
          if ((expression === 'sql' && node.arguments.length > 0) || /^sql\.(unsafe|query)$/.test(expression)) rawCalls.push(expression)
        }
        ts.forEachChild(node, visit)
      }
      visit(file)
      expect(rawCalls, `${path}: raw SQL execution is forbidden for these protected records`).toEqual([])
      expect(parameterized, `${path}: expected parameterized SQL tagged templates`).toBeGreaterThan(0)
      evidence.push({ path, parameterized, rawCalls: rawCalls.length })
    }
    await info.attach('SQL parameterization review', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' })
  })

  test('SEC-12 - Concurrent use of one signed nonce creates exactly one authenticated session', async ({ request, playwright }, info) => {
    const prepared = await prepareSignIn(request, info)
    const storageState = await request.storageState()
    const clients = await Promise.all([0, 1].map(() => playwright.request.newContext({ baseURL: appOrigin(), storageState })))
    try {
      const responses = await Promise.all(clients.map(client => call(client, info, 'POST', '/api/auth/verify', { body: { message: prepared.message, signature: prepared.signature } })))
      expect(responses.map(response => response.status).sort()).toEqual([200, 401])
      for (const [index, client] of clients.entries()) {
        const session = await call(client, info, 'GET', '/api/auth/session')
        expect(session.json?.address ?? null).toBe(responses[index]!.status === 200 ? prepared.address : null)
      }
    } finally { await Promise.all(clients.map(client => client.dispose())) }
  })

  test('SEC-13 - Isolated production database routing rejects external origins and proxies', async ({}, info) => {
    const container = process.env.QA_WEB_FIXTURE_CONTAINER!
    expect(container).toBeTruthy()
    const source = await exec('docker', ['exec', container, 'cat', '/app/src/platform/db/local-endpoint.ts'])
    const compiled = ts.transpileModule(source.stdout, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
    const base = { NODE_ENV: 'production', QA_ISOLATED_RUNTIME: '1', APP_ORIGIN: 'http://localhost:3440', DATABASE_URL: 'postgres://test:test@postgres:5432/test', NEON_FETCH_ENDPOINT: 'http://neon-proxy:4444/sql' }
    const cases = [
      { name: 'isolated Compose endpoint', env: base, expected: base.NEON_FETCH_ENDPOINT },
      { name: 'hosted production ignores override', env: { ...base, QA_ISOLATED_RUNTIME: undefined }, expected: null },
      ...[
        { APP_ORIGIN: 'https://external.example' }, { DATABASE_URL: 'postgres://test:test@external.example:5432/test' },
        { NEON_FETCH_ENDPOINT: 'http://external.example:4444/sql' }, { NEON_FETCH_ENDPOINT: 'http://neon-proxy:4444/sql?redirect=external' },
        { NEON_FETCH_ENDPOINT: 'http://test:test@neon-proxy:4444/sql' }, { DATABASE_URL: 'postgres://test:test@postgres:5555/test' },
      ].map((overrides, index) => ({ name: `unsafe endpoint configuration ${index + 1}`, env: { ...base, ...overrides }, throws: true })),
    ]
    const script = `const policy={};new Function('exports',${JSON.stringify(compiled)})(policy);const cases=${JSON.stringify(cases)};console.log(JSON.stringify(cases.map(c=>{try { const value=policy.localFetchEndpoint(c.env);return {name:c.name,passed:!c.throws&&value===c.expected}; } catch {return {name:c.name,passed:c.throws===true};}})));`
    const results = await new Promise<{ name: string; passed: boolean }[]>((resolve, reject) => {
      const child = execFile('docker', ['exec', '-i', container, 'node', '-'], { timeout: 30_000 }, (error, stdout) => error ? reject(error) : resolve(JSON.parse(stdout)))
      child.stdin!.end(script)
    })
    await info.attach('Production database routing policy', { body: JSON.stringify(results, null, 2), contentType: 'application/json' })
    for (const result of results) expect(result.passed, result.name).toBe(true)
  })
})
