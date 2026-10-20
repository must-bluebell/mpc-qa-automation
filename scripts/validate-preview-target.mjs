import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export function validatePreviewTarget(value, chain, { hosts } = {}) {
  const allowed = Array.isArray(hosts) ? hosts : String(hosts || '').split(/[\s,]+/).filter(Boolean)
  const hostname = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.vercel\.app$/
  if (!allowed.length || allowed.some(host => typeof host !== 'string' || !hostname.test(host))) {
    throw new Error('Configure exact trusted preview hostnames in QA_PREVIEW_HOSTS; wildcards are not allowed')
  }
  let url
  try { url = new URL(value) } catch { throw new Error('Invalid preview URL') }
  if (url.protocol !== 'https:' || !allowed.includes(url.hostname) || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Target must be an explicitly allowlisted HTTPS preview, without credentials, path, query or fragment')
  }
  if (String(chain) !== '97') throw new Error('Preview wallet runs require testnet chain 97')
  return { baseUrl: url.origin, chainId: 97 }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = validatePreviewTarget(process.env.DISPATCH_BASE_URL, process.env.DISPATCH_CHAIN_ID, {
      hosts: process.env.QA_PREVIEW_HOSTS,
    })
    if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required')
    appendFileSync(process.env.GITHUB_OUTPUT, `base_url=${result.baseUrl}\nchain_id=${result.chainId}\n`)
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
