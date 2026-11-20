import test from 'node:test'
import assert from 'node:assert/strict'
import { webTestEnvironment } from '../../pipeline/lib/web-isolated.mjs'
import { composeArgs } from '../../pipeline/adapters/local-stack.mjs'
import { resolveEnvironment } from '../../pipeline/lib/env.mjs'

test('web setup refuses remote or non-isolated stack profiles before enabling writes', () => {
  for (const profile of [
    { baseUrl: 'https://app.globalmpc.tech', isolated: false, stack: {} },
    { baseUrl: 'https://app.globalmpc.tech', isolated: true, stack: {} },
    { baseUrl: 'http://localhost:3410', isolated: false, stack: {} },
  ]) assert.throws(() => webTestEnvironment(profile), /isolated local stack/)
})

test('web setup uses the supplied stack target and ports without mutating the profile', () => {
  const profile = { baseUrl: 'http://localhost:3410', appOrigin: 'http://127.0.0.1:3410', isolated: true,
    stack: { composeProject: 'existing', ports: { web: 3410, anvil: 8555, opbnbAnvil: 8556, postgres: 5440, neonProxy: 4454 } } }
  const original = structuredClone(profile)
  const env = webTestEnvironment(profile)
  assert.equal(env.baseUrl, 'http://localhost:3410')
  assert.equal(env.appOrigin, 'http://127.0.0.1:3410')
  assert.equal(env.stack.composeProject, 'existing')
  assert.deepEqual(env.stack.ports, original.stack.ports)
  env.stack.ports.web = 9999
  assert.deepEqual(profile, original)
})

test('only the isolated verification profile receives the bounded-memory diagnostic overlay', () => {
  const profile = { name: 'web-isolated', isolated: true, stack: { webmpcPath: '../WEB MPC', composeProject: 'qa-test' } }
  assert.ok(composeArgs(profile, ['ps']).args.some(arg => arg.endsWith('docker-compose.verification.yml')))
  assert.ok(!composeArgs({ ...profile, name: 'local-docker' }, ['ps']).args.some(arg => arg.endsWith('docker-compose.verification.yml')))
  assert.throws(() => composeArgs({ ...profile, isolated: false }, ['ps']), /isolated/)
})

test('default QA and verification aliases target the same verified stack with runtime protection', () => {
  const active = resolveEnvironment('local-docker')
  const verified = resolveEnvironment('web-isolated')
  const standalone = webTestEnvironment()
  assert.equal(standalone.stack.composeProject, active.stack.composeProject)
  assert.equal(standalone.baseUrl, verified.baseUrl)
  assert.equal(standalone.appOrigin, verified.appOrigin)
  assert.deepEqual(standalone.stack.ports, verified.stack.ports)
  assert.equal(active.baseUrl, verified.baseUrl)
  assert.equal(active.appOrigin, active.baseUrl)
  assert.equal(active.stack.composeProject, verified.stack.composeProject)
  assert.deepEqual(active.stack.ports, verified.stack.ports)
  for (const env of [active, verified]) {
    assert.equal(env.isolated, true)
    // Command construction for teardown uses a dummy local database URL, so this
    // config invariant never requires a private application .env in clean CI.
    assert.ok(composeArgs(env, ['down']).args.some(arg => arg.endsWith('docker-compose.verification.yml')))
  }
})
