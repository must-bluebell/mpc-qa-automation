import { readFileSync } from 'node:fs'

const hostedReads = new Map([
  ['API004', '/api/auth/session'], ['API092', '/api/home'],
  ['API138', '/api/quests'], ['API146', '/api/register/status'],
  ['API156', '/.well-known/security.txt'], ['API166', '/api/vote/proposals'],
])

/** GET alone is insufficient: cron and development GET endpoints can mutate state. */
export function isHostedReadSuccess(contract, fixture, configured = false) {
  const path = hostedReads.get(contract.id)
  return Boolean(!configured && path && contract.method === 'GET' && contract.route === path
    && fixture?.auth === 'anonymous' && fixture.path === path
    && fixture.body === undefined && fixture.headers === undefined && fixture.storageStateEnv === undefined)
}

/**
 * Reviewed GET baseline probes that may run on hosted targets. Each is anonymous, has no body, and
 * expects the app to answer before any state changes: an authentication, validation or origin
 * rejection, or a public read. Cron, development, Telegram callback and action-style GET routes
 * (claim, run, open, social-complete, checkin-reminder) are deliberately absent.
 */
const hostedReadBaselines = new Set([
  'API004', 'API009', 'API010', 'API011', 'API014', 'API016', 'API020', 'API022', 'API025', 'API029',
  'API032', 'API039', 'API041', 'API046', 'API082', 'API084', 'API086', 'API087', 'API088', 'API089',
  'API090', 'API092', 'API098', 'API100', 'API105', 'API107', 'API109', 'API114', 'API116', 'API118',
  'API128', 'API130', 'API138', 'API142', 'API146', 'API149', 'API155', 'API156', 'API160', 'API165',
  'API166', 'API170', 'API171',
])

/** A configured baseline override is isolated: the reviewed built-in probe is what runs on hosted targets. */
export function isHostedReadBaseline(contract, configured = false) {
  return Boolean(!configured && hostedReadBaselines.has(contract.id) && contract.method === 'GET'
    && contract.baseline && !contract.blocked && !/^\/(api\/cron\/|dev\/)/.test(contract.route))
}

export function assertIsolatedTarget(baseUrl, allowWrites) {
  const url = new URL(baseUrl)
  if (allowWrites !== '1' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('Expanded API execution requires QA_ALLOW_WRITES=1 and a loopback isolated target')
  }
}

/** Only the authenticated per-run production API option can authorize this exact hosted origin. */
export function assertApiWriteTarget(baseUrl, allowWrites, {productionApiWrites = false, environment} = {}) {
  const url = new URL(baseUrl)
  if (productionApiWrites) {
    if (allowWrites === '1' && productionApiWrites === true && environment === 'production'
        && url.origin === 'https://app.globalmpc.tech' && !url.username && !url.password
        && url.pathname === '/' && !url.search && !url.hash) return
    throw new Error('Production API writes require explicit authorization and the approved production origin')
  }
  assertIsolatedTarget(baseUrl, allowWrites)
}

export function validateExpected(expected) {
  if (!expected || !Number.isInteger(expected.status) || expected.status < 100 || expected.status > 599) throw new Error('An exact expected status is required')
  const assertions = ['error', 'text', 'contentType', 'location'].some(key => typeof expected[key] === 'string' && expected[key].length > 0)
    || expected.empty === true || Object.keys(expected.fields ?? {}).length > 0 || Object.keys(expected.types ?? {}).length > 0
  if (!assertions) throw new Error('At least one nonempty response body/header assertion is required')
}

export function loadApiCases(path, catalog) {
  if (!path) return {}
  const input = JSON.parse(readFileSync(path, 'utf8'))
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('API fixture file must be an object keyed by API001 … API171')
  for (const [id, fixture] of Object.entries(input)) {
    const contract = catalog.find(c => c.id === id)
    if (!contract) throw new Error(`Unknown endpoint ${id}`)
    if (!fixture || typeof fixture !== 'object') throw new Error(`Invalid fixture ${id}`)
    if (fixture.baseline) validateExpected(fixture.baseline)
    if (fixture.success) {
      const s = fixture.success
      if (!['anonymous', 'wallet', 'admin', 'cron', 'fixture'].includes(s.auth)) throw new Error(`${id}: explicit auth is required`)
      validateExpected(s.expected)
      if (s.expected.status < 200 || s.expected.status >= 400) throw new Error(`${id}: success must assert a 2xx/3xx contract`)
      if (typeof s.path !== 'string' || !s.path.startsWith('/') || s.path.startsWith('//') || s.path.includes('://') || s.path.includes('\\') || /[\u0000-\u0020]/.test(s.path) || /\{\{|\[|\]/.test(s.path)) throw new Error(`${id}: unresolved or unsafe path`)
      const actual = new URL(s.path, 'http://localhost').pathname.split('/').filter(Boolean)
      const pattern = contract.route.split('/').filter(Boolean)
      if (!pattern.some(p => p.startsWith('[...')) && actual.length !== pattern.length) throw new Error(`${id}: fixture path does not match route`)
      for (const [i, segment] of pattern.entries()) {
        if (segment.startsWith('[...')) break
        if (!segment.startsWith('[') && segment !== actual[i]) throw new Error(`${id}: fixture path does not match route`)
      }
      if (/\{\{/.test(JSON.stringify(s))) throw new Error(`${id}: resolve all fixture placeholders`)
      if (s.auth === 'fixture' && !s.storageStateEnv) throw new Error(`${id}: fixture auth needs storageStateEnv`)
    }
  }
  return input
}
