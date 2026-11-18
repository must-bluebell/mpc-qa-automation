import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { cartPreflight } from '../../fixtures/cart-preflight.ts'

const source = readFileSync(new URL('../../tests/wallet/quests-dig-wallet.spec.ts', import.meta.url), 'utf8')
const gate = source.match(/test\.skip\((process\.env\.QA_RUN_QUEST_DIG_CART[^,]+),/)[1]
const allowed = { QA_RUN_QUEST_DIG_CART:'1', QA_ALLOW_WRITES:'1', QA_AUTHORIZE_PRODUCTION_QUEST_DIG_CART:'1', npm_lifecycle_event:'test:quests-dig:cart' }
test('cart writes require the dedicated command and cannot enter pipeline/read-only runs', () => {
  const skips = env => vm.runInNewContext(gate, {process:{env}})
  assert.equal(skips(allowed), false)
  for (const overrides of [{QA_AUTHORIZE_PRODUCTION_QUEST_DIG_CART:undefined}, {QA_AUTHORIZE_PRODUCTION_QUEST_DIG_CART:'0'}, {npm_lifecycle_event:'test'}, {QA_REPORT_DIR:'/tmp/report'}, {QA_ALLOW_WRITES:'0'}, {QA_RUN_QUEST_DIG_CART:'0'}]) {
    assert.equal(skips({...allowed,...overrides}), true, JSON.stringify(overrides))
  }
})

test('cart preflight reserves space for every dig and its possible magnet bonus before spending', () => {
  const preflight = source.slice(source.indexOf('const preflight ='), source.indexOf('test.skip(await page.getByText(validationCopy.cartRunsUsed'))
  const skips = (available, script = []) => {
    let blocked
    vm.runInNewContext(preflight, {initial:{available}, initialRun:{script}, cartPreflight, test:{skip:value=>{blocked=value}}})
    return blocked
  }
  assert.equal(skips(50), false)
  assert.equal(skips(51), true)
  assert.equal(skips(20, [{t:'settle'}, {t:'settle'}]), true)
  assert.equal(skips(20, [{t:'settle'}]), false)
  assert.ok(source.indexOf(preflight) < source.indexOf('await ui.dig.click()'))
  const loop = source.slice(source.indexOf('for (let index = 1;'), source.indexOf('const exhausted ='))
  assert.doesNotMatch(loop, /test\.skip/, 'once Crew is spent, unexpected blocking must fail rather than skip')
})
