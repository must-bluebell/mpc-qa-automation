import http from 'k6/http'
import { check, sleep } from 'k6'

/**
 * Controlled load mix for the isolated WEB MPC stack only (the pipeline refuses any other target).
 *  - read: anonymous landing traffic (home, quests, proposals)
 *  - auth: signed-in wallets polling session + notifications, plus fresh nonce issuance
 * Sessions are created beforehand by the pipeline with real SIWE signatures (throwaway wallets).
 */
const BASE = __ENV.BASE_URL
const ORIGIN = __ENV.APP_ORIGIN
const sessions = JSON.parse(open(__ENV.SESSIONS_FILE))
const profile = JSON.parse(__ENV.K6_PROFILE)
const endpoints = JSON.parse(__ENV.K6_ENDPOINTS)

const thresholds = {}
for (const name of endpoints) {
  thresholds[`http_req_duration{name:${name}}`] = ['p(95)<60000']
  thresholds[`http_req_failed{name:${name}}`] = ['rate<1']
  thresholds[`http_reqs{name:${name}}`] = ['count>=0']
}

const shape = profile.stages ? { executor: 'ramping-vus', startVUs: 1, stages: profile.stages.map(([duration, target]) => ({ duration, target })) }
  : { executor: 'constant-vus', vus: profile.vus, duration: profile.duration }

export const options = {
  scenarios: { read: { ...shape, exec: 'read' }, auth: { ...shape, exec: 'auth' }, boundaries: { ...shape, exec: 'boundaries' } },
  thresholds,
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  noConnectionReuse: false,
}

export function read() {
  const home = http.get(`${BASE}/api/home`, { tags: { name: 'GET /api/home' } })
  check(home, { 'home 200': r => r.status === 200 })
  const quests = http.get(`${BASE}/api/quests`, { tags: { name: 'GET /api/quests' } })
  check(quests, { 'quests 200': r => r.status === 200 })
  const votes = http.get(`${BASE}/api/vote/proposals`, { tags: { name: 'GET /api/vote/proposals' } })
  check(votes, { 'proposals 200': r => r.status === 200 })
  sleep(0.5)
}

export function auth() {
  const s = sessions[(__VU + __ITER) % sessions.length]
  const jar = new http.CookieJar()
  const session = http.get(`${BASE}/api/auth/session`, { headers: { cookie: s.cookie }, jar, tags: { name: 'GET /api/auth/session' } })
  check(session, { 'session belongs to wallet': r => r.status === 200 && (r.json('address') || '').toLowerCase() === s.address })
  check(session, { 'signed-in session cannot be cached': r => (r.headers['Cache-Control'] || '').includes('no-store') })
  const notes = http.get(`${BASE}/api/notifications`, { headers: { cookie: s.cookie }, jar, tags: { name: 'GET /api/notifications' } })
  check(notes, { 'notifications 200': r => r.status === 200 })
  const nonce = http.post(`${BASE}/api/auth/nonce`, '{}', { headers: { origin: ORIGIN, 'content-type': 'application/json' }, jar: new http.CookieJar(),
    responseCallback: http.expectedStatuses(200, 429), tags: { name: 'POST /api/auth/nonce' } })
  check(nonce, { 'nonce issued or explicitly rate limited': r => r.status === 200 ? !!r.json('nonce')
    : r.status === 429 && r.json('error') === 'rate_limited' && Number(r.headers['Retry-After']) > 0 })
  sleep(0.5)
}

/** Expected denials use separate names so they never dilute the successful-request SLOs. */
export function boundaries() {
  const jar = new http.CookieJar()
  const session = http.get(`${BASE}/api/auth/session`, { jar, tags: { name: 'anonymous session' } })
  check(session, { 'anonymous traffic never inherits a wallet': r => r.status === 200 && r.json('address') === null,
    'anonymous identity cannot be cached': r => (r.headers['Cache-Control'] || '').includes('no-store') })
  const notes = http.get(`${BASE}/api/notifications`, { jar, responseCallback: http.expectedStatuses(401), tags: { name: 'anonymous notifications denied' } })
  check(notes, { 'notifications remain private under load': r => r.status === 401 && r.json('error') === 'not_signed_in' })
  const foreign = http.post(`${BASE}/api/auth/nonce`, '{}', { jar, responseCallback: http.expectedStatuses(403),
    headers: { origin: 'https://attacker.example', 'content-type': 'application/json' }, tags: { name: 'foreign nonce denied' } })
  check(foreign, { 'foreign-origin writes remain blocked under load': r => r.status === 403 })
  sleep(0.5)
}

export function handleSummary(data) {
  return { [__ENV.SUMMARY_FILE]: JSON.stringify(data, null, 2) }
}
