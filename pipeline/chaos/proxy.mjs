import http from 'node:http'

/**
 * Fault-injecting reverse proxy for seeded-defect validation. It sits between host-side tests and the
 * isolated app and changes responses according to one named profile, so the pipeline's detection,
 * classification, grouping and alerting can be proven without touching WEB MPC source.
 * Only ever started against the isolated loopback stack (the orchestrator enforces this).
 */
const DEAD = '0x000000000000000000000000000000000000dead'

export const PROFILES = {
  'auth-wrong-address': { kind: 'functional', requirement: 'AUTH-01', expectDetectedBy: ['A03 - SIWE sign-in creates a session'],
    description: 'Session endpoint returns another wallet after sign-in',
    response: (req, res) => req.method === 'GET' && req.url.startsWith('/api/auth/session') && res.json?.address ? { json: { ...res.json, address: DEAD } } : null },
  'auth-session-500': { kind: 'functional', requirement: 'AUTH-01', expectDetectedBy: ['A03 - SIWE sign-in creates a session'], variantOf: 'auth-wrong-address',
    description: 'Session endpoint fails with 500 for signed-in wallets (new failure variant of the same test)',
    response: (req, res) => req.method === 'GET' && req.url.startsWith('/api/auth/session') && res.json?.address ? { status: 500, json: { error: 'session_lookup_exploded' } } : null },
  'nonce-replay-accepted': { kind: 'functional', requirement: 'AUTH-02', expectDetectedBy: ['A04 - A signed SIWE message cannot be replayed'],
    description: 'Replayed SIWE verification is accepted',
    response: (req, res) => req.method === 'POST' && req.url.startsWith('/api/auth/verify') && res.status === 401 && /nonce_/.test(res.json?.error ?? '') ? { status: 200, json: { address: DEAD } } : null },
  'quests-500': { kind: 'functional', requirement: null, expectDetectedBy: ['C01 - Quests list is served'],
    description: 'Quest list endpoint returns 500',
    response: req => req.method === 'GET' && req.url.startsWith('/api/quests') ? { status: 500, json: { error: 'internal' } } : null },
  'draw-validation-off': { kind: 'functional', requirement: 'VAL-02', expectDetectedBy: ['M02 - A malformed draw request is rejected'],
    description: 'Malformed draw requests are accepted',
    response: (req, res) => req.url.startsWith('/my-mine/draw') && res.status === 400 ? { status: 200, json: { move: { t: 'mine' }, recovered: false } } : null },
  'permissions-open': { kind: 'functional', requirement: 'PERM-01', expectDetectedBy: ['P01 - Notifications require a session'],
    description: 'Notifications served without a session',
    response: (req, res) => req.url.startsWith('/api/notifications') && res.status === 401 ? { status: 200, json: [] } : null },
  'latency-2s': { kind: 'performance', requirement: 'PERF-01', expectDetectedBy: ['PERF-01 GET /api/home'],
    description: '2 s added to /api/home and /api/quests',
    delayMs: req => (/^\/api\/(home|quests)/.test(req.url) ? 2_000 : 0) },
  'error-rate-10pct': { kind: 'performance', requirement: 'PERF-01', expectDetectedBy: ['PERF-01 GET /api/home'],
    description: '10% of /api/home requests fail with 503',
    response: req => req.url.startsWith('/api/home') && Math.random() < 0.1 ? { status: 503, json: { error: 'overloaded' } } : null },
  'target-down': { kind: 'infrastructure', requirement: null, expectDetectedBy: [], description: 'Proxy refuses every request (environment unreachable)', down: true },
}

export function startChaosProxy({ target, profile, port = 0 }) {
  const spec = PROFILES[profile]
  if (!spec) throw new Error(`Unknown seeded defect "${profile}". Known: ${Object.keys(PROFILES).join(', ')}`)
  const upstream = new URL(target)
  const stats = { requests: 0, injected: 0 }
  const server = http.createServer((req, res) => {
    stats.requests++
    if (spec.down) { req.socket.destroy(); return }
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', async () => {
      const delay = spec.delayMs?.(req) ?? 0
      if (delay) { stats.injected++; await new Promise(r => setTimeout(r, delay)) }
      const body = Buffer.concat(chunks)
      const headers = { ...req.headers, host: upstream.host }
      const up = http.request({ hostname: upstream.hostname, port: upstream.port, path: req.url, method: req.method, headers }, upRes => {
        const parts = []
        upRes.on('data', c => parts.push(c))
        upRes.on('end', () => {
          const raw = Buffer.concat(parts)
          let json
          try { json = /json/.test(upRes.headers['content-type'] ?? '') ? JSON.parse(raw.toString() || 'null') : undefined } catch { json = undefined }
          const change = spec.response?.(req, { status: upRes.statusCode, json, headers: upRes.headers })
          const out = { ...upRes.headers }
          delete out['content-length']; delete out['content-encoding']; delete out['transfer-encoding']
          if (change) {
            stats.injected++
            const payload = Buffer.from(JSON.stringify(change.json ?? json ?? null))
            res.writeHead(change.status ?? upRes.statusCode, { ...out, 'content-type': 'application/json', 'content-length': payload.length, 'x-qa-seeded-defect': profile })
            res.end(payload)
          } else {
            res.writeHead(upRes.statusCode, { ...out, 'content-length': raw.length })
            res.end(raw)
          }
        })
      })
      up.on('error', () => { if (!res.headersSent) { res.writeHead(502); res.end() } })
      up.end(body)
    })
  })
  return new Promise(resolvePromise => server.listen(port, '127.0.0.1', () => {
    const { port: actual } = server.address()
    resolvePromise({ url: `http://127.0.0.1:${actual}`, profile, spec, stats, close: () => new Promise(r => { server.closeAllConnections?.(); server.close(() => r()) }) })
  }))
}
