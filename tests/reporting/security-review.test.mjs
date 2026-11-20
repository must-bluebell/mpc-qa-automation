import test from 'node:test'
import assert from 'node:assert/strict'
import { childEnv } from '../../pipeline/lib/proc.mjs'
import { SECRET_KEYS } from '../../pipeline/lib/env.mjs'
import { classifyFailure } from '../../pipeline/lib/classify.mjs'
import { outputRedactor } from '../../pipeline/lib/output-redactor.mjs'

test('GitHub CLI credentials cannot reach workers and are redacted across output chunks', t => {
  const previous = process.env.GH_TOKEN
  t.after(() => {
    if (previous === undefined) delete process.env.GH_TOKEN
    else process.env.GH_TOKEN = previous
  })
  process.env.GH_TOKEN = 'github-credential-for-regression-test'
  assert.equal(childEnv().GH_TOKEN, undefined)
  assert.equal(childEnv({ GH_TOKEN: 'override-credential' }).GH_TOKEN, undefined)
  assert.equal(childEnv({}, { passSecrets: ['QA_SEED_PHRASE'] }).GH_TOKEN, undefined)
  let output = ''
  const redactor = outputRedactor(text => { output += text })
  redactor.write('credential=github-credential-')
  redactor.write('for-regression-test\n')
  redactor.end()
  assert.equal(output, 'credential=[REDACTED]\n')
})

test('legacy OpenClaw credentials are stripped from child environments', t => {
  const previous = process.env.QA_OPENCLAW_TOKEN
  t.after(() => {
    if (previous === undefined) delete process.env.QA_OPENCLAW_TOKEN
    else process.env.QA_OPENCLAW_TOKEN = previous
  })
  process.env.QA_OPENCLAW_TOKEN = 'legacy-openclaw-token-for-test'
  assert.equal(childEnv().QA_OPENCLAW_TOKEN, undefined)
  assert.equal(childEnv({ QA_OPENCLAW_TOKEN: 'extra-legacy-token' }).QA_OPENCLAW_TOKEN, undefined)
})

test('legacy OpenClaw credentials remain redacted from output', t => {
  const previous = process.env.QA_OPENCLAW_TOKEN
  t.after(() => {
    if (previous === undefined) delete process.env.QA_OPENCLAW_TOKEN
    else process.env.QA_OPENCLAW_TOKEN = previous
  })
  process.env.QA_OPENCLAW_TOKEN = 'legacy-openclaw-token-for-test'
  let output = ''
  const redactor = outputRedactor(text => { output += text })
  redactor.write('token=legacy-openclaw-')
  redactor.write('token-for-test\n')
  redactor.end()
  assert.equal(output, 'token=[REDACTED]\n')
})

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
