import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Build and serve the same isolated application without development instrumentation under load.
const root = process.env.WORKSPACE_ROOT || '/app'
const next = join(root, 'node_modules/next/dist/bin/next')
const stamp = join(root, '.next/qa-production-source')
const hash = createHash('sha256')
function fingerprint(path) {
  if (!existsSync(path)) return
  if (statSync(path).isDirectory()) {
    for (const name of readdirSync(path).sort()) fingerprint(join(path, name))
  } else {
    hash.update(path.slice(root.length))
    hash.update(readFileSync(path))
  }
}
for (const path of ['src', 'config', 'content', 'public', 'package.json', 'pnpm-lock.yaml', 'next.config.ts', 'tsconfig.json', 'instrumentation.ts', 'postcss.config.mjs']) fingerprint(join(root, path))
const buildConfig = new Set(['APP_ORIGIN', 'VERCEL_ENV', 'VERCEL_BRANCH_URL', 'GITHUB_ACTIONS'])
hash.update(JSON.stringify(Object.entries(process.env).filter(([key]) => key.startsWith('NEXT_PUBLIC_') || buildConfig.has(key)).sort(([a], [b]) => a.localeCompare(b))))
const version = hash.digest('hex')
let child
let stopping = false
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { stopping = true; child?.kill(signal) })
function run(args) {
  return new Promise(resolve => {
    child = spawn(process.execPath, [next, ...args], { cwd: root, stdio: 'inherit', env: { ...process.env, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1' } })
    child.once('error', error => { console.error(error.message); resolve(1) })
    child.once('exit', code => resolve(code ?? 1))
  })
}
let code = 0
if (!existsSync(join(root, '.next/BUILD_ID')) || !existsSync(stamp) || readFileSync(stamp, 'utf8') !== version) {
  console.log('Building isolated QA production runtime…')
  code = await run(['build'])
  if (code === 0 && !stopping) writeFileSync(stamp, version)
}
if (code === 0 && !stopping) code = await run(['start', ...process.argv.slice(2)])
process.exitCode = stopping ? 0 : code
