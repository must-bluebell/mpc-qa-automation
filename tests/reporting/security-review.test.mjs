import test from 'node:test'
import assert from 'node:assert/strict'
import { childEnv } from '../../pipeline/lib/proc.mjs'
import { SECRET_KEYS } from '../../pipeline/lib/env.mjs'
import { classifyFailure } from '../../pipeline/lib/classify.mjs'

test('wallet workers receive only explicitly allowed secrets, including extra env values', () => {
  const extra = Object.fromEntries(SECRET_KEYS.map(key => [key, `private-${key}`]))
  const env = childEnv(extra, { passSecrets: ['QA_SEED_PHRASE'] })
  assert.equal(env.QA_SEED_PHRASE, extra.QA_SEED_PHRASE)
  for (const key of SECRET_KEYS.filter(k => k !== 'QA_SEED_PHRASE')) assert.equal(env[key], undefined, key)
  for (const key of SECRET_KEYS) assert.equal(childEnv(extra)[key], undefined, key)
})

test('blanket secret inheritance and unknown secret names are refused', () => {
  assert.throws(() => childEnv({}, { passSecrets: true }), /allowlist/i)
  assert.throws(() => childEnv({}, { passSecrets: ['NOT_A_KNOWN_SECRET'] }), /allowlist/i)
})

test('Docker words in assertion messages do not hide product failures', () => {
  for (const error of ['Expected composed panel to be visible', 'Assertion failed at /app/docker/bootstrap-db.mjs:10', 'Expected docker status label: enabled']) {
    assert.equal(classifyFailure({ status: 'failed', errors: [error] }).kind, 'product', error)
  }
})

test('specific Docker availability errors remain infrastructure failures', () => {
  for (const error of ['Cannot connect to the Docker daemon', 'docker: command not found', 'Error response from daemon: No such container: qa-web', 'container qa-web is unhealthy']) {
    assert.equal(classifyFailure({ status: 'failed', errors: [error] }).kind, 'infrastructure', error)
  }
})
