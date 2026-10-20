import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { assertRecordedDestination, recordedMatches, recordedResponseOk, recordedAssertion, recordedError } from './recorded-load-policy.mjs'

// Only this inventory is passed in; captured JMX code, headers and request bodies are never executed.
const plan = JSON.parse(Buffer.from(process.env.QA_RECORDED_PLAN, 'base64').toString('utf8'))
const report = { samples: [], errors: [], phases: [], measurement: 'Sequential local journey with fresh fixture wallets; source recording has one thread and one loop. k6 separately measures concurrent load.' }
const context = new AsyncLocalStorage()
const originalFetch = globalThis.fetch
const originalLog = console.log
console.log = (...args) => { if (String(args[0]).startsWith('PASS:')) originalLog(String(args[0])) }
const emit = () => originalLog(`MPC_RECORDED_RESULT:${JSON.stringify(report)}`)
const timer = setTimeout(() => { report.errors.push('Recorded journey deadline exceeded.'); emit(); process.exit(124) }, Number(process.env.QA_RECORDED_TIMEOUT_MS))

globalThis.fetch = async (input, options = {}) => {
  const url = assertRecordedDestination(typeof input === 'string' || input instanceof URL ? String(input) : input.url)
  const method = options.method || input?.method || 'GET'
  let rpc = []
  if (['anvil', 'anvil-opbnb'].includes(url.hostname)) {
    try { const body = JSON.parse(options.body); rpc = [body].flat().map(item => item.method) } catch {}
  }
  const scope = context.getStore()
  const candidates = recordedMatches(plan, url, method, rpc)
  const rows = candidates.filter(row => (!row.manual || scope?.ids?.includes(row.id))
    && (row.target !== 'app' || scope?.capture && (!scope.ids || scope.ids.includes(row.id))))
  const started = performance.now()
  let response, ok = false
  try {
    // No redirect may escape the isolated stack, including redirects from a local endpoint.
    response = await originalFetch(input, { ...options, redirect: 'manual' })
    ok = await recordedResponseOk(response, rpc.includes('eth_call'), rows.length > 0)
    return response
  } finally {
    for (const row of rows) report.samples.push({ id: row.id, status: response?.status ?? 0,
      ok: ok && row.statuses.includes(response?.status), durationMs: Math.round((performance.now() - started) * 100) / 100 })
  }
}

