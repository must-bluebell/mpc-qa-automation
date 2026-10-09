import { mkdirSync, readFileSync, rmSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { RUNS_DIR } from './env.mjs'

/**
 * One lock for the whole pipeline: every suite shares the same wallet session or isolated stack, so
 * two runs at once would corrupt each other's evidence. A lock is stale when its PID is gone or its
 * heartbeat stopped (worker crash, kill -9); stale locks are taken over and the takeover is recorded.
 */
const LOCK_DIR = join(RUNS_DIR, '.locks')
const STALE_MS = 5 * 60_000

export class LockBusyError extends Error {
  constructor(holder) { super(`Another pipeline run is in progress (${holder.runId}, pid ${holder.pid}, since ${holder.startedAt})`); this.holder = holder }
}

function alive(pid) {
  try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' }
}

export function readLock(name = 'pipeline') {
  try {
    const holder = JSON.parse(readFileSync(join(LOCK_DIR, `${name}.lock`), 'utf8'))
    const stale = !alive(holder.pid) || Date.now() - Date.parse(holder.heartbeatAt) > STALE_MS
    return { ...holder, stale }
  } catch { return null }
}

export function acquireLock(runId, name = 'pipeline') {
  mkdirSync(LOCK_DIR, { recursive: true })
  const path = join(LOCK_DIR, `${name}.lock`)
  const existing = readLock(name)
  if (existing && !existing.stale) throw new LockBusyError(existing)
  const now = new Date().toISOString()
  const body = { runId, pid: process.pid, startedAt: now, heartbeatAt: now, tookOverFrom: existing?.stale ? existing.runId : null }
  try {
    // 'wx' makes creation atomic; a stale lock is removed first and then recreated exclusively.
    if (existing?.stale) rmSync(path, { force: true })
    writeFileSync(path, JSON.stringify(body), { flag: 'wx' })
  } catch (error) {
    if (error.code === 'EEXIST') throw new LockBusyError(readLock(name) ?? { runId: 'unknown', pid: 0, startedAt: now })
    throw error
  }
  const timer = setInterval(() => {
    try {
      const tmp = `${path}.tmp-${process.pid}`
      writeFileSync(tmp, JSON.stringify({ ...body, heartbeatAt: new Date().toISOString() }))
      renameSync(tmp, path)
    } catch { /* heartbeat is best-effort */ }
  }, 30_000)
  timer.unref()
  let released = false
  const release = () => {
    if (released) return
    released = true
    clearInterval(timer)
    try { if (JSON.parse(readFileSync(path, 'utf8')).runId === runId) rmSync(path, { force: true }) } catch { /* already gone */ }
  }
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { release(); process.exit(130) })
  process.once('exit', release)
  return { ...body, release }
}
