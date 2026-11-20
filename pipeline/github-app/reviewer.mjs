import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { acquireLock, LockBusyError } from '../lib/lock.mjs'
import { runProcess } from '../lib/proc.mjs'
import { resolveEnvironment } from '../lib/env.mjs'
import { stackStatus } from '../adapters/local-stack.mjs'
import { warmBrowserRuntime } from '../adapters/web-runtime.mjs'
import { summarizeResults, decideVerdict, mergeSummaries } from './report.mjs'
import { selectRuns } from './selection.mjs'

/** A failure to set up or start the run (as opposed to a failing test): reported as "could not verify". */
export class SetupError extends Error {}

/** Parent variables the test child may inherit. Service credentials (app key, webhook secret, Slack) are not on this list. */
const CHILD_ENV = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SHELL', 'USER', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'NODE_OPTIONS', 'PLAYWRIGHT_BROWSERS_PATH', 'npm_config_cache']
const TEST_WALLET = ['QA_SEED_PHRASE']
const KEEP_CHECKOUTS = 3

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** The wallet session is shared with the scheduler and dashboard, so wait for the pipeline lock instead of racing it. */
export async function withPipelineLock(runId, work, { waitMs = 30 * 60_000, pollMs = 15_000, lockDirectory } = {}) {
  const deadline = Date.now() + waitMs
  for (;;) {
    try {
      const lock = acquireLock(runId, 'pipeline', lockDirectory ? { directory: lockDirectory } : {})
      try { return await work() } finally { lock.release() }
    } catch (error) {
      if (!(error instanceof LockBusyError)) throw error
      if (Date.now() >= deadline) throw new SetupError('another QA run held the shared test wallet for too long')
      await sleep(pollMs)
    }
  }
}

/**
 * Fetches one folder of the pull request's exact commit (for a packaged browser extension) into the run directory.
 * The App token is passed to git through the environment, like the tests checkout.
 */
