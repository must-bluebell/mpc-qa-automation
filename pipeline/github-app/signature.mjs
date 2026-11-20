import { createHmac, timingSafeEqual } from 'node:crypto'

/** GitHub signs the exact raw request body; verify before parsing or trusting any field. */
export function verifySignature(secret, rawBody, header) {
  if (typeof secret !== 'string' || secret.length < 16) return false
  if (typeof header !== 'string' || !/^sha256=[0-9a-f]{64}$/i.test(header)) return false
  const expected = createHmac('sha256', secret).update(rawBody).digest()
  return timingSafeEqual(Buffer.from(header.slice(7), 'hex'), expected)
}

export function sign(secret, rawBody) {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`
}
