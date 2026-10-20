import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import dotenv from 'dotenv'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
import { ROOT } from '../lib/env.mjs'
import { childEnv, runProcess } from '../lib/proc.mjs'

const exec = promisify(execFile)

/**
 * The isolated WEB MPC stack (docker/docker-compose.yml + scenario override, own Compose project).
 * Status is read-only; up/down are explicit commands (npm run stack:up / stack:down) because the first
 * build takes 10-15 minutes and `down` deletes the disposable volumes.
 */
/** Host ports for the Compose project, so compose and the scenario suite address the same containers. */
export function stackPortEnv(env) {
  const p = env.stack?.ports ?? {}
  const out = { WEB_PORT: p.web, ANVIL_PORT: p.anvil, OPBNB_ANVIL_PORT: p.opbnbAnvil, POSTGRES_PORT: p.postgres, NEON_PROXY_PORT: p.neonProxy }
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]))
}

export function composeArgs(env, extra) {
  const cwd = resolve(ROOT, env.stack.webmpcPath)
  const ports = stackPortEnv(env)
  const overlays = []
  if (env.name === 'web-isolated' || env.stack.verificationRuntime) {
    if (!env.isolated) throw new Error('Verification diagnostics require an isolated environment')
    overlays.push('-f', resolve(ROOT, 'pipeline/config/docker-compose.verification.yml'))
  }
  if (env.stack.copiedWorkspace) {
    if (!env.isolated) throw new Error('Copied application workspaces require an isolated environment')
    overlays.push('-f', resolve(ROOT, 'pipeline/config/docker-compose.workspace.yml'))
  }
  if (env.stack.databasePool) {
    if (!env.isolated) throw new Error('QA pooling requires an isolated environment')
    // Down only parses Compose; it never connects to SQL or needs real credentials.
    const databaseUrl = extra[0] === 'down' ? 'postgres://unused:unused@postgres:5432/unused'
      : dotenv.parse(readFileSync(resolve(cwd, 'docker/.env'))).DATABASE_URL
    ports.QA_POOLED_DATABASE_URL = pooledDatabaseUrl(databaseUrl)
    // Compose gives process variables priority over its .env file. Bind the
    // exact validated URL so an ambient DATABASE_URL cannot redirect the pool.
    ports.DATABASE_URL = databaseUrl
    ports.QA_POOL_CONFIG_DIR = resolve(ROOT, 'pipeline/config')
    overlays.push('-f', resolve(ROOT, 'pipeline/config/docker-compose.pool.yml'))
  }
  return { cwd, env: ports, args: ['compose', '-f', 'docker/docker-compose.yml', '-f', 'docker/docker-compose.scenario.yml', ...overlays, '-p', env.stack.composeProject, ...extra] }
}

export function pooledDatabaseUrl(value) {
  let url
  try { url = new URL(value) } catch { throw new Error('QA pooling requires the local postgres service') }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== 'postgres' || (url.port && url.port !== '5432')) throw new Error('QA pooling requires the local postgres service')
  url.hostname = 'pgbouncer'
  url.port = '5432'
  return url.href
}

/** Measure the managed local app without development instrumentation, then restore functional mode. */
export async function withLoadRuntime(env, work, switchRuntime) {
  if (!env.stack?.copiedWorkspace) return work()
  if (!env.isolated) throw new Error('Load runtime switching requires an isolated environment')
  let measured
  try {
    await switchRuntime('production')
    measured = await work()
    return measured
  } finally {
    try { await switchRuntime('development') }
    catch (error) {
      if (!Array.isArray(measured?.tests)) throw error
      return { ...measured, errors: [...(measured.errors ?? []), `Local runtime restoration failed: ${error.message}`] }
    }
  }
}

export async function stackStatus(env) {
  if (!env.stack) return null
  try {
    const { cwd, env: ports, args } = composeArgs(env, ['ps', '--format', 'json'])
    const { stdout } = await exec('docker', args, { cwd, env: childEnv(ports), timeout: 20_000 })
    const services = stdout.trim().split('\n').filter(Boolean).flatMap(line => { const v = JSON.parse(line); return Array.isArray(v) ? v : [v] })
      .map(s => ({ service: s.Service, state: s.State, health: s.Health || null, status: s.Status }))
    return { project: env.stack.composeProject, ...evaluateStackHealth(services, env.stack), services }
  } catch (error) {
    return { project: env.stack.composeProject, healthy: false, services: [], error: /Cannot connect|daemon/i.test(String(error.stderr ?? error.message)) ? 'Docker is not running' : String(error.message).slice(0, 300) }
  }
}

export function evaluateStackHealth(services, { databasePool = false } = {}) {
  const required=['web','postgres','neon-proxy','anvil','anvil-opbnb', ...(databasePool ? ['pgbouncer'] : [])]
  const missingServices=required.filter(name=>!services.some(s=>s.service===name))
  const unhealthyServices=services.filter(s=>required.includes(s.service)&&(s.state!=='running'||(s.health&&s.health!=='healthy'))).map(s=>s.service)
  return {healthy:!missingServices.length&&!unhealthyServices.length,missingServices,unhealthyServices}
}

export async function stackUp(env, {build=true}={}) {
  const { cwd, env: ports, args } = composeArgs(env, ['up', '-d', ...(build?['--build']:['--no-build']), '--wait', '--wait-timeout', '1500'])
  return runProcess('docker', args, { cwd, env: ports, timeoutMs: 1_800_000 })
}

export async function stackDown(env, { volumes = false } = {}) {
  const cwd = resolve(ROOT, env.stack.webmpcPath)
  // No application checkout means no stack was ever started from it, so there is nothing to stop.
  if (!existsSync(resolve(cwd, 'docker/docker-compose.yml'))) {
    console.log(`No docker/docker-compose.yml in ${cwd}; nothing to stop.`)
    return { code: 0 }
  }
  const { env: ports, args } = composeArgs(env, ['down', '--remove-orphans', ...(volumes ? ['--volumes'] : [])])
  return runProcess('docker', args, { cwd, env: ports, timeoutMs: 300_000 })
}
