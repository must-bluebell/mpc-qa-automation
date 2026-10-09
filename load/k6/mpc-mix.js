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
  scenarios: { read: { ...shape, exec: 'read' }, auth: { ...shape, exec: 'auth' } },
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
  const notes = http.get(`${BASE}/api/notifications`, { headers: { cookie: s.cookie }, jar, tags: { name: 'GET /api/notifications' } })
  check(notes, { 'notifications 200': r => r.status === 200 })
  const nonce = http.post(`${BASE}/api/auth/nonce`, '{}', { headers: { origin: ORIGIN, 'content-type': 'application/json' }, jar: new http.CookieJar(), tags: { name: 'POST /api/auth/nonce' } })
  check(nonce, { 'nonce issued': r => r.status === 200 && !!r.json('nonce') })
  sleep(0.5)
}

export function handleSummary(data) {
  return { [__ENV.SUMMARY_FILE]: JSON.stringify(data, null, 2) }
}
