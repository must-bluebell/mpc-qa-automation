import { config, HOSTED } from './env.mjs'

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
