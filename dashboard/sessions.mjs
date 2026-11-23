import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RUNS_DIR } from '../pipeline/lib/env.mjs'

/**
 * "Sign out everyone" for Google sign-ins. Viewer sessions are signed cookies with no server-side record, so
 * an administrator's sign-out stores a cutoff time instead: any Google session issued at or before it is refused.
 * Sessions started after the cutoff keep working. The access-key session is not affected.
 */
const fileIn = dir => join(dir, '.dashboard', 'sessions.json')

export function signedOutBefore({ dir = RUNS_DIR } = {}) {
  try {
    const value = JSON.parse(readFileSync(fileIn(dir), 'utf8')).signedOutBefore
    return Number.isFinite(value) ? value : 0
  } catch { return 0 }
}

/** True when a Google session was issued after the most recent sign-out-everyone. Sessions without a time are refused once any cutoff exists. */
export function issuedAfterSignOut(payload, opts = {}) {
  const cutoff = signedOutBefore(opts)
  if (!cutoff) return true
  return typeof payload?.issuedAt === 'number' && payload.issuedAt > cutoff
}

export function signOutEveryone({ dir = RUNS_DIR, now = Date.now() } = {}) {
  mkdirSync(join(dir, '.dashboard'), { recursive: true, mode: 0o700 })
  const tmp = `${fileIn(dir)}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify({ signedOutBefore: now }, null, 2), { mode: 0o600 })
  renameSync(tmp, fileIn(dir))
  return now
}
