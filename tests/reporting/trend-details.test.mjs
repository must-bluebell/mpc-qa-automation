import test from 'node:test'
import assert from 'node:assert/strict'
import { buildTrends } from '../../pipeline/lib/test-history.mjs'

test('trends retain diagnostics from the latest failure even after recovery', () => {
  const run = (runId, day, status, errors = []) => ({runId, finishedAt:`2026-11-${day}T00:00:00Z`, status,
    tests:[{key:'wallet', title:'Wallet', status, errors, classification:{kind:'infrastructure', reason:'Runner stopped'}}]})
  const row = buildTrends([
    run('recovered', '03', 'passed'), run('first', '01', 'failed', ['Old error']),
    run('latest', '02', 'failed', ['Browser timed out\npassword=private-value']),
  ]).topFailing[0]
  assert.equal(row.lastFailure.runId, 'latest')
  assert.equal(row.lastFailure.message, 'Browser timed out\n[REDACTED]')
  assert.equal(row.lastFailure.classification, 'infrastructure')
  assert.equal(row.lastFailure.reason, 'Runner stopped')
  assert.equal(row.lastStatus, 'passed')
})

test('missing diagnostics are explicit and flaky-only cases have no failure', () => {
  const rows = buildTrends([{runId:'legacy', finishedAt:'2026-11-01T00:00:00Z', status:'failed', tests:[
    {key:'missing',title:'Missing',status:'failed'}, {key:'flaky',title:'Flaky',status:'passed',flaky:true},
  ]}]).topFailing
  assert.equal(rows[0].lastFailure.message, 'No failure details recorded.')
  assert.equal(rows[1].lastFailure, undefined)
})
