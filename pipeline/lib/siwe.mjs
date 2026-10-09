import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { createSiweMessage } from 'viem/siwe'

/** Node-side SIWE sign-in with a throwaway wallet; returns the session cookie header for load tests. */
export async function signInFresh({ baseUrl, appOrigin, chainId }) {
  const account = privateKeyToAccount(generatePrivateKey())
  const jar = new Map()
  const send = async (path, body) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST', signal: AbortSignal.timeout(30_000),
      headers: { origin: appOrigin, 'content-type': 'application/json', cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') },
      body: JSON.stringify(body),
    })
    for (const value of res.headers.getSetCookie()) { const part = value.split(';')[0]; const at = part.indexOf('='); jar.set(part.slice(0, at), part.slice(at + 1)) }
    const text = await res.text()
    if (!res.ok) throw new Error(`${path} answered ${res.status}: ${text.slice(0, 200)}`)
    return JSON.parse(text)
  }
  const { nonce } = await send('/api/auth/nonce', {})
  const origin = new URL(appOrigin)
  const message = createSiweMessage({ address: account.address, chainId, domain: origin.host, scheme: origin.protocol.replace(':', ''),
    uri: origin.origin, version: '1', nonce, issuedAt: new Date(), expirationTime: new Date(Date.now() + 300_000) })
  await send('/api/auth/verify', { message, signature: await account.signMessage({ message }) })
  return { address: account.address.toLowerCase(), cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') }
}
