import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const REF = /^(?!-)[\w./-]{1,200}$/
const PREVIEW_PREFIX = /^[a-z0-9][a-z0-9-]{1,60}$/
export const ARGUMENT = /^[\w.@:=/,|()* -]{1,200}$/
// One directory level inside the tests checkout ("." is the root); no slashes, so it cannot escape the checkout.
const TESTS_DIRECTORY = /^(\.|[A-Za-z0-9_][\w .-]{0,119})$/

/** What the GitHub App must be granted for the review flow; `doctor` compares the live app to this. */
export const REQUIRED_PERMISSIONS = { metadata: 'read', contents: 'read', issues: 'read', pull_requests: 'write', deployments: 'read' }
export const REQUIRED_EVENTS = ['issue_comment', 'pull_request']
/** Extra grants needed only when a repository uses engine "actions": dispatch the workflow and report a check. */
export const ACTIONS_PERMISSIONS = { actions: 'write', checks: 'write' }
/** Pull request actions that start a review without a comment. `synchronize` is a new commit pushed to the pull request. */
export const AUTOMATIC_ACTIONS = new Set(['opened', 'reopened', 'ready_for_review', 'synchronize'])

/** GitHub computes author_association; these are organization members, owners and invited collaborators. */
export const ALLOWED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])
export const isAuthorized = association => ALLOWED_ASSOCIATIONS.has(association)
/** Live repository permission (GitHub's collaborator permission endpoint) that counts as a member for automatic reviews. */
const AUTHORIZED_PERMISSIONS = new Set(['admin', 'maintain', 'write'])
export const isAuthorizedPermission = permission => AUTHORIZED_PERMISSIONS.has(permission)

/** Only the first line counts, so quoted replies and prose that mention the command never trigger a run. */
export function parseCommand(body) {
  if (typeof body !== 'string') return false
  // Blank lines before the command are ignored (the web editor often adds one); anything else first means no command.
  const first = body.split(/\r?\n/).find(line => line.trim() !== '')
  return first !== undefined && /^[ \t]*\/automation[ \t]+review[ \t]*$/i.test(first)
}

/** Operator policy: which repositories may request reviews and which tests answer them. */
export function loadSettings({ env = process.env, root = process.cwd() } = {}) {
  const file = resolve(root, env.GITHUB_APP_REPOSITORIES_FILE || 'pipeline/config/github-app.repositories.local.json')
  let raw
  try { raw = JSON.parse(readFileSync(file, 'utf8')) }
  catch (error) { throw new Error(`Cannot read GitHub App repository policy ${file}: ${error.code || error.message}`) }
  return parseSettings(raw, env)
}

