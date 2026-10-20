import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

test('standalone web runner refuses an active pipeline lock before touching Docker or fixtures', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-web-lock-'))
  try {
    mkdirSync(join(dir, '.locks'))
    const now = new Date().toISOString()
    writeFileSync(join(dir, '.locks/pipeline.lock'), JSON.stringify({ runId: 'held-by-test', pid: process.pid, startedAt: now, heartbeatAt: now }))
    const sentinel = join(dir, 'docker-called')
    writeFileSync(join(dir, 'docker'), `#!/bin/sh\necho called > '${sentinel}'\nexit 99\n`, { mode: 0o700 })
    const result = spawnSync(process.execPath, ['scripts/test-web-isolated.mjs'], {
      env: { ...process.env, QA_RUNS_DIR: dir, PATH: dir }, encoding: 'utf8', timeout: 10_000,
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Another pipeline run is in progress/)
    assert.equal(existsSync(sentinel), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