async function checkoutExtension({ github, run, runDir, repo, sha, path }) {
  const dir = join(runDir, 'extension')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const auth = Buffer.from(`x-access-token:${await github.contentsToken(repo)}`).toString('base64')
  const gitEnv = { GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraheader', GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${auth}` }
  const step = async (name, args) => {
    const result = await run('git', args, { cwd: dir, env: gitEnv, onlyEnv: CHILD_ENV, timeoutMs: 5 * 60_000, echo: false, logFile: join(runDir, 'extension-checkout.log') })
    if (result.code !== 0) throw new SetupError(`fetching the pull request extension failed at "${name}"`)
  }
  await step('git init', ['init', '-q'])
  await step('git fetch', ['fetch', '-q', '--depth', '1', `https://github.com/${repo}.git`, sha])
  // A pull request without this folder makes the path checkout fail; say so instead of a generic git error.
  await step('git checkout', ['checkout', '-q', 'FETCH_HEAD', '--', path]).catch(() => { throw new SetupError(`the pull request has no ${path} folder`) })
  const extensionPath = join(dir, path)
  if (!existsSync(join(extensionPath, 'manifest.json'))) throw new SetupError(`the pull request has no ${path}/manifest.json`)
  return extensionPath
}

export function createReviewer({ github, workRoot, env = process.env, run = runProcess, lockOptions = {}, local = { resolveEnvironment, stackStatus, warmBrowserRuntime } }) {
  const checkoutDir = sha => join(workRoot, 'checkouts', sha)

  async function prepareTests(settings, log, testsDirectory = '.') {
    const { testsRepository: repository, testsRef: ref } = settings
    let sha
    try { sha = await github.resolveCommit(repository, ref) }
    catch (error) {
      throw new SetupError(`cannot read ${repository} at "${ref}" (${error.status === 404 ? 'the App is not installed on that repository, or the branch does not exist' : 'GitHub request failed'})`)
    }
    const dir = checkoutDir(sha), checkoutMarker = join(dir, '.qa-checkout')
    // Each suite directory installs its own dependencies, so it has its own marker inside the shared checkout.
    const testDir = join(dir, testsDirectory), marker = join(testDir, '.qa-ready')
    if (!existsSync(checkoutMarker)) {
      rmSync(dir, { recursive: true, force: true })
      mkdirSync(dir, { recursive: true })
      const auth = Buffer.from(`x-access-token:${await github.contentsToken(repository)}`).toString('base64')
      // The token travels only in the child's environment, never in argv, a URL or .git/config.
      const gitEnv = { GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraheader', GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${auth}` }
      const step = async (name, command, args, { cwd = dir, env = {} } = {}) => {
        const result = await run(command, args, { cwd, env, onlyEnv: CHILD_ENV, timeoutMs: 15 * 60_000, echo: false, logFile: join(workRoot, 'last-prepare.log') })
        if (result.code !== 0) throw new SetupError(`preparing the automation tests failed at "${name}"`)
      }
      await step('git init', 'git', ['init', '-q'])
      await step('git fetch', 'git', ['fetch', '-q', '--depth', '1', `https://github.com/${repository}.git`, sha], { env: gitEnv })
      await step('git checkout', 'git', ['checkout', '-q', 'FETCH_HEAD'])
      writeFileSync(checkoutMarker, new Date().toISOString())
    }
    if (!existsSync(marker)) {
      const step = async (name, command, args) => {
        const result = await run(command, args, { cwd: testDir, env: {}, onlyEnv: CHILD_ENV, timeoutMs: 15 * 60_000, echo: false, logFile: join(workRoot, 'last-prepare.log') })
        if (result.code !== 0) throw new SetupError(`preparing the automation tests failed at "${name}"`)
      }
      await step('npm ci', 'npm', ['ci', '--no-audit', '--no-fund', '--ignore-scripts'])
      await step('playwright install', 'npx', ['playwright', 'install', 'chromium'])
      writeFileSync(marker, new Date().toISOString())
      log('prepared-tests', { repository, ref, sha: sha.slice(0, 7), testsDirectory })
    }
    prune(sha)
    return { dir: testDir, tests: { repository, ref, sha, testsDirectory } }
  }

  function prune(keep) {
    try {
      const root = join(workRoot, 'checkouts')
      const old = readdirSync(root).filter(name => name !== keep).map(name => [name, statSync(join(root, name)).mtimeMs]).sort((a, b) => b[1] - a[1]).slice(KEEP_CHECKOUTS - 1)
      for (const [name] of old) rmSync(join(root, name), { recursive: true, force: true })
    } catch { /* best effort */ }
  }

  /**
   * The disposable Docker stack, described by our own environments.json (never by the PR or the checkout).
   * It is shared with the scheduler, so it is only inspected here; starting it is an operator action.
   */
  async function localTarget(name) {
    const profile = local.resolveEnvironment(name)
    if (!profile.isolated || !profile.allowWrites || !profile.stack) throw new SetupError(`environment "${name}" is not an isolated local stack, so it cannot be used for reviews`)
    const status = await local.stackStatus(profile)
    if (!status?.healthy) {
      const why = status?.error ?? [...(status?.missingServices ?? []), ...(status?.unhealthyServices ?? [])].join(', ')
      throw new SetupError(`the local test stack ${profile.stack.composeProject} is not running${why ? `: ${why}` : ''}. Start it with "npm run stack:up" on the QA server, then comment again`)
    }
    try { await local.warmBrowserRuntime(profile) } catch { throw new SetupError('the local test stack is up but its web app is not answering; check it on the QA server') }
    return {
      baseUrl: profile.baseUrl, chainId: profile.chainId, label: `local test stack · ${profile.name} · chain ${profile.chainId}`,
      env: { QA_APP_ORIGIN: profile.appOrigin, QA_CHAIN_NAME: profile.chainName ?? '', QA_ALLOW_WRITES: '1', QA_NAVIGATION: profile.navigation ?? '',
        QA_ENVIRONMENT: profile.name, QA_WEB_FIXTURE_CONTAINER: profile.stack.verificationRuntime ? `${profile.stack.composeProject}-web-1` : '' },
    }
  }

  return async function runReview({ repo, number, sha, baseUrl, localStack, chainId, settings, repoSettings, changedFiles = null, log = () => {} }) {
    if (!env.QA_SEED_PHRASE || !env.WALLET_ADDRESS) throw new SetupError('the test wallet credentials are not configured on the automation server')
    const runId = `github-${repo.replace('/', '-')}-${number}-${Date.now()}`
    const runDir = join(workRoot, 'runs', runId)
    mkdirSync(runDir, { recursive: true, mode: 0o700 })
    return withPipelineLock(runId, async () => {
      const target = localStack ? await localTarget(localStack)
        : repoSettings.extension ? { baseUrl: '', chainId, label: `packaged extension · ${repoSettings.extension.path} · ${sha.slice(0, 7)}`, env: { QA_ENVIRONMENT: 'pull-request-extension' } }
        : { baseUrl, chainId, env: { QA_ENVIRONMENT: 'pr-preview' } }
      const { dir, tests } = await prepareTests({ ...settings, testsRef: repoSettings.testsRef ?? settings.testsRef }, log, repoSettings.testsDirectory)
      const extensionPath = repoSettings.extension ? await checkoutExtension({ github, run, runDir, repo, sha, path: repoSettings.extension.path }) : null
      // Runs share one wallet, so they execute one after another within a single time budget for the whole review.
      const { runs, rules } = selectRuns(repoSettings, changedFiles)
      const deadline = Date.now() + settings.timeoutMinutes * 60_000
      const parts = [], codes = []
      let timedOut = false, durationMs = 0
      for (const [index, args] of runs.entries()) {
        const resultsFile = join(runDir, `results-${index}.json`)
        const result = await run('npx', ['playwright', 'test', ...args, '--reporter=json'], {
          cwd: dir, onlyEnv: CHILD_ENV, passSecrets: TEST_WALLET, echo: false, logFile: join(runDir, `output-${index}.log`),
          timeoutMs: Math.max(1, deadline - Date.now()),
          env: {
            PLAYWRIGHT_JSON_OUTPUT_NAME: resultsFile, CI: '1', BASE_URL: target.baseUrl, QA_CHAIN_ID: String(target.chainId),
            QA_SEED_PHRASE: env.QA_SEED_PHRASE, WALLET_ADDRESS: env.WALLET_ADDRESS, WALLET_ADDRESS_INDEX: env.WALLET_ADDRESS_INDEX || '0',
            QA_VERSION: localStack ? 'local-stack' : sha.slice(0, 12), QA_OWNER: env.QA_OWNER || '', QA_RUN_LABEL: `PR review ${repo}#${number}`,
            ...target.env,
            ...(extensionPath ? { EXTENSION_PATH: extensionPath } : {}),
          },
        })
        codes.push(result.code); durationMs += result.durationMs
        try { parts.push(summarizeResults(JSON.parse(readFileSync(resultsFile, 'utf8')), { secrets: [env.QA_SEED_PHRASE] })) } catch { parts.push(null) }
        if (result.timedOut) { timedOut = true; break }
      }
      // A run without readable results leaves the whole review unverified rather than hiding that part of the scope.
      const summary = parts.every(Boolean) ? mergeSummaries(parts) : null
      const scope = rules.length ? `changed files matched ${rules.join(', ')} · ${runs.length} test run${runs.length === 1 ? '' : 's'}` : 'no impact rule matched the changed files, so the default suite ran'
      const outcome = { ...decideVerdict({ exitCode: codes.find(code => code !== 0) ?? 0, timedOut, summary }), summary, scope, durationMs, tests, targetLabel: target.label }
      writeFileSync(join(runDir, 'summary.json'), JSON.stringify({ repo, number, sha, baseUrl: target.baseUrl, ...outcome }, null, 2), { mode: 0o600 })
      return outcome
    }, lockOptions)
  }
}
