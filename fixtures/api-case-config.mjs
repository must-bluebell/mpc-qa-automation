import { readFileSync } from 'node:fs'

export function assertIsolatedTarget(baseUrl, allowWrites) {
  const url = new URL(baseUrl)
  if (allowWrites !== '1' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('Expanded API execution requires QA_ALLOW_WRITES=1 and a loopback isolated target')
  }
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
