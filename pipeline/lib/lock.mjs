import { mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync, renameSync, rmdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { RUNS_DIR } from './env.mjs'

/**
 * One lock for the whole pipeline: every suite shares the same wallet session or isolated stack, so
 * two runs at once would corrupt each other's evidence. A lock is stale when its
 * owner has exited (worker crash, kill -9); takeovers are serialized and recorded.
 * A live PID always keeps its lock, even if its event loop delays heartbeats.
 */
const LOCK_DIR = join(RUNS_DIR, '.locks')
// Container restarts can reuse PIDs while retaining lock files on the host.
const PID_NAMESPACE = (() => { try { return readlinkSync('/proc/self/ns/pid') } catch { return null } })()

/** Linux process birth time also distinguishes restarts that retain the same PID namespace. */
export function processStartTime(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19] || null
  } catch { return null }
}

export class LockBusyError extends Error {
  constructor(holder) { super(`Another pipeline run is in progress (${holder.runId}, pid ${holder.pid}, since ${holder.startedAt})`); this.holder = holder }
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' }
}

export function readLock(name = 'pipeline', { directory = LOCK_DIR } = {}) {
  try {
    const value = JSON.parse(readFileSync(join(directory, `${name}.lock`), 'utf8'))
    // Older Slack locks contain only a PID.
    const holder = typeof value === 'number' ? { pid: value, runId: 'legacy-slack', startedAt: 'unknown' } : value
    const otherNamespace = !!(PID_NAMESPACE && holder.pidNamespace && holder.pidNamespace !== PID_NAMESPACE)
    const started = processStartTime(holder.pid)
    const reusedPid = !!(holder.pidStartTime && started && holder.pidStartTime !== started)
    return { ...holder, stale: otherNamespace || reusedPid || !alive(holder.pid) }
  } catch { return null }
}

// This short-lived directory serializes stale-owner checks, replacement, heartbeat and release.
// Never automatically delete an abandoned claim: fail closed until an operator confirms no owner
// is working. A second stale-file remover could otherwise erase a newly acquired lock.
function guarded(path, work) {
  const claim = `${path}.claim`
  const deadline = Date.now() + 1000
  for (;;) {
    try { mkdirSync(claim); break }
    catch (error) {
      if (error.code !== 'EEXIST') throw error
      if (Date.now() >= deadline) throw new LockBusyError({ runId: 'lock maintenance', pid: 0, startedAt: 'unknown' })
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
    }
  }
  try { return work() } finally { rmdirSync(claim) }
}

export function acquireLock(runId, name = 'pipeline', { directory = LOCK_DIR } = {}) {
  mkdirSync(directory, { recursive: true })
  const path = join(directory, `${name}.lock`)
  const now = new Date().toISOString()
  const body = guarded(path, () => {
    const existing = readLock(name, { directory })
    if (existing && !existing.stale) throw new LockBusyError(existing)
    const holder = { runId, token: randomUUID(), pid: process.pid, pidNamespace: PID_NAMESPACE, pidStartTime: processStartTime(process.pid), startedAt: now, heartbeatAt: now,
      tookOverFrom: existing?.stale ? existing.runId : null }
    if (existing?.stale) rmSync(path)
    try { writeFileSync(path, JSON.stringify(holder), { flag: 'wx', mode: 0o600 }) }
    catch (error) {
      if (error.code === 'EEXIST') throw new LockBusyError(readLock(name, { directory }) ?? { runId: 'unreadable lock', pid: 0, startedAt: now })
      throw error
    }
    return holder
  })
  const owns = () => readLock(name, { directory })?.token === body.token
  const timer = setInterval(() => {
    try { guarded(path, () => {
      if (!owns()) return
      const tmp = `${path}.tmp-${body.token}`
      writeFileSync(tmp, JSON.stringify({ ...body, heartbeatAt: new Date().toISOString() }), { mode: 0o600 })
      renameSync(tmp, path)
    }) } catch { /* unavailable maintenance gate: fail closed, never overwrite another owner */ }
  }, 30_000)
  timer.unref()
  let released = false
  const signals = new Map()
  const release = () => {
    if (released) return
    clearInterval(timer)
    try { guarded(path, () => { if (owns()) rmSync(path) }) }
    catch { return } // Keep ownership metadata on disk when maintenance cannot be acquired.
    released = true
    for (const [signal, handler] of signals) process.off(signal, handler)
    process.off('exit', release)
  }
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const handler = () => { release(); process.exit(130) }
    signals.set(signal, handler); process.once(signal, handler)
  }
  process.once('exit', release)
  return { ...body, release }
}
