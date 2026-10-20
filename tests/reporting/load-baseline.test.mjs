import test from 'node:test'
import assert from 'node:assert/strict'
import { loadWorkloadId } from '../../pipeline/adapters/k6.mjs'

test('load baselines stay comparable only for the same traffic mix and profile', () => {
  const profile = { vus: 5, duration: '60s' }
  const endpoints = ['GET /api/home', 'GET /api/auth/session']
  const original = loadWorkloadId('read(); auth()', profile, endpoints, 10)
  assert.equal(loadWorkloadId('read(); auth()', { ...profile }, [...endpoints], 10), original)
  assert.notEqual(loadWorkloadId('read(); auth(); boundaries()', profile, endpoints, 10), original)
  assert.notEqual(loadWorkloadId('read(); auth()', { ...profile, vus: 10 }, endpoints, 10), original)
  assert.notEqual(loadWorkloadId('read(); auth()', profile, [...endpoints, 'GET /api/quests'], 10), original)
  assert.notEqual(loadWorkloadId('read(); auth()', profile, endpoints, 20), original)
})