try {
  const harness = await import('/app/test/scenario/local/scripts/harness.mjs')
  const { Session } = harness
  const originalRequest = Session.prototype.request
  let mineSession
  Session.prototype.request = async function (path, body, expected = 200, method) {
    if (path === '/my-mine/run') mineSession = this
    const prior = context.getStore()
    const first = report.samples.length
    try {
      return await context.run({ ...prior, capture: [expected].flat().some(code => code >= 200 && code < 300) },
        () => originalRequest.call(this, path, body, expected, method))
    } catch (error) {
      for (const sample of report.samples.slice(first)) sample.ok = false
      throw error
    }
  }
  for (const phase of ['mine', 'vote']) {
    try {
      await import(`/app/test/scenario/local/scripts/${phase}.mjs`)
      report.phases.push({ phase, status: 'passed' })
    } catch (error) {
      report.phases.push({ phase, status: 'failed' })
      report.errors.push(`${phase}: ${recordedError(error)}; local scenario assertions failed. Captured credentials and response bodies are not logged.`)
    }
  }
  if (!mineSession) throw new Error('No authenticated mining fixture completed')
  const runCase = (ids, work) => recordedAssertion(report, ids, () => context.run({ capture: true, ids }, work))
  const { read: readContract } = await import('/app/docker/local-chain.mjs')
  const bscBalance = await readContract(mineSession.l1, 'MpcWaitlistSBT', harness.deployment[97].contracts.sbt, 'balanceOf', [mineSession.address])
  harness.assert.equal(typeof bscBalance, 'bigint')
  // These source requests were specifically a quest relay, not a membership claim.
  const administrator = await harness.admin()
  const questKey = await harness.quest(administrator, 'jmx', { amount: 1 })
  let prepared
  try {
    await mineSession.request('/api/quest/link-open', { questKey })
    await runCase(['JMX-23'], async () => {
      prepared = await mineSession.request('/api/relay/challenge', { kind: 'quest', questKey })
      harness.assert.equal(Number(prepared.typedData.domain.chainId), 5611)
    })
    await runCase(['JMX-25'], async () => {
      if (!prepared) throw new Error('Quest challenge prerequisite failed')
      const { read, receipt } = await import('/app/docker/local-chain.mjs')
      const energy = harness.deployment[5611].contracts.energy
      const before = await read(mineSession.l2, 'OpBnbEnergy', energy, 'balanceOf', [mineSession.address])
      const userSig = await mineSession.l2.wallet.account.signTypedData(prepared.typedData)
      const sent = await harness.submit(mineSession, mineSession.l2, '/api/relay/submit', {
        challenge: prepared.challenge, userSig, attemptId: prepared.attemptId, activityId: prepared.activityId,
      })
      await receipt(mineSession.l2, sent.txHash)
      await harness.finalize(mineSession.l2)
      harness.assert.equal(await read(mineSession.l2, 'OpBnbEnergy', energy, 'balanceOf', [mineSession.address]), before + 1n)
    })
    await runCase(['JMX-39'], async () => {
      if (!prepared) throw new Error('Quest challenge prerequisite failed')
      await harness.eventually(async () => (await mineSession.request(`/api/relay/status?challenge=${prepared.challenge}`)).state === 'landed', 'quest relay landed')
    })
  } finally {
    await administrator.request(`/api/admin/quests/${questKey}`, { status: 'closed' }, 200, 'PATCH')
  }
  const pages = async (id, path) => runCase([id], async () => {
    const response = await fetch(`http://127.0.0.1:3400${path}`, { signal: AbortSignal.timeout(60_000) })
    if (response.status !== 200 || !(await response.text()).includes('<html')) throw new Error('Page assertion failed')
  })
  for (const [id, path] of [['JMX-10', '/'], ['JMX-11', '/'], ['JMX-37', '/security'], ['JMX-38', '/security']]) await pages(id, path)
  for (const [id, path] of [['JMX-05', '/api/notifications'], ['JMX-06', '/api/join/social-complete'],
    ['JMX-07', '/api/activities'], ['JMX-08', '/api/home'], ['JMX-09', '/api/register/status'],
    ['JMX-12', '/my-mine/energy'], ['JMX-13', '/my-mine/ranks'], ['JMX-15', '/api/energy/compensation'],
    ['JMX-17', '/my-mine/jv'], ['JMX-18', '/api/quests'], ['JMX-21', '/my-mine/run'],
    ['JMX-22', '/api/quiz/today'], ['JMX-33', '/my-mine/run?reconcile=1'],
    ['JMX-40', '/api/vote/proposals'], ['JMX-43', '/api/vote/proposals'], ['JMX-44', '/api/vote/proposals']]) {
    await runCase([id], () => mineSession.request(path))
  }
  await runCase(['JMX-02'], () => mineSession.request('/api/join/event', { runId: randomUUID(), step: 'page_open' }))
  await runCase(['JMX-01'], async () => {
    // Read the public policy version without executing a Next server-only module in this runner.
    const policySource = readFileSync('/app/src/platform/website-analytics/server/policy.ts', 'utf8')
    const version = policySource.match(/export\s+const\s+AUDIENCE_POLICY_VERSION\s*=\s*['"]([a-zA-Z0-9_.-]+)['"]/)?.[1]
    if (!version) throw new Error('Current public telemetry policy version is unavailable')
    const response = await fetch('http://127.0.0.1:3400/api/telemetry/website', { method: 'POST',
      headers: { origin: process.env.APP_ORIGIN, 'content-type': 'application/json', 'user-agent': 'MPC QA recorded journey' },
      body: JSON.stringify({ visitor: randomUUID(), path: '/', basis: 'consent', policyVersion: version }), signal: AbortSignal.timeout(60_000) })
    if (response.status !== 204) throw new Error('Telemetry assertion failed')
  })
  const feed = await mineSession.request('/api/activities')
  const ids = feed.activities.filter(item => item.status === 'succeeded').slice(0, 3).map(item => item.activityId)
  if (ids.length !== 3) throw new Error('Three completed real Activity records are required')
  const activityPairs = [['JMX-26', 'JMX-29'], ['JMX-35', 'JMX-36'], ['JMX-41', 'JMX-42']]
  for (const [index, pair] of activityPairs.entries()) {
    await runCase([pair[0]], () => mineSession.request(`/api/activities/${ids[index]}/seen`, {}))
  }
  const { ACTIVITY_SUCCESS_VISIBLE_MS } = await harness.jiti.import('/app/src/modules/activity/domain/types.ts')
  for (const [index, pair] of activityPairs.entries()) {
    await runCase([pair[1]], async () => {
      // Observe the real readiness rule; never alter timestamps or weaken the visibility guard.
      await harness.eventually(async () => {
        const [row] = await harness.sql`SELECT seen_at <= now() - make_interval(secs => ${ACTIVITY_SUCCESS_VISIBLE_MS / 1000}) AS ready
          FROM transaction_activities WHERE id=${ids[index]}::bigint AND wallet=${mineSession.address.toLowerCase()}`
        return row?.ready === true
      }, 'successful Activity visibility window elapsed')
      await mineSession.request(`/api/activities/${ids[index]}/dismiss`, {})
      const after = await mineSession.request('/api/activities')
      harness.assert.ok(!after.activities.some(item => item.activityId === ids[index]))
    })
  }
  await runCase(['JMX-46'], async () => {
    await mineSession.request('/api/auth/logout', {})
    if ((await mineSession.request('/api/auth/session')).address !== null) throw new Error('Logout did not clear identity')
  })
} catch (error) {
  report.errors.push(`${recordedError(error)}: recorded journey preparation or assertions did not complete.`)
} finally {
  clearTimeout(timer)
  globalThis.fetch = originalFetch
  console.log = originalLog
  emit()
}
