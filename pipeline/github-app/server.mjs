#!/usr/bin/env node
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROOT, RUNS_DIR } from '../lib/env.mjs'
import { acquireLock, readLock } from '../lib/lock.mjs'
import { createActionsClient, parseCallback } from './actions.mjs'
import { createGitHub } from './github.mjs'
import { createHandler } from './handler.mjs'
import { loadSettings } from './policy.mjs'
import { createReviewer } from './reviewer.mjs'
import { verifySignature } from './signature.mjs'
import { createState } from './state.mjs'

const MAX_BODY = 5 * 1024 * 1024
const SWEEP_MS = 60_000
/** Fixed operational log lines only: never request bodies, comment text, tokens or headers. */
const log = (event, fields = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), event, ...fields }))

export function checkConfiguration(env = process.env) {
  const problems = []
  if (!/^\d+$/.test(env.GITHUB_APP_ID ?? '')) problems.push('GITHUB_APP_ID must be the numeric App ID')
  if ((env.GITHUB_WEBHOOK_SECRET ?? '').length < 16) problems.push('GITHUB_WEBHOOK_SECRET must be at least 16 characters (the same value as the App webhook secret)')
  let privateKey
  try { privateKey = readFileSync(env.GITHUB_APP_PRIVATE_KEY_PATH ?? '', 'utf8'); if (!/BEGIN (RSA )?PRIVATE KEY/.test(privateKey)) problems.push('GITHUB_APP_PRIVATE_KEY_PATH is not a PEM private key') }
  catch { problems.push('GITHUB_APP_PRIVATE_KEY_PATH must point to the App private key file') }
  if (!env.QA_SEED_PHRASE || !env.WALLET_ADDRESS) problems.push('QA_SEED_PHRASE and WALLET_ADDRESS (test wallet login) must be set in the server .env')
  let settings
  try { settings = loadSettings({ env, root: ROOT }) } catch (error) { problems.push(error.message) }
  if (settings && ![...settings.repositories.values()].some(r => r.enabled)) problems.push('no repository is enabled in the repository policy file')
  if (settings && [...settings.repositories.values()].some(r => r.enabled && r.engine === 'actions') && (env.QA_REVIEW_CALLBACK_SECRET ?? '').length < 16) {
    problems.push('QA_REVIEW_CALLBACK_SECRET must be at least 16 characters when a repository uses engine "actions" (the same value as the GitHub secret of that name)')
  }
  if (problems.length) throw new Error(problems.map(p => `- ${p}`).join('\n'))
  return { privateKey, settings }
}

/**
 * Two POST routes: the App webhook (GitHub-signed, verified with the webhook secret) and the report from the
 * GitHub Action (signed with QA_REVIEW_CALLBACK_SECRET, which is never sent to GitHub's webhook).
 */
export function createWebhookServer({ secret, callbackSecret, handler }) {
  return createServer((request, response) => {
    const reply = (status, body) => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(body)) }
    if (request.method === 'GET' && request.url === '/healthz') return reply(200, { ok: true })
    const route = request.method !== 'POST' ? null : request.url === '/webhooks/github' ? 'webhook' : request.url === '/callbacks/review' ? 'callback' : null
    if (!route) return reply(404, { error: 'not found' })
    const chunks = []
    let size = 0, aborted = false
    request.setTimeout(15_000, () => { aborted = true; reply(408, { error: 'timeout' }); request.destroy() })
    request.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY && !aborted) { aborted = true; reply(413, { error: 'too large' }); request.destroy() } else if (!aborted) chunks.push(chunk)
    })
    request.on('end', () => {
      if (aborted) return
      const raw = Buffer.concat(chunks)
      if (route === 'callback') return reportFromAction(raw)
      if (!verifySignature(secret, raw, request.headers['x-hub-signature-256'])) { log('bad-signature'); return reply(401, { error: 'invalid signature' }) }
      let payload
      try { payload = JSON.parse(raw.toString('utf8')) } catch { return reply(400, { error: 'invalid JSON' }) }
      const event = String(request.headers['x-github-event'] ?? ''), delivery = String(request.headers['x-github-delivery'] ?? '')
      // Acknowledge quickly (GitHub times out at 10s); the review itself runs in the background queue.
      handler.handle({ event, delivery, payload }).then(result => {
        if (result.status !== 'ignored') log('delivery', { event, delivery, ...result })
        reply(result.status === 'accepted' ? 202 : 200, result)
      }, error => { log('handler-error', { event, delivery, error: error.message }); reply(500, { error: 'handler failed' }) })
    })

    function reportFromAction(raw) {
      if (!callbackSecret || !verifySignature(callbackSecret, raw, request.headers['x-qa-signature'])) { log('bad-callback-signature'); return reply(401, { error: 'invalid signature' }) }
      let report
      try { report = parseCallback(JSON.parse(raw.toString('utf8'))) } catch { log('bad-callback'); return reply(400, { error: 'invalid report' }) }
      handler.completeReview(report).then(result => {
        if (result.status !== 'ignored') log('callback', { reviewId: report.reviewId.slice(0, 8), verdict: report.verdict })
        reply(200, result)
      }, error => { log('callback-error', { error: error.message }); reply(500, { error: 'could not record the review' }) })
    }
  })
}

export async function start({ env = process.env } = {}) {
  const { privateKey, settings } = checkConfiguration(env)
  const lock = acquireLock(`github-app-${process.pid}`, 'github-app')
  const workRoot = resolve(RUNS_DIR, 'github-app')
  const github = createGitHub({ appId: env.GITHUB_APP_ID, privateKey })
  const handler = createHandler({
    settings: () => loadSettings({ env, root: ROOT }), github, log,
    actions: createActionsClient({ github }), dispatchSecret: env.QA_REVIEW_CALLBACK_SECRET,
    runReview: createReviewer({ github, workRoot, env }), state: createState(resolve(workRoot, 'state.json')),
  })
  const server = createWebhookServer({ secret: env.GITHUB_WEBHOOK_SECRET, callbackSecret: env.QA_REVIEW_CALLBACK_SECRET, handler })
  const port = Number(env.QA_GITHUB_PORT || 4600)
  await new Promise((done, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', done) })
  log('listening', { port, tests: settings.testsRepository })
  const sweeper = setInterval(() => handler.sweep(), SWEEP_MS)
  sweeper.unref()
  handler.sweep()
  const stop = async () => { clearInterval(sweeper); server.close(); await handler.idle(); lock.release() }
  return { server, handler, stop }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--check-config')) { const { settings } = checkConfiguration(); console.log(`GitHub App configuration is complete. Tests: ${settings.testsRepository} @ ${settings.testsRef}; repositories: ${[...settings.repositories.values()].filter(r => r.enabled).map(r => r.name).join(', ')}`); return }
  if (args.includes('--status')) { const lock = readLock('github-app'); console.log(JSON.stringify({ running: !!lock && !lock.stale, pid: lock && !lock.stale ? lock.pid : null }, null, 2)); return }
  const app = await start()
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => app.stop().finally(() => process.exit(0)))
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1 })
