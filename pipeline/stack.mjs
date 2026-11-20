#!/usr/bin/env node
import { HOSTED, resolveEnvironment } from './lib/env.mjs'
import { stackDown, stackStatus, stackUp } from './adapters/local-stack.mjs'

// The disposable Docker stack exists only on GitHub CI runners; developer machines never start it.
if (!HOSTED && process.env.GITHUB_ACTIONS !== 'true') {
  console.error('The local Docker stack runs only in GitHub CI. Local stack commands are disabled.')
  process.exit(4)
}

// npm run stack:up | stack:down | stack:status | stack:reset (down + delete disposable volumes)
const [action = 'status'] = process.argv.slice(2)
const env = resolveEnvironment('local-docker')
if (action === 'up') process.exit((await stackUp(env,{build:!process.argv.includes('--no-build')})).code ?? 1)
else if (action === 'down') process.exit((await stackDown(env)).code ?? 1)
else if (action === 'reset') process.exit((await stackDown(env, { volumes: true })).code ?? 1)
else console.log(JSON.stringify(await stackStatus(env), null, 2))
