import test from 'node:test'
import assert from 'node:assert/strict'
import { childEnv } from '../../pipeline/lib/proc.mjs'
import { knownSecrets } from '../../pipeline/lib/env.mjs'
import { safeText } from '../../pipeline/lib/safe-output.mjs'

test('GH_TOKEN is excluded from test subprocesses and redacted from output', t => {
  const old = process.env.GH_TOKEN
  t.after(() => { if (old === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = old })
  process.env.GH_TOKEN = 'repository-access-test-credential'
  assert.equal(childEnv().GH_TOKEN, undefined)
  assert.equal(childEnv({ GH_TOKEN: process.env.GH_TOKEN }).GH_TOKEN, undefined)
  assert.ok(knownSecrets().includes(process.env.GH_TOKEN))
  assert.equal(safeText(process.env.GH_TOKEN), '[REDACTED]')
})

for (const key of ['QA_REVIEW_CALLBACK_SECRET', 'REVIEW_CALLBACK_SECRET']) {
  test(`${key} is excluded from subprocesses and redacted from summaries`, t => {
    const old = process.env[key]
    t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old })
    process.env[key] = 'callback-signing-test-credential'
    assert.equal(childEnv()[key], undefined)
    assert.equal(childEnv({ [key]: process.env[key] })[key], undefined)
    assert.equal(childEnv({}, { passSecrets: ['QA_SEED_PHRASE'] })[key], undefined)
    assert.ok(knownSecrets().includes(process.env[key]))
    assert.equal(safeText(`output ${process.env[key]}`), 'output [REDACTED]')
  })
}
