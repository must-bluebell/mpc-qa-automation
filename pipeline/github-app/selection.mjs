import { matchesGlob } from 'node:path'

/**
 * Chooses the Playwright runs for one pull request. Each impact rule lists path globs and the runs to execute when
 * a changed file matches. No rule matching runs the repository's default arguments. `changedFiles` of null means the
 * file list could not be read completely, so every rule applies and the default suite runs too, since a file outside
 * all rules may be the one that changed.
 */
export function selectRuns(repoSettings, changedFiles) {
  const unreadable = changedFiles === null
  const matched = repoSettings.impact.filter(rule => unreadable || changedFiles.some(file => rule.paths.some(glob => matchesGlob(file, glob))))
  if (!matched.length) return { runs: [repoSettings.playwrightArgs], rules: [] }
  const candidates = unreadable ? [repoSettings.playwrightArgs, ...matched.flatMap(rule => rule.runs)] : matched.flatMap(rule => rule.runs)
  const unique = new Map()
  for (const args of candidates) unique.set(JSON.stringify(args), args)
  return { runs: [...unique.values()], rules: matched.map(rule => rule.name) }
}
