import test from 'node:test'
import assert from 'node:assert/strict'
import { withLoadRuntime } from '../../pipeline/adapters/local-stack.mjs'

test('isolated load restores the local functional runtime after success or failure', async () => {
  for (const fail of [false, true]) {
    const events = []
    const result = withLoadRuntime({ isolated: true, stack: { copiedWorkspace: true } }, async () => {
      events.push('measured traffic')
      if (fail) throw new Error('load failed')
      return 'result'
    }, async mode => { events.push(mode) })
    if (fail) await assert.rejects(result, /load failed/)
    else assert.equal(await result, 'result')
    assert.deepEqual(events, ['production', 'measured traffic', 'development'])
  }
})

test('load runtime switching cannot target a shared environment', async () => {
  await assert.rejects(withLoadRuntime({ isolated: false, stack: { copiedWorkspace: true } }, () => assert.fail('must not execute'), () => assert.fail('must not switch')), /isolated/)
  assert.equal(await withLoadRuntime({ isolated: true, stack: {} }, async () => 'unchanged', () => assert.fail('unmanaged stack')), 'unchanged')
})

test('a restoration failure retains completed load assertions and metrics as an infrastructure error', async () => {
  const measured = { tests: [{ title: 'latency', status: 'passed' }], errors: [], load: { throughputRps: 10 } }
  const result = await withLoadRuntime({ isolated: true, stack: { copiedWorkspace: true } }, async () => measured, async mode => {
    if (mode === 'development') throw new Error('runtime did not become healthy')
  })
  assert.deepEqual(result.tests, measured.tests)
  assert.deepEqual(result.load, measured.load)
  assert.match(result.errors.join(' '), /restor.*runtime did not become healthy/i)
})
import { nextWorkerOptions } from '../../pipeline/docker/next-worker-options.mjs'

test('compiler eviction is enabled only in the Next server child without changing the launcher environment', () => {
  const env = { QA_LOCAL_LOAD: '1', APP_ORIGIN: 'http://localhost:3420' }
  const options = { env, stdio: 'inherit' }
  const worker = nextWorkerOptions('/app/node_modules/next/dist/server/lib/start-server.js', options)
  assert.equal(worker.env.SCENARIO_ON_RUNNER, '1')
  assert.equal(worker.env.QA_LOCAL_LOAD, '0', 'functional server caching must stay enabled for memory eviction')
  assert.equal(worker.env.APP_ORIGIN, env.APP_ORIGIN)
  assert.equal(worker.stdio, options.stdio)
  assert.deepEqual(env, { QA_LOCAL_LOAD: '1', APP_ORIGIN: 'http://localhost:3420' })
  assert.equal(nextWorkerOptions('/app/docker/cron.mjs', options), options)
})
