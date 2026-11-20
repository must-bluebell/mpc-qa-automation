import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { exportSite } from '../../scripts/export-dashboard-site.mjs'

for (const operation of ['cpSync', 'writeFileSync', 'renameSync']) test(`export preserves the previous snapshot after ${operation} fails`, t => {
  fs.mkdirSync(join(process.cwd(), 'test-results'), { recursive: true })
  const parent = fs.mkdtempSync(join(process.cwd(), 'test-results/export-failure-'))
  const outDir = join(parent, 'site')
  fs.mkdirSync(outDir)
  fs.writeFileSync(join(outDir, '.qa-site-export'), '')
  fs.writeFileSync(join(outDir, 'index.html'), 'previous snapshot')
  const original = fs[operation]
  let failed = false
  t.mock.method(fs, operation, (...args) => {
    if (!failed && (operation !== 'renameSync' || args[1] === outDir)) {
      failed = true
      throw new Error('injected export failure')
    }
    return original(...args)
  })
  syncBuiltinESMExports()
  try {
    assert.throws(() => exportSite({ outDir, index: [] }), /injected export failure/)
    assert.equal(fs.readFileSync(join(outDir, 'index.html'), 'utf8'), 'previous snapshot')
    assert.deepEqual(fs.readdirSync(parent), ['site'])
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports()
    fs.rmSync(parent, { recursive: true, force: true })
  }
})
