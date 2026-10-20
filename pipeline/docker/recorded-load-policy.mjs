export function assertRecordedDestination(value) {
  const url = new URL(value)
  const allowed = { '127.0.0.1': ['3400'], localhost: ['3400'], anvil: ['8545'], 'anvil-opbnb': ['8545'], 'neon-proxy': ['4444'] }
  if (url.protocol !== 'http:' || url.username || url.password || !allowed[url.hostname]?.includes(url.port)) {
    throw new Error('Recorded load refuses destinations outside the isolated Compose services')
  }
  return url
}

export function recordedMatches(plan, url, method, rpcMethods = []) {
  const target = url.hostname === 'anvil' ? 'bsc' : url.hostname === 'anvil-opbnb' ? 'opbnb' : 'app'
  return plan.cases.filter(row => {
    if (row.excluded || row.blocked || row.target !== target || row.method !== method) return false
    if (target !== 'app') return rpcMethods.includes('eth_call')
    const pattern = row.path.split(':id').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[1-9][0-9]*')
    return new RegExp(`^${pattern}$`).test(url.pathname)
  })
}

export async function recordedResponseOk(response, rpc, consumeBody) {
  if (rpc) {
    const entries = [await response.clone().json()].flat()
    return response.ok && entries.length > 0 && entries.every(item => item && item.jsonrpc === '2.0'
      && item.id !== undefined && !item.error && typeof item.result === 'string' && /^0x(?:[a-f\d]{2})*$/i.test(item.result))
  }
  if (consumeBody) await response.clone().arrayBuffer()
  return response.ok
}

export async function recordedAssertion(report, ids, work) {
  const first = report.samples.length
  try { return await work() }
  catch (error) {
    for (const sample of report.samples.slice(first)) if (ids.includes(sample.id)) sample.ok = false
    report.errors.push(`${ids.join(', ')}: ${recordedError(error)}; request or response assertions failed.`)
  }
}

export function recordedError(error) {
  // Keep the HTTP contract and runner location, never the response body, signature or cookie.
  const http = String(error.message ?? '').match(/^([A-Z]+) (\/[^\s?:]+)(?:\?[^\s]*)?: expected ([\d,]+), got (\d+)/)
  const location = String(error.stack ?? '').match(/recorded-load\.mjs:\d+:\d+/)?.[0]
  return [error.name || 'Error', http ? `${http[1]} ${http[2]} expected ${http[3]}, got ${http[4]}` : null, location].filter(Boolean).join(' · ')
}
