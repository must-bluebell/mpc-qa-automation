import test from 'node:test'
import assert from 'node:assert/strict'
import { aiConfig, requestAnalysisWith } from '../../pipeline/ai/providers.mjs'

test('removed local provider cannot send evidence or fall back to a cloud key', async () => {
  const cfg = aiConfig({ QA_AI_PROVIDER: 'ollama', QA_AI_MODEL: 'legacy-local', QA_AI_BASE_URL: 'http://127.0.0.1:11434', OPENAI_API_KEY: 'fake', OPENAI_MODEL: 'cloud-model' })
  assert.equal(cfg.configured, false)
  assert.equal(cfg.provider, 'none')
  let called = false
  await assert.rejects(requestAnalysisWith(cfg, {
    input: { findings: [] }, schema: {}, fetchImpl: async () => { called = true },
  }), /not configured/)
  assert.equal(called, false)
})

test('removed local adapter rejects direct legacy configurations without making a request', async () => {
  let called = false
  await assert.rejects(requestAnalysisWith({ provider: 'ollama', configured: true, model: 'legacy-local', baseUrl: 'http://127.0.0.1:11434' }, {
    input: {}, schema: {}, fetchImpl: async () => { called = true; return { ok: true, json: async () => ({ done: true, message: { content: '{}' } }) } },
  }), /Unsupported AI provider/)
  assert.equal(called, false)
})

test('cloud providers require their credentials and preserve explicitly selected models', () => {
  assert.equal(aiConfig({ QA_AI_PROVIDER: 'openai', OPENAI_MODEL: 'model' }).configured, false)
  assert.equal(aiConfig({ QA_AI_PROVIDER: 'openai', OPENAI_API_KEY: 'fake' }).configured, false)
  assert.deepEqual(aiConfig({ QA_AI_PROVIDER: 'openai', OPENAI_API_KEY: 'fake', OPENAI_MODEL: 'model' }), { provider: 'openai', configured: true, key: 'fake', model: 'model' })
  assert.equal(aiConfig({ QA_AI_PROVIDER: 'anthropic' }).configured, false)
  assert.deepEqual(aiConfig({ QA_AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'fake', ANTHROPIC_MODEL: 'selected-model' }), { provider: 'anthropic', configured: true, key: 'fake', model: 'selected-model' })
})

test('disabled and unknown providers never select an available cloud credential', () => {
  for (const provider of ['none', 'typo']) {
    assert.deepEqual(aiConfig({ QA_AI_PROVIDER: provider, OPENAI_API_KEY: 'fake', OPENAI_MODEL: 'model', ANTHROPIC_API_KEY: 'fake' }), { provider: 'none', configured: false })
  }
  assert.deepEqual(aiConfig({}), { provider: 'none', configured: false })
})

const openclawEnv = { QA_AI_PROVIDER: 'openclaw', QA_OPENCLAW_TOKEN: 'gateway-test-token' }
const openclawResponse = text => ({ ok: true, json: async () => ({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] }) })

test('OpenClaw needs its gateway token and a valid review agent, never a cloud key', () => {
  assert.equal(aiConfig({ QA_AI_PROVIDER: 'openclaw', OPENAI_API_KEY: 'cloud-key', OPENAI_MODEL: 'cloud-model' }).configured, false)
  assert.equal(aiConfig({ ...openclawEnv, QA_OPENCLAW_AGENT: 'Bad Agent!' }).configured, false)
  const cfg = aiConfig(openclawEnv)
  assert.equal(cfg.configured, true)
  assert.equal(cfg.agent, 'qa-review')
  assert.equal(cfg.model, 'openclaw/qa-review')
  assert.equal(cfg.baseUrl, 'http://127.0.0.1:18789')
})

test('OpenClaw reviews are stateless, tool-less and send only the redacted brief', async () => {
  const out = await requestAnalysisWith(aiConfig(openclawEnv), {
    input: { run: { id: 'r1' } }, schema: { type: 'object' },
    fetchImpl: async (url, options) => {
      assert.equal(url, 'http://127.0.0.1:18789/v1/responses')
      assert.equal(options.headers.Authorization, 'Bearer gateway-test-token')
      assert.equal(options.redirect, 'error')
      const body = JSON.parse(options.body)
      assert.equal(body.model, 'openclaw/qa-review')
      assert.equal(body.tool_choice, 'none')
      assert.deepEqual(body.tools, [])
      assert.equal(body.store, false)
      assert.equal(body.previous_response_id, undefined)
      assert.match(body.instructions, /untrusted data/)
      assert.match(body.instructions, /"type":"object"/)
      assert.deepEqual(JSON.parse(body.input), { run: { id: 'r1' } })
      return openclawResponse('{"summary":"review"}')
    },
  })
  assert.deepEqual(out, { summary: 'review' })
})

test('OpenClaw refuses non-loopback gateways before sending any evidence', async () => {
  for (const baseUrl of ['https://gateway.example.com', 'http://192.168.1.20:18789', 'http://user:pw@127.0.0.1:18789', 'http://127.0.0.1:18789/extra']) {
    let called = false
    await assert.rejects(requestAnalysisWith(aiConfig({ ...openclawEnv, QA_OPENCLAW_BASE_URL: baseUrl }), {
      input: {}, schema: {}, fetchImpl: async () => { called = true; return openclawResponse('{}') },
    }), /loopback gateway URL/, baseUrl)
    assert.equal(called, false, baseUrl)
  }
})

test('OpenClaw rejects tool calls, incomplete responses and non-JSON output', async () => {
  const run = fetchImpl => requestAnalysisWith(aiConfig(openclawEnv), { input: {}, schema: {}, fetchImpl })
  await assert.rejects(run(async () => ({ ok: true, json: async () => ({ status: 'completed', output: [{ type: 'function_call', name: 'shell' }] }) })), /attempted a tool call/)
  await assert.rejects(run(async () => ({ ok: true, json: async () => ({ status: 'in_progress', output: [] }) })), /incomplete/)
  await assert.rejects(run(async () => openclawResponse('not json')), /not valid JSON/)
  await assert.rejects(run(async () => ({ ok: false, status: 503 })), /HTTP 503/)
})
