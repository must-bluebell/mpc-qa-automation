#!/usr/bin/env node
/**
 * Verifies that every string vendored into `pages/copy.ts` still exists in the app's copy registry.
 *
 * ## Why this exists
 *
 * Locators in this suite find elements by accessible name, and those names come from
 * `globalmpc-webapp/lib/messages/en.ts`. Living in a separate repository, we cannot import that
 * registry — so the strings are copied, and copies drift. When they drift the tests do not report
 * "the copy changed", they report "the button is missing", which sends whoever reads the failure
 * looking in the wrong place.
 *
 * This is the seam that a single repository would not have. If drift becomes a recurring nuisance,
 * that is the argument for moving this suite inside globalmpc-webapp, where the import would be
 * direct and typed.
 *
 * Usage:  npm run check:copy  [--webapp <path>]
 * Default webapp path: ../WEB MPC when available, otherwise ../globalmpc-webapp (override with WEBAPP_PATH)
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')

const flagIndex = process.argv.indexOf('--webapp')
const webappPath = resolve(
  flagIndex !== -1 && process.argv[flagIndex + 1]
    ? process.argv[flagIndex + 1]
    : process.env.WEBAPP_PATH || (existsSync(join(repoRoot, '..', 'WEB MPC')) ? join(repoRoot, '..', 'WEB MPC') : join(repoRoot, '..', 'globalmpc-webapp')),
)

const registryPaths=[join(webappPath,'src','shared','messages','en.ts'),join(webappPath,'lib','messages','en.ts')]
const registryPath=registryPaths.find(existsSync)??registryPaths[0]

if (!existsSync(registryPath)) {
  // Not an error: CI may run without the app checked out. Say so plainly and pass.
  console.log(`[check:copy] skipped — no copy registry at ${registryPath}`)
  console.log('[check:copy] check out globalmpc-webapp alongside this repo, or set WEBAPP_PATH.')
  process.exit(0)
}

const registry = readFileSync(registryPath, 'utf8')
const vendored = readFileSync(join(repoRoot, 'pages', 'copy.ts'), 'utf8')

/**
 * Pull `key: 'value'` pairs out of the vendored file. Template functions (the switch-chain copy)
 * are deliberately not matched: they interpolate a chain name, so there is no literal to compare.
 */
const ENTRY = /^\s{2,}(\w+):\s*'((?:[^'\\]|\\.)*)',?\s*$/gm

const missing = []
let checked = 0

for (const match of vendored.matchAll(ENTRY)) {
  const [, key, raw] = match
  const value = raw.replace(/\\'/g, "'").replace(/\\\\/g, '\\')
  checked += 1
  if (!registry.includes(value)) missing.push({ key, value })
}

if (checked === 0) {
  console.error('[check:copy] parsed 0 strings out of pages/copy.ts — the parser or the file shape changed.')
  process.exit(1)
}

if (missing.length > 0) {
  console.error(`[check:copy] ${missing.length} of ${checked} strings no longer appear in the app's registry:\n`)
  for (const { key, value } of missing) {
    console.error(`  ${key}\n    vendored: ${JSON.stringify(value)}`)
  }
  console.error(`\nSource of truth: ${registryPath}`)
  console.error('Update pages/copy.ts to match, then re-run. Do not change the app to match the test.')
  process.exit(1)
}

console.log(`[check:copy] all ${checked} vendored strings still present in ${registryPath}`)
