import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import * as runtime from '../../pipeline/adapters/web-runtime.mjs'

const profile = { isolated: true, allowWrites: true, stack: { verificationRuntime: true } }

test('browser warmup compiles join telemetry with an invalid body before wallet requests', async t => {
  const requests = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    requests.push({ path: req.url, method: req.method, origin: req.headers.origin, body })
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end('{"error":"bad_run_id"}')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  await runtime.warmBrowserRuntime({ ...profile, baseUrl, appOrigin: baseUrl })
  assert.deepEqual(requests, [{ path: '/api/join/event', method: 'POST', origin: baseUrl, body: '{}' }])
})

test('browser warmup refuses remote or read-only targets before making requests', async () => {
  for (const env of [
    { ...profile, baseUrl: 'https://example.com' },
    { ...profile, baseUrl: 'http://localhost:3460', allowWrites: false },
    { ...profile, baseUrl: 'http://localhost:3460', isolated: false },
  ]) {
    await assert.rejects(runtime.warmBrowserRuntime(env, { fetchImpl: () => assert.fail('must not fetch') }), /isolated loopback/)
  }
})

test('browser warmup is limited to verification runtimes and surfaces HTTP failures', async () => {
  await runtime.warmBrowserRuntime({ stack: {} }, { fetchImpl: () => assert.fail('must not fetch') })
  await assert.rejects(runtime.warmBrowserRuntime({ ...profile, baseUrl: 'http://localhost:3460' }, {
    fetchImpl: async () => new Response('{}', { status: 503 }),
  }), /503/)
})
