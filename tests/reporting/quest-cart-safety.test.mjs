import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../../tests/wallet/quests-dig-wallet.spec.ts', import.meta.url), 'utf8')
const gate = source.match(/test\.skip\((process\.env\.QA_RUN_QUEST_DIG_CART[^,]+),/)[1]
const allowed = { QA_RUN_QUEST_DIG_CART:'1', QA_ALLOW_WRITES:'1', npm_lifecycle_event:'test:quests-dig:cart' }
test('cart writes require the dedicated command and cannot enter pipeline/read-only runs', () => {
  const skips = env => vm.runInNewContext(gate, {process:{env}})
  assert.equal(skips(allowed), false)
  for (const overrides of [{npm_lifecycle_event:'test'}, {QA_REPORT_DIR:'/tmp/report'}, {QA_ALLOW_WRITES:'0'}, {QA_RUN_QUEST_DIG_CART:'0'}]) {
    assert.equal(skips({...allowed,...overrides}), true, JSON.stringify(overrides))
  }
})

test('cart preflight reserves space for every dig and its possible magnet bonus before spending', () => {
  const capacity = source.match(/test\.skip\((initial\.available \*[^,]+),/)[1]
  const skips = available => vm.runInNewContext(capacity, {initial:{available}})
  assert.equal(skips(50), false)
  assert.equal(skips(51), true)
  assert.equal(skips(100), true)
  assert.ok(source.indexOf(capacity) < source.indexOf('await ui.dig.click()'))
  const loop = source.slice(source.indexOf('for (let index = 1;'), source.indexOf('const exhausted ='))
  assert.doesNotMatch(loop, /test\.skip/, 'once Crew is spent, unexpected blocking must fail rather than skip')
})
