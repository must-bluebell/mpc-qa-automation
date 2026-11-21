import { config, HOSTED, isLoopback } from './env.mjs'

/**
 * Which machine may run a schedule.
 *
 * Render (hosted) runs live-site checks only: production, staging and preview. Anything that needs the
 * isolated Docker stack (local-docker, web-isolated, or a suite with requiresIsolated/requiresLoad steps)
 * belongs on the Docker runner, which is GitHub Actions. The orchestrator guard enforces the same rule at
 * run time; this check runs earlier so the scheduler records the job as refused instead of as a crash.
 *
 * Returns null when this host may run the schedule, otherwise the reason it must not.
 */
export function placementRefusal(schedule, { hosted = HOSTED, environments = config.environments(), suites = config.suites() } = {}) {
  if (!hosted) return null
  const env = environments[schedule.env]
  if (!env) return `Unknown environment "${schedule.env}".`
  if (env.isolated) return `Environment "${schedule.env}" needs the isolated Docker runner; this hosted deployment runs hosted environments only.`
  if (needsIsolatedRunner(schedule.suite, suites)) return `Suite "${schedule.suite}" needs the isolated Docker runner; this hosted deployment cannot run it.`
  return null
}

function needsIsolatedRunner(name, suites, seen = new Set()) {
  const suite = suites[name]
  if (!suite || seen.has(name)) return false
  seen.add(name)
  if (suite.requiresIsolated || suite.requiresLoad) return true
  return (suite.include ?? []).some(child => needsIsolatedRunner(child, suites, seen))
}

/** Configuration preflight only: does not claim that the target or browser runtime is healthy. */
export function scheduleReadiness(schedule, options = {}) {
  // Summary jobs read saved results; they do not launch a suite or contact its target.
  if (schedule.kind === 'summary') return { ready: true, reason: null }
  const { hosted = HOSTED, environments = config.environments(), suites = config.suites(), variables = process.env } = options
  const blocked = reason => ({ ready: false, reason })
  const refusal = placementRefusal(schedule, { hosted, environments, suites })
  if (refusal) return blocked(refusal)
  const env = environments[schedule.env]
  if (!env) return blocked(`Unknown environment "${schedule.env}".`)
  const checkSuite = (name, seen = new Set()) => {
    if (!suites[name] || seen.has(name)) return false
    return (suites[name].include ?? []).every(child => checkSuite(child, new Set([...seen, name])))
  }
  if (!checkSuite(schedule.suite)) return blocked(`Suite "${schedule.suite}" is missing or has invalid includes.`)
  const target = env.baseUrlEnv ? variables[env.baseUrlEnv] : env.baseUrl
  if (!target) return blocked(`Environment "${schedule.env}" needs ${env.baseUrlEnv || 'baseUrl'}.`)
  try {
    const url = new URL(target)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (hosted && isLoopback(target))) throw new Error('invalid')
  } catch {
    return blocked(`Environment "${schedule.env}" needs a valid ${hosted ? 'hosted ' : ''}HTTP(S) URL without credentials.`)
  }
  return { ready: true, reason: null }
}
