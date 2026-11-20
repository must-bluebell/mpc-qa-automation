/** Auth admission runs before session mutation: honor its explicit 429 rejection, never retry other writes. */
export function createApiFetcher({now = Date.now, wait = ms => new Promise(resolve => setTimeout(resolve, ms))} = {}) {
  const next = new Map(), queues = new Map()
  const intervals = new Map([['/api/auth/verify',6100],['/api/auth/nonce',3100]])
  async function pace(path) {
    const pending = (queues.get(path) ?? Promise.resolve()).catch(()=>{}).then(async()=>{
      const delay = (next.get(path) ?? 0) - now()
      if (delay > 0) await wait(delay)
      next.set(path, now() + intervals.get(path))
    })
    queues.set(path,pending)
    await pending
  }
  return async function fetchApi(path, send, {production = false, onThrottle = ()=>{}} = {}) {
    const route = path.split('?')[0]
    if (!production || !intervals.has(route)) return send()
    await pace(route)
    const response = await send()
    if (response.status() !== 429) return response
    const retry = response.headers()['retry-after']
    if (!retry) return response
    const delay = /^\d+$/.test(retry) ? Number(retry)*1000 : Date.parse(retry)-now()
    if (!Number.isFinite(delay) || delay < 0 || delay > 60000) return response
    next.set(route,Math.max(next.get(route) ?? 0,now()+delay+100))
    onThrottle()
    await response.dispose?.()
    await pace(route)
    return send()
  }
}

export const fetchApi = createApiFetcher()
