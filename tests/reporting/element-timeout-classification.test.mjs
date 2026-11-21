import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyFailure } from '../../pipeline/lib/classify.mjs'

const joinTimeout = "TimeoutError: locator.click: Timeout 10000ms exceeded.\nCall log:\n\u001b[2m  - waiting for getByRole('main', { name: 'Home', exact: true }).getByRole('button', { name: 'Join Unity', exact: true }).or(getByRole('main', { name: 'Home', exact: true }).getByRole('button', { name: 'Join the waitlist', exact: true }))\u001b[22m\n"

test('a locator timeout names the control that never became ready', () => {
  const c = classifyFailure({ status: 'failed', errors: [joinTimeout] })
  assert.equal(c.kind, 'product')
  assert.equal(c.reason, "timed out waiting for button 'Join Unity' or button 'Join the waitlist' (not found or not enabled)")
})

test('assertion failures keep the generic reason', () => {
  const c = classifyFailure({ status: 'failed', errors: ['expect(received).toBe(expected)'] })
  assert.deepEqual(c, { kind: 'product', reason: 'explicit assertion failed' })
})

test('a timeout caused by a connection error stays infrastructure', () => {
  const c = classifyFailure({ status: 'failed', errors: ['net::ERR_CONNECTION_REFUSED\n' + joinTimeout] })
  assert.equal(c.kind, 'infrastructure')
})
