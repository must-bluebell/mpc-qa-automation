import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RUNS_DIR } from '../pipeline/lib/env.mjs'

// Own atomic write: the run store's writer redacts email-shaped text, and the admin list needs the real address.
function writeAtomic(path, data) {
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
  renameSync(tmp, path)
}

/**
 * Who signed in to the dashboard with Google, newest first. It lives in the runs folder (the persistent disk
 * when hosted) and keeps only the most recent entries. Only the admin view shows it, because emails are personal.
 */
const KEEP = 100
const SHOW = 20

function fileIn(dir) { return join(dir, '.dashboard', 'signins.json') }

export function recordSignIn(email, { dir = RUNS_DIR, now = new Date() } = {}) {
  const entries = [{ email, at: now.toISOString() }, ...readSignIns({ dir })].slice(0, KEEP)
  mkdirSync(join(dir, '.dashboard'), { recursive: true, mode: 0o700 })
  writeAtomic(fileIn(dir), entries)
  return entries[0]
}

export function readSignIns({ dir = RUNS_DIR } = {}) {
  try {
    const rows = JSON.parse(readFileSync(fileIn(dir), 'utf8'))
    return Array.isArray(rows) ? rows.filter(r => typeof r?.email === 'string' && typeof r?.at === 'string') : []
  } catch { return [] }
}

export function recentSignIns({ dir = RUNS_DIR } = {}) {
  return readSignIns({ dir }).slice(0, SHOW)
}
