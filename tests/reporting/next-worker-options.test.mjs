import test from 'node:test'
import assert from 'node:assert/strict'
import { nextWorkerOptions } from '../../pipeline/docker/next-worker-options.mjs'

test('compiler eviction is enabled only in the Next server child without changing the launcher environment', () => {
  const env = { QA_LOCAL_LOAD: '1', APP_ORIGIN: 'http://localhost:3420' }
  const options = { env, stdio: 'inherit' }
  const worker = nextWorkerOptions('/app/node_modules/next/dist/server/lib/start-server.js', options)
  assert.equal(worker.env.SCENARIO_ON_RUNNER, '1')
  assert.equal(worker.env.QA_LOCAL_LOAD, '0')
  assert.equal(worker.env.APP_ORIGIN, env.APP_ORIGIN)
  assert.equal(worker.stdio, options.stdio)
  assert.deepEqual(env, { QA_LOCAL_LOAD: '1', APP_ORIGIN: 'http://localhost:3420' })
  assert.equal(nextWorkerOptions('/app/docker/cron.mjs', options), options)
})
