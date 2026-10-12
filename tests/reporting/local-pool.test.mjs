import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as stack from '../../pipeline/adapters/local-stack.mjs'
import { pooledDatabaseUrl, evaluateStackHealth } from '../../pipeline/adapters/local-stack.mjs'

test('local pool preserves credentials and database while routing through the pool', () => {
  const source = 'postgres://qa:p%40ss@postgres:5432/localqa?sslmode=disable'
  const result = new URL(pooledDatabaseUrl(source))
  assert.equal(result.hostname, 'pgbouncer')
  assert.equal(result.port, '5432')
  assert.equal(result.password, 'p%40ss')
  assert.equal(result.pathname, '/localqa')
  assert.equal(result.search, '?sslmode=disable')
})

test('local pool refuses an external database without exposing its URL', () => {
  assert.throws(() => pooledDatabaseUrl('postgres://qa:secret@example.com/production'), { message: 'QA pooling requires the local postgres service' })
})

test('a configured pool is required for stack health', () => {
  const services = ['web', 'postgres', 'neon-proxy', 'anvil', 'anvil-opbnb'].map(service => ({ service, state: 'running', health: 'healthy' }))
  assert.equal(evaluateStackHealth(services, { databasePool: true }).healthy, false)
  assert.equal(evaluateStackHealth([...services, { service: 'pgbouncer', state: 'running', health: 'unhealthy' }], { databasePool: true }).healthy, false)
  assert.equal(evaluateStackHealth([...services, { service: 'pgbouncer', state: 'running', health: 'healthy' }], { databasePool: true }).healthy, true)
})

test('Compose receives the validated local database instead of an ambient URL', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-pool-'))
  try {
    mkdirSync(join(dir, 'docker'))
    const source = 'postgres://qa:local-only@postgres:5432/localqa'
    writeFileSync(join(dir, 'docker/.env'), 'DATABASE_URL=' + source)
    assert.equal(typeof stack.composeArgs, 'function')
    const result = stack.composeArgs({ isolated: true, stack: { webmpcPath: dir, databasePool: true, composeProject: 'qa-test' } }, ['up'])
    assert.equal(result.env.DATABASE_URL, source)
    assert.equal(new URL(result.env.QA_POOLED_DATABASE_URL).hostname, 'pgbouncer')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('teardown does not read database credentials', () => {
  assert.equal(typeof stack.composeArgs, 'function')
  const result = stack.composeArgs({ isolated: true, stack: { webmpcPath: '/nonexistent-qa-pool-checkout', databasePool: true, composeProject: 'qa-test' } }, ['down'])
  assert.equal(new URL(result.env.QA_POOLED_DATABASE_URL).hostname, 'pgbouncer')
})

test('missing checkout remains a successful teardown no-op with pooling enabled', async () => {
  const result = await stack.stackDown({ isolated: true, stack: { webmpcPath: '/nonexistent-qa-pool-checkout', databasePool: true, composeProject: 'qa-test' } })
  assert.equal(result.code, 0)
})
