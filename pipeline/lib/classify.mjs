import { createHash } from 'node:crypto'

/**
 * Product failure vs infrastructure failure. Infrastructure means the test could not exercise the
 * product at all (target unreachable, stack unhealthy, browser could not start, dependency outage the
 * app reports as such). Everything else that fails an explicit assertion is a product failure.
 */
const INFRA_PATTERNS = [
  [/Wallet address index must be an integer|QA_SEED_PHRASE is not set|WALLET_ADDRESS must contain a valid|Could not derive the configured wallet|recovery phrase at index .* does not derive/i, 'wallet test configuration invalid'],
  [/ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|socket hang up|net::ERR_(CONNECTION|NAME|INTERNET|ADDRESS)/i, 'target unreachable'],
  [/browserType\.launch|Executable doesn't exist|Target page, context or browser has been closed|Browser closed/i, 'browser could not start'],
  [/\b(store_unavailable|preflight_unavailable|nonce_store_unavailable|signer_failed|relayer_unfunded)\b/, 'dependency outage reported by app'],
  [/docker|compose|container .* (unhealthy|exited)|Cannot connect to the Docker daemon/i, 'docker stack unavailable'],
  [/stack health probe failed|environment unreachable/i, 'environment health probe failed'],
  [/worker process exited unexpectedly|Worker teardown timeout|SIGKILL|SIGSEGV/i, 'worker crashed'],
  [/k6: command not found|ENOENT.*k6/i, 'load tool missing'],
]

export function classifyFailure(test) {
  if (test.status !== 'failed') return null
  if (test.infra) return { kind: 'infrastructure', reason: test.infra }
  const text = (test.errors ?? []).join('\n')
  for (const [pattern, reason] of INFRA_PATTERNS) if (pattern.test(text)) return { kind: 'infrastructure', reason }
  if ((test.tags ?? []).includes('@load') || (test.tags ?? []).includes('@PERF-01')) return { kind: 'product', reason: 'performance threshold breached' }
  return { kind: 'product', reason: 'explicit assertion failed' }
}

/** Removes run-specific noise (addresses, ids, numbers, paths, timings) so the same defect hashes the same. */
export function normalizeError(message = '') {
  return message
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split('\n').map(l => l.trim()).filter(l => l && !/^at |^\d+ \||^>|^\|/.test(l)).slice(0, 6).join(' ')
    .replace(/0x[0-9a-fA-F]{6,}/g, '0x…')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/(\/[\w.@ -]+)+\.(ts|mjs|js|zip|png|json)(:\d+)*/g, '<path>')
    .replace(/\d+(\.\d+)?\s?(ms|s)\b/g, '<t>')
    .replace(/\b\d{3,}\b/g, 'N')
    .replace(/\s+/g, ' ')
    .slice(0, 400)
}

const hash = text => createHash('sha1').update(text).digest('hex').slice(0, 12)

/** signature groups duplicate failures across tests; fingerprint identifies one test's failure variant over time. */
export function signatureOf(test) { return hash(normalizeError((test.errors ?? [])[0] ?? test.status)) }
export function fingerprintOf(test) { return hash(`${test.key}|${normalizeError((test.errors ?? [])[0] ?? test.status)}`) }

export function groupFailures(tests) {
  const groups = new Map()
  for (const t of tests.filter(t => t.status === 'failed')) {
    const g = groups.get(t.signature) ?? { signature: t.signature, classification: t.classification?.kind, reason: t.classification?.reason,
      message: normalizeError((t.errors ?? [])[0] ?? '').slice(0, 240), tests: [], critical: false, requirementIds: new Set() }
    g.tests.push({ key: t.key, title: t.title, fingerprint: t.fingerprint, evidence: (t.evidence ?? []).slice(0, 3) })
    g.critical ||= (t.tags ?? []).includes('@critical') && t.classification?.kind === 'product'
    for (const r of t.requirementIds ?? []) g.requirementIds.add(r)
    groups.set(t.signature, g)
  }
  return [...groups.values()].map(g => ({ ...g, requirementIds: [...g.requirementIds], size: g.tests.length }))
    .sort((a, b) => Number(b.critical) - Number(a.critical) || b.size - a.size)
}
