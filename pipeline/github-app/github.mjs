import { createSign, createHash } from 'node:crypto'
import { validatePreviewUrl } from './policy.mjs'

export class GitHubError extends Error {
  constructor(method, path, status, detail) {
    super(`GitHub ${method} ${path.split('?')[0]} failed (HTTP ${status})${detail ? `: ${detail}` : ''}`)
    this.status = status
  }
}

const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url')

/**
 * Minimal GitHub App client. Every repository call uses an installation token limited to that one
 * repository; the private key only ever signs the short-lived app JWT.
 */
export function createGitHub({ appId, privateKey, apiUrl = 'https://api.github.com', fetchImpl = fetch, now = Date.now }) {
  const tokens = new Map(), installations = new Map()
  const appJwt = () => {
    const iat = Math.floor(now() / 1000) - 30
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat, exp: iat + 540, iss: String(appId) })}`
    return `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(privateKey).toString('base64url')}`
  }
  async function request(token, method, path, body) {
    const response = await fetchImpl(`${apiUrl}${path}`, {
      method, signal: AbortSignal.timeout(20_000),
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28',
        'user-agent': 'mpc-qa-automation', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
    const text = await response.text()
    let data = null
    try { data = text ? JSON.parse(text) : null } catch { /* non-JSON error page */ }
    if (!response.ok) throw new GitHubError(method, path, response.status, typeof data?.message === 'string' ? data.message.slice(0, 200) : '')
    return data
  }
  const asApp = (method, path, body) => request(appJwt(), method, path, body)
  async function installationId(repo) {
    if (!installations.has(repo.toLowerCase())) installations.set(repo.toLowerCase(), (await asApp('GET', `/repos/${repo}/installation`)).id)
    return installations.get(repo.toLowerCase())
  }
  async function token(repo, permissions) {
    const key = `${repo.toLowerCase()}|${JSON.stringify(permissions ?? null)}`
    const cached = tokens.get(key)
    if (cached && cached.expires - now() > 120_000) return cached.value
    const id = await installationId(repo)
    const created = await asApp('POST', `/app/installations/${id}/access_tokens`,
      { repositories: [repo.split('/')[1]], ...(permissions ? { permissions } : {}) })
    tokens.set(key, { value: created.token, expires: Date.parse(created.expires_at) })
    return created.token
  }
  const asRepo = async (repo, method, path, body, permissions) => request(await token(repo, permissions), method, path, body)

  return {
    asApp, token,
    pull: (repo, number) => asRepo(repo, 'GET', `/repos/${repo}/pulls/${number}`),
    react: (repo, commentId, content) => asRepo(repo, 'POST', `/repos/${repo}/issues/comments/${commentId}/reactions`, { content }),
    comment: async (repo, number, body, { key } = {}) => {
      const path = `/repos/${repo}/issues/${number}/comments`
      if (key !== undefined) {
        const marker = `<!-- mpc-qa-result:${createHash('sha256').update(key).digest('hex')} -->`
        // Reconcile an accepted POST whose response/state commit was lost before posting again.
        for (let page = 1; ; page++) {
          const batch = await asRepo(repo, 'GET', `${path}?per_page=100&page=${page}`)
          const existing = batch.find(comment => String(comment.performed_via_github_app?.id) === String(appId) && comment.body?.endsWith(marker))
          if (existing) return existing
          if (batch.length < 100) break
        }
        body += `\n\n${marker}`
      }
      return asRepo(repo, 'POST', path, { body })
    },
    /** The login's current permission on the repository: admin, maintain, write, triage, read or none. */
    permissionOf: (repo, login) => asRepo(repo, 'GET', `/repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`).then(data => data?.permission ?? 'none'),
    /** Paths changed by the pull request, or null when there are more than 300 files and the list is incomplete. */
    pullFiles: async (repo, number) => {
      const files = []
      for (let page = 1; page <= 3; page++) {
        const batch = await asRepo(repo, 'GET', `/repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`)
        files.push(...batch.map(file => file.filename))
        if (batch.length < 100) return files
      }
      return null
    },
    resolveCommit: async (repo, ref) => (await asRepo(repo, 'GET', `/repos/${repo}/commits/${encodeURIComponent(ref)}`, undefined, { contents: 'read', metadata: 'read' })).sha,
    contentsToken: repo => token(repo, { contents: 'read', metadata: 'read' }),
    deployments: (repo, sha) => asRepo(repo, 'GET', `/repos/${repo}/deployments?sha=${sha}&per_page=30`),
    deploymentStatuses: (repo, id) => asRepo(repo, 'GET', `/repos/${repo}/deployments/${id}/statuses?per_page=10`),
    /** Starts the workflow on `ref` of the tests repository. GitHub answers 204 with no body. */
    dispatchWorkflow: (repo, file, ref, inputs) => asRepo(repo, 'POST', `/repos/${repo}/actions/workflows/${file}/dispatches`, { ref, inputs }),
    listWorkflowRuns: async (repo) => {
      const runs = []
      // Avoid event filters: GitHub caps filtered searches at 1,000 results.
      for (let page = 1; ; page++) {
        const data = await asRepo(repo, 'GET', `/repos/${repo}/actions/runs?per_page=100&page=${page}`)
        if (!Array.isArray(data?.workflow_runs)) throw new Error('Workflow run lookup returned invalid data')
        runs.push(...data.workflow_runs)
        if (data.workflow_runs.length < 100) return runs
      }
    },
    createCheckRun: (repo, body) => asRepo(repo, 'POST', `/repos/${repo}/check-runs`, body),
    updateCheckRun: (repo, id, body) => asRepo(repo, 'PATCH', `/repos/${repo}/check-runs/${id}`, body),
  }
}

/**
 * The ready Vercel preview for an exact commit. Deployments must be created by the Vercel GitHub
 * integration on this repository; anything else (including a URL pasted into a comment) is ignored.
 */
export async function findPreview(github, repo, sha, { prefix, trustedCreators = ['vercel[bot]'] } = {}) {
  const deployments = await github.deployments(repo, sha)
  for (const deployment of deployments) {
    if (!/preview/i.test(deployment.environment ?? '') || !trustedCreators.includes(deployment.creator?.login) || deployment.sha !== sha) continue
    const [latest] = await github.deploymentStatuses(repo, deployment.id)
    if (latest?.state !== 'success') continue
    const origin = validatePreviewUrl(latest.environment_url, { prefix })
    if (origin) return origin
  }
  return null
}
