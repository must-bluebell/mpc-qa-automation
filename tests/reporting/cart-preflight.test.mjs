import test from 'node:test'
import assert from 'node:assert/strict'
import { cartPreflight } from '../../fixtures/cart-preflight.ts'

test('an empty cart must fit every planned dig, including bonus items', () => {
  assert.equal(cartPreflight(50, []), null)
  assert.match(cartPreflight(51, []), /capacity/)
})

test('reserve one cart run before spending Crew', () => {
  assert.equal(cartPreflight(20, [{ t: 'settle' }]), null)
  assert.match(cartPreflight(20, [{ t: 'settle' }, { t: 'settle' }]), /runs/)
})

test('only a day turn resets cart runs; other records do not consume them', () => {
  assert.equal(cartPreflight(20, [
    { t: 'settle' }, { t: 'settle' }, { t: 'dayTurn' },
    { t: 'settle' }, { t: 'claimPay' }, { t: 'sendShip' },
  ]), null)
  assert.match(cartPreflight(20, [
    { t: 'settle' }, { t: 'grant' }, { t: 'settle' },
  ]), /runs/)
})

test('invalid dig allowances fail closed before spending Crew', () => {
  for (const digs of [NaN, Infinity, -1, 0, 1.5]) {
    assert.match(cartPreflight(digs, []), /allowance/)
  }
})
