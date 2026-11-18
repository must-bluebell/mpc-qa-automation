import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { expect } from '@playwright/test'

function loadModule(path, dependencies, env = {}) {
  const exports = {}
  const source = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  vm.runInNewContext(source, { exports, require: name => dependencies[name] ?? {}, process: { env }, URL, String, Number, Object })
  return exports
}

for (const helper of ['fetchNonce', 'verifySiwe']) {
  for (const [allow, environment, host] of [
    ['0', 'web-isolated', 'http://localhost:3461'],
    ['1', 'web-isolated', 'https://app.globalmpc.tech'],
    ['1', 'production', 'http://localhost:3461'],
  ]) {
    test(`${helper} blocks authentication before HTTP: ${allow}/${environment}/${host}`, async () => {
      let requests = 0
      const skip = (condition) => { if (condition) throw new Error('skipped') }
      const base = { skip, extend: () => base }
      const helpers = loadModule('../web-modules/fixtures.ts', {
        '@playwright/test': { test: base, expect },
        '../../config/target': { target: () => ({ baseUrl: host }) },
        '../../fixtures/api': {
          requireWrites: () => skip(allow !== '1'),
          call: async () => { requests++; return { status: 200, json: { nonce: 'nonce' } } },
        },
      }, { QA_ENVIRONMENT: environment })
      await assert.rejects(() => helpers[helper]({}, {}, 'message', '0x00'), /skipped/)
      assert.equal(requests, 0)
    })
  }
}

for (const response of [
  { status: 500, json: { error: 'server_error' } },
  { status: 404, json: {} },
  { status: 409, json: { error: 'client_outdated' } },
  { status: 429, json: { error: 'relayer_busy' } },
  { status: 200, json: {} },
]) {
  test(`check-in burst rejects ${response.status} ${response.json.error ?? 'no rate limit'}`, async () => {
    let calls = 0
    const helper = loadModule('../web-modules/checkin-rate-limit.ts', {
      '@playwright/test': { expect },
      '../../fixtures/api': { call: async () => ++calls <= 3
        ? { status: 200, json: { challenge: 'challenge', typedData: {} } } : response },
    })
    await assert.rejects(() => helper.expectCheckInRateLimit({}, {}))
  })
}

test('check-in burst uses the current issuance contract and requires its exact window rejection', async () => {
  let calls = 0
  const helper = loadModule('../web-modules/checkin-rate-limit.ts', {
    '@playwright/test': { expect },
    '../../fixtures/api': { call: async (_request, _info, method, path, options) => {
      assert.equal(method, 'POST')
      assert.equal(path, '/api/relay/challenge')
      assert.equal(options.body.kind, 'checkin')
      return ++calls <= 3
        ? { status: 200, json: { challenge: 'challenge', typedData: {} } }
        : { status: 429, json: { error: 'rate_limited', retryAfterMs: 300_000 } }
    } },
  })
  await helper.expectCheckInRateLimit({}, {})
  assert.equal(calls, 4)
})

for (const helper of ['fetchNonce', 'verifySiwe']) {
  test(`${helper} permits an explicitly enabled isolated target`, async () => {
    let requests = 0
    const skip = condition => { if (condition) throw new Error('unexpected skip') }
    const base = { skip, extend: () => base }
    const helpers = loadModule('../web-modules/fixtures.ts', {
      '@playwright/test': { test: base, expect },
      '../../config/target': { target: () => ({ baseUrl: 'http://127.0.0.1:3461' }) },
      '../../fixtures/api': {
        requireWrites: () => {},
        call: async () => { requests++; return { status: 200, json: { nonce: 'nonce' } } },
      },
    }, { QA_ENVIRONMENT: 'web-isolated' })
    await helpers[helper]({}, {}, 'message', '0x00')
    assert.equal(requests, 1)
  })
}
