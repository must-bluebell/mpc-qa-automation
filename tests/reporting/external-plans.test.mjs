import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

test('JMeter/Postman plans and latency reporting preserve workload and failure semantics', () => {
  const result = spawnSync('python3', ['-m', 'unittest', 'discover', '-s', 'tests/plans', '-p', 'test_*.py'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stdout + result.stderr)
})