export function parseSettings(raw, env = {}) {
  const fail = message => { throw new Error(`GitHub App repository policy: ${message}`) }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('expected a JSON object')
  const testsRepository = raw.testsRepository
  // QA_GITHUB_TESTS_REF switches review branch -> main without editing the policy file.
  const testsRef = env.QA_GITHUB_TESTS_REF || raw.testsRef
  if (!REPOSITORY.test(testsRepository ?? '')) fail('testsRepository must be owner/repository')
  if (!REF.test(testsRef ?? '')) fail('testsRef must be a branch name or commit')
  const playwrightArgs = raw.playwrightArgs ?? ['--project=chromium']
  const validateArgs = (args, prefix = '') => {
    if (!Array.isArray(args) || !args.every(a => typeof a === 'string' && ARGUMENT.test(a) && !a.startsWith('--reporter') && !a.startsWith('--output'))) {
      fail(`${prefix}playwrightArgs must be plain Playwright arguments (reporters and output paths are set by the app)`)
    }
    return args
  }
  validateArgs(playwrightArgs)
  const testsDirectory = raw.testsDirectory ?? '.'
  if (!TESTS_DIRECTORY.test(testsDirectory)) fail('testsDirectory must be a single directory name in the tests checkout, or "."')
  const timeoutMinutes = raw.timeoutMinutes ?? 40
  if (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 180) fail('timeoutMinutes must be 1-180')
  // impact: [{ name, paths: [glob, ...], runs: [[playwright args], ...] }]. Changed files decide which runs execute.
  const parseImpact = (rules, prefix) => {
    if (!Array.isArray(rules)) fail(`${prefix}impact must be a list`)
    return rules.map(rule => {
      if (typeof rule?.name !== 'string' || !/^[\w -]{1,60}$/.test(rule.name)) fail(`${prefix}impact rule names are 1-60 letters, digits, spaces or dashes`)
      const paths = rule.paths
      if (!Array.isArray(paths) || !paths.length || paths.length > 50 || !paths.every(p => typeof p === 'string' && p.length <= 300 && !p.startsWith('/') && !p.includes('..'))) {
        fail(`${prefix}impact "${rule.name}": paths must be 1-50 relative glob patterns`)
      }
      if (!Array.isArray(rule.runs) || !rule.runs.length || rule.runs.length > 10) fail(`${prefix}impact "${rule.name}": runs must be 1-10 Playwright argument lists`)
      return { name: rule.name, paths, runs: rule.runs.map(args => validateArgs(args, `${prefix}impact "${rule.name}": `)) }
    })
  }
  const repositories = new Map()
  for (const [name, value] of Object.entries(raw.repositories ?? {})) {
    if (!REPOSITORY.test(name)) fail(`"${name}" is not owner/repository`)
    const entry = value ?? {}
    if (entry.previewHostPrefix !== undefined && !PREVIEW_PREFIX.test(entry.previewHostPrefix)) fail(`${name}: previewHostPrefix must be a lowercase Vercel project name prefix`)
    if (entry.chainId !== undefined && entry.chainId !== 97) fail(`${name}: pull request previews must use testnet chain 97`)
    if (entry.testsDirectory !== undefined && !TESTS_DIRECTORY.test(entry.testsDirectory)) fail(`${name}: testsDirectory must be a single directory name in the tests checkout, or "."`)
    // A repository without Vercel previews (or a demo repository) tests one fixed chain-97 deployment instead.
    let fixedBaseUrl, localStack
    if (entry.target?.type === 'local-stack') {
      // The disposable Docker stack from pipeline/config/environments.json (loopback, chain 97, writes allowed there only).
      localStack = entry.target.environment ?? 'local-docker'
      if (!/^[\w-]{1,60}$/.test(localStack)) fail(`${name}: target.environment must be an environment name from environments.json`)
    } else if (entry.target !== undefined) {
      fixedBaseUrl = validatePreviewUrl(entry.target?.baseUrl)
      if (!fixedBaseUrl) fail(`${name}: target must be {"type":"local-stack"} or {"baseUrl": HTTPS root of a *.vercel.app deployment}`)
    }
    // A packaged browser extension comes from a folder in the pull request, so it has no web deployment to test.
    let extension
    if (entry.extension !== undefined) {
      const path = entry.extension?.path
      if (typeof path !== 'string' || !/^[\w .-]+(\/[\w .-]+)*$/.test(path) || path.split('/').includes('..')) fail(`${name}: extension.path must be a folder inside the pull request`)
      if (entry.target !== undefined) fail(`${name}: extension and target cannot both be set`)
      extension = { path }
    }
    // engine "actions" runs the tests in the reusable GitHub Action on the QA runner. The runner can only reach a web deployment.
    const engine = entry.engine ?? 'local'
    if (!['local', 'actions'].includes(engine)) fail(`${name}: engine must be "local" or "actions"`)
    if (engine === 'actions') {
      if (localStack || extension) fail(`${name}: engine "actions" tests a web deployment (target.baseUrl or a Vercel preview), not a local stack or extension`)
      if ((entry.testsDirectory ?? '.') !== '.') fail(`${name}: engine "actions" runs the tests from the repository root`)
      if ((entry.impact ?? []).length) fail(`${name}: impact rules are not supported with engine "actions" yet; use playwrightArgs`)
    }
    if (entry.testsRef !== undefined && !REF.test(entry.testsRef)) fail(`${name}: testsRef must be a branch name or commit`)
    repositories.set(name.toLowerCase(), { name, enabled: entry.enabled !== false, previewHostPrefix: entry.previewHostPrefix, fixedBaseUrl, localStack, extension, engine, testsRef: entry.testsRef, chainId: 97,
      playwrightArgs: validateArgs(entry.playwrightArgs ?? playwrightArgs, `${name}: `), impact: parseImpact(entry.impact ?? [], `${name}: `),
      testsDirectory: entry.testsDirectory ?? testsDirectory })
  }
  return { testsRepository, testsRef, timeoutMinutes, repositories, playwrightArgs, testsDirectory }
}

/**
 * Accepts only the HTTPS root of a *.vercel.app deployment: no credentials, port, path, query or fragment.
 * Ownership is established by the deployment's creator (the Vercel GitHub integration) on our own repository,
 * not by the hostname alone; `prefix` additionally pins the Vercel project name when configured.
 */
export function validatePreviewUrl(value, { prefix } = {}) {
  let url
  try { url = new URL(value) } catch { return null }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) return null
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.vercel\.app$/.test(url.hostname)) return null
  if (prefix && !url.hostname.startsWith(`${prefix}-`) && url.hostname !== `${prefix}.vercel.app`) return null
  return url.origin
}
