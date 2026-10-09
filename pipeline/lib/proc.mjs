import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { SECRET_KEYS, knownSecrets } from './env.mjs'

/** Child environment without our secrets unless the child really needs them (only the wallet tests do). */
export function childEnv(extra = {}, { passSecrets = false } = {}) {
  const env = { ...process.env, ...extra }
  if (!passSecrets) for (const key of SECRET_KEYS) delete env[key]
  return env
}

/**
 * Runs a child in its own process group with a hard timeout. On timeout the whole group is killed
 * (Playwright spawns browsers and workers), so a hung run cannot leak processes or hold the lock.
 * Known secret values are redacted before anything reaches the log file, the console or the tail.
 */
export function runProcess(command, args, { cwd, env, timeoutMs, logFile, echo = true, passSecrets = false } = {}) {
  return new Promise(resolvePromise => {
    const started = Date.now()
    const secrets = knownSecrets()
    const log = logFile ? createWriteStream(logFile, { mode: 0o600 }) : null
    let tail = ''
    const child = spawn(command, args, { cwd, env: childEnv(env, { passSecrets }), detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const onData = chunk => {
      let text = chunk.toString()
      for (const s of secrets) text = text.split(s).join('[REDACTED]')
      log?.write(text)
      if (echo) process.stdout.write(text)
      tail = (tail + text).slice(-8_000)
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    let timedOut = false
    const kill = signal => { try { process.kill(-child.pid, signal) } catch { /* already gone */ } }
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; kill('SIGTERM'); setTimeout(() => kill('SIGKILL'), 10_000).unref() }, timeoutMs) : null
    const onParentExit = () => kill('SIGKILL')
    process.once('exit', onParentExit)
    child.on('error', error => { tail += `\n${error.message}` })
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer)
      process.off('exit', onParentExit)
      log?.end()
      resolvePromise({ code, signal, timedOut, durationMs: Date.now() - started, tail })
    })
  })
}
