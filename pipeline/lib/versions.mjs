import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ROOT } from './env.mjs'

function hashTree(dirs, root) {
  const h = createHash('sha1')
  const walk = dir => {
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (['node_modules', '.next', '.git', 'test-results', 'playwright-report'].includes(e.name)) continue
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else { h.update(p.slice(root.length)); h.update(readFileSync(p)) }
    }
  }
  for (const d of dirs) walk(resolve(root, d))
  return h.digest('hex').slice(0, 12)
}

function git(cwd, ...args) {
  try { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return null }
}

/** Test-suite version: commit when the QA repo has one, else a content hash of everything that defines the tests. */
export function testSuiteVersion() {
  const commit = git(ROOT, 'rev-parse', '--short', 'HEAD')
  return { id: commit ?? `content-${hashTree(['tests', 'fixtures', 'pages', 'pipeline/config', 'config', 'load'], ROOT)}`, source: commit ? 'git' : 'content-hash' }
}

/** Application version: local WEB MPC checkout (commit or source mtime fingerprint) or the remote deployment id. */
export async function appVersion(env) {
  if (process.env.QA_VERSION) return { id: process.env.QA_VERSION, source: 'QA_VERSION' }
  if (env.stack?.webmpcPath) {
    const path = resolve(ROOT, env.stack.webmpcPath)
    const commit = git(path, 'rev-parse', '--short', 'HEAD')
    if (commit) return { id: commit, source: 'webmpc-git' }
    try {
      const pkg = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'))
      // No commits in the checkout: fingerprint by package version + newest source mtime (cheap, changes on edit).
      let newest = 0
      const walk = dir => { for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) walk(p); else newest = Math.max(newest, statSync(p).mtimeMs)
      } }
      walk(join(path, 'src'))
      return { id: `${pkg.name}@${pkg.version ?? '0'}+src-${new Date(newest).toISOString().slice(0, 16)}`, source: 'webmpc-source-mtime' }
    } catch { /* fall through */ }
  }
  try {
    const res = await fetch(env.baseUrl, { method: 'HEAD', signal: AbortSignal.timeout(10_000) })
    const id = res.headers.get('x-vercel-deployment-url') || res.headers.get('x-vercel-id') || res.headers.get('etag')
    if (id) return { id, source: 'deployment-header' }
  } catch { /* unreachable; recorded by the health probe */ }
  return { id: 'unspecified', source: 'none' }
}
