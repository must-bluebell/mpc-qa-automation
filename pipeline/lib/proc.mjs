import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { SECRET_KEYS, knownSecrets } from './env.mjs'
import { outputRedactor } from './output-redactor.mjs'

/** Child environment without our secrets unless the child really needs them (only the wallet tests do). */
export function childEnv(extra = {}, { passSecrets = false } = {}) {
  if (passSecrets !== false && (!Array.isArray(passSecrets) || passSecrets.some(key => !SECRET_KEYS.includes(key)))) {
    throw new TypeError('passSecrets must be an explicit allowlist of known secret names')
  }
  const allowed = new Set(passSecrets || [])
  const env = { ...process.env, ...extra }
  for (const key of SECRET_KEYS) if (!allowed.has(key)) delete env[key]
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
    const onData = text => {
      log?.write(text)
      if (echo) process.stdout.write(text)
      tail = (tail + text).slice(-8_000)
    }
    const stdout = outputRedactor(onData, secrets), stderr = outputRedactor(onData, secrets)
    child.stdout.on('data', chunk => stdout.write(chunk))
    child.stderr.on('data', chunk => stderr.write(chunk))
    let timedOut = false
    const kill = signal => { try { process.kill(-child.pid, signal) } catch { /* already gone */ } }
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; kill('SIGTERM'); setTimeout(() => kill('SIGKILL'), 10_000).unref() }, timeoutMs) : null
    const onParentExit = () => kill('SIGKILL')
    process.once('exit', onParentExit)
    child.on('error', error => { tail += `\n${error.message}` })
    child.on('close', (code, signal) => {
      stdout.end(); stderr.end()
      if (timer) clearTimeout(timer)
      process.off('exit', onParentExit)
      log?.end()
      resolvePromise({ code, signal, timedOut, durationMs: Date.now() - started, tail })
    })
  })
}
