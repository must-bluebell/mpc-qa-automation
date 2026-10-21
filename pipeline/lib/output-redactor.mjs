import { StringDecoder } from 'node:string_decoder'
import { knownSecrets } from './env.mjs'

/** One instance per stream: preserve UTF-8 and hold suffixes that might become a secret. */
export function outputRedactor(emit, secrets = knownSecrets()) {
  const decoder = new StringDecoder('utf8')
  const values = [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length)
  let pending = ''
  const drain = final => {
    let output = '', i = 0
    while (i < pending.length) {
      const rest = pending.slice(i)
      if (!final && values.some(s => s.length > rest.length && s.startsWith(rest))) break
      const match = values.find(s => pending.startsWith(s, i))
      if (match) { output += '[REDACTED]'; i += match.length }
      else output += pending[i++]
    }
    pending = pending.slice(i)
    if (output) emit(output)
  }
  return {
    write(chunk) { pending += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); drain(false) },
    end() { pending += decoder.end(); drain(true) },
  }
}
