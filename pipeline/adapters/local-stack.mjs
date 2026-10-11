import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
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

function composeArgs(env, extra) {
  const cwd = resolve(ROOT, env.stack.webmpcPath)
  return { cwd, env: stackPortEnv(env), args: ['compose', '-f', 'docker/docker-compose.yml', '-f', 'docker/docker-compose.scenario.yml', '-p', env.stack.composeProject, ...extra] }
}

export async function stackStatus(env) {
  if (!env.stack) return null
  try {
    const { cwd, env: ports, args } = composeArgs(env, ['ps', '--format', 'json'])
    const { stdout } = await exec('docker', args, { cwd, env: childEnv(ports), timeout: 20_000 })
    const services = stdout.trim().split('\n').filter(Boolean).flatMap(line => { const v = JSON.parse(line); return Array.isArray(v) ? v : [v] })
      .map(s => ({ service: s.Service, state: s.State, health: s.Health || null, status: s.Status }))
    return { project: env.stack.composeProject, ...evaluateStackHealth(services), services }
  } catch (error) {
    return { project: env.stack.composeProject, healthy: false, services: [], error: /Cannot connect|daemon/i.test(String(error.stderr ?? error.message)) ? 'Docker is not running' : String(error.message).slice(0, 300) }
  }
}

export function evaluateStackHealth(services) {
  const required=['web','postgres','neon-proxy','anvil','anvil-opbnb']
  const missingServices=required.filter(name=>!services.some(s=>s.service===name))
  const unhealthyServices=services.filter(s=>required.includes(s.service)&&(s.state!=='running'||(s.health&&s.health!=='healthy'))).map(s=>s.service)
  return {healthy:!missingServices.length&&!unhealthyServices.length,missingServices,unhealthyServices}
}

export async function stackUp(env, {build=true}={}) {
  const { cwd, env: ports, args } = composeArgs(env, ['up', '-d', ...(build?['--build']:['--no-build']), '--wait', '--wait-timeout', '1500'])
  return runProcess('docker', args, { cwd, env: ports, timeoutMs: 1_800_000 })
}

export async function stackDown(env, { volumes = false } = {}) {
  const { cwd, env: ports, args } = composeArgs(env, ['down', '--remove-orphans', ...(volumes ? ['--volumes'] : [])])
  // No application checkout means no stack was ever started from it, so there is nothing to stop.
  if (!existsSync(resolve(cwd, 'docker/docker-compose.yml'))) {
    console.log(`No docker/docker-compose.yml in ${cwd}; nothing to stop.`)
    return { code: 0 }
  }
  return runProcess('docker', args, { cwd, env: ports, timeoutMs: 300_000 })
}
