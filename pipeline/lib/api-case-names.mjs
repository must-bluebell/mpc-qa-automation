import { readFileSync } from 'node:fs'

const catalog = JSON.parse(readFileSync(new URL('../../testplans/api/contracts.json', import.meta.url), 'utf8'))
const byId = new Map(catalog.map(c => [c.id, c]))
const names = new Map(catalog.flatMap(c => [
  'baseline contract', 'forged credentials cannot bypass authorization',
  'foreign origin is rejected', 'successful fixture contract',
].map(kind => {
  const title = `${c.id} ${c.method} ${c.route} — ${kind}`
  return [title, title]
})))
for (const title of [
  'FLOW01 — two wallet sessions remain independent after logout',
  'FLOW02 — run save is repeatable and rejected updates preserve stored state',
  'FLOW03 — nonce rotation invalidates an earlier signed message',
  'FLOW04 — registration belongs to one wallet and rejects duplicate registration',
  'FLOW05 — wallet cookies cannot be promoted to administrator cookies',
]) names.set(title, title)

/** Publish checked-in route templates, never concrete paths, query values or raw errors. */
export function apiCaseName(title = '') {
  const leaf = title.split(' > ').at(-1)
  if (names.has(leaf)) return names.get(leaf)
  const validation = leaf.match(/^(API\d{3})(-V[1-9]\d{0,2})? (?:GET|POST|PATCH|PUT|DELETE) \S+ rejects .+$/)
  const contract = validation && byId.get(validation[1])
  if (!contract) return null
  if (!validation[2] && !leaf.endsWith(' rejects invalid input after admin authentication')) return null
  return `${contract.id}${validation[2] ?? ''} ${contract.method} ${contract.route} — ${validation[2] ? 'input validation' : 'administrator input validation'}`
}
