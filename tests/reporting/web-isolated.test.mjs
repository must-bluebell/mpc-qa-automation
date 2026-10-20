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

test('web setup preserves the existing stack and binds origin to its new local target', () => {
  const profile = { baseUrl: 'http://localhost:3410', isolated: true, stack: { composeProject: 'existing', ports: { web: 3410 } } }
  const env = webTestEnvironment(profile)
  assert.notEqual(env.stack.composeProject, profile.stack.composeProject)
  assert.notEqual(env.stack.ports.web, profile.stack.ports.web)
  assert.equal(env.appOrigin, env.baseUrl)
  assert.equal(profile.stack.composeProject, 'existing')
  assert.equal(profile.stack.ports.web, 3410)
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
  assert.equal(active.baseUrl, verified.baseUrl)
  assert.equal(active.appOrigin, active.baseUrl)
  assert.equal(active.stack.composeProject, verified.stack.composeProject)
  assert.deepEqual(active.stack.ports, verified.stack.ports)
  for (const env of [active, verified]) {
    assert.equal(env.isolated, true)
    assert.ok(composeArgs(env, ['ps']).args.some(arg => arg.endsWith('docker-compose.verification.yml')))
  }
})
