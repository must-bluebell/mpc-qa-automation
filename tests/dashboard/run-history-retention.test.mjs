import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// RUNS_DIR is read from QA_RUNS_DIR when the module loads, so point it at a temp folder first.
const dir = mkdtempSync(join(tmpdir(), 'qa-retention-runs-'))
process.env.QA_RUNS_DIR = dir
test.after(() => rmSync(dir, { recursive: true, force: true }))
const store = await import('../../pipeline/lib/run-store.mjs')
const signins = await import('../../dashboard/signins.mjs')

function saveFake(runId, startedAt) {
  mkdirSync(join(dir, runId), { recursive: true })
  store.saveRun({ runId, suite: 'smoke', env: 'production', status: 'passed', startedAt, finishedAt: startedAt, counts: { passed: 1 } })
}

test('every saved run is kept; deleting one removes only that run and its index entry', () => {
  saveFake('20260101-000000-smoke-aa', '2026-01-01T00:00:00.000Z')
  saveFake('20260102-000000-smoke-bb', '2026-01-02T00:00:00.000Z')
  saveFake('20260103-000000-smoke-cc', '2026-01-03T00:00:00.000Z')
  assert.equal(store.readIndex().length, 3)

  assert.equal(store.removeRun('20260102-000000-smoke-bb'), true)
  assert.equal(existsSync(join(dir, '20260102-000000-smoke-bb')), false)
  const left = store.readIndex().map(r => r.runId)
  assert.deepEqual(left, ['20260101-000000-smoke-aa', '20260103-000000-smoke-cc'])
  assert.equal(existsSync(join(dir, '20260101-000000-smoke-aa', 'run.json')), true)
})

test('deleting an unknown or invalid run id changes nothing', () => {
  const before = store.readIndex().length
  assert.equal(store.removeRun('no-such-run'), false)
  assert.equal(store.removeRun('../etc'), false)
  assert.equal(store.readIndex().length, before)
})

test('sign-ins are recorded newest first, capped, and the list shows the most recent', () => {
  const sdir = mkdtempSync(join(tmpdir(), 'qa-signins-'))
  try {
    for (let i = 0; i < 105; i++) signins.recordSignIn(`user${i}@gmail.com`, { dir: sdir, now: new Date(Date.UTC(2026, 0, 1, 0, i)) })
    const all = signins.readSignIns({ dir: sdir })
    assert.equal(all.length, 100)
    assert.equal(all[0].email, 'user104@gmail.com')
    const recent = signins.recentSignIns({ dir: sdir })
    assert.equal(recent.length, 20)
    assert.equal(recent[0].email, 'user104@gmail.com')
    assert.equal(recent[19].email, 'user85@gmail.com')
  } finally {
    rmSync(sdir, { recursive: true, force: true })
  }
})

test('a damaged sign-in file reads as empty instead of failing', () => {
  const sdir = mkdtempSync(join(tmpdir(), 'qa-signins-bad-'))
  try {
    mkdirSync(join(sdir, '.dashboard'), { recursive: true })
    writeFileSync(join(sdir, '.dashboard', 'signins.json'), '{not json')
    assert.deepEqual(signins.recentSignIns({ dir: sdir }), [])
  } finally {
    rmSync(sdir, { recursive: true, force: true })
  }
})
