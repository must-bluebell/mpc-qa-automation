import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { aiConfig, requestAnalysisWith } from '../../pipeline/ai/providers.mjs'
import { aiSchema, validateAiAnalysis } from '../../utils/regression-analysis.ts'
import { analyzeRun } from '../../pipeline/ai/analyze.mjs'

function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]))
  Object.assign(process.env, values)
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}

test.beforeEach(async t => {
  const dir = await mkdtemp(join(tmpdir(), 'qa-codex-login-test-'))
  environment(t, { CODEX_HOME: dir })
  t.after(() => rm(dir, { recursive: true, force: true }))
})

async function fixture(t, body) {
  const dir = await mkdtemp(join(tmpdir(), 'qa-codex-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const command = join(dir, 'codex')
  const capture = join(dir, 'capture.json')
  await writeFile(command, `#!${process.execPath}\nimport { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
const capture = ${JSON.stringify(capture)};
${body}\n`, { mode: 0o700 })
  return { command, capture }
}

test('Codex configuration selects saved login without requiring or returning API keys', () => {
  const cfg = aiConfig({ QA_AI_PROVIDER: 'codex-cli', QA_CODEX_MODEL: 'selected-model', OPENAI_API_KEY: 'unused' })
  assert.equal(cfg.provider, 'codex-cli')
  assert.equal(cfg.configured, true)
  assert.equal(cfg.model, 'selected-model')
  assert.equal(cfg.command, 'codex')
  assert.equal(cfg.key, undefined)
  assert.equal(aiConfig({ QA_AI_PROVIDER: 'codex-cli' }).configured, true)
})

test('Codex sends the brief on stdin, constrains execution, and cleans up its private files', async t => {
  const { command, capture } = await fixture(t, `
const prompt = readFileSync(0, 'utf8');
writeFileSync(capture, JSON.stringify({ args, prompt, env: process.env, cwd: process.cwd(), schema: JSON.parse(readFileSync(option('--output-schema'), 'utf8')) }));
console.log('CLI progress is not the final response');
writeFileSync(option('--output-last-message'), JSON.stringify({ summary: 'review', findings: [], duplicateGroups: [], scenarios: [] }));`)
  const cfg = aiConfig({ QA_AI_PROVIDER: 'codex-cli', QA_CODEX_BIN: command, QA_CODEX_MODEL: 'selected-model' })
  environment(t, { OPENAI_API_KEY: 'unused-openai-test-key', CODEX_API_KEY: 'unused-codex-test-key',
    QA_SEED_PHRASE: 'private-wallet-test-phrase', SLACK_BOT_TOKEN: 'private-slack-test-token',
    OPENAI_BASE_URL: 'https://unused.invalid', NODE_OPTIONS: '--trace-warnings' })
  const input = { run: { id: 'r1' }, findings: [] }
  const raw = await requestAnalysisWith(cfg, { input, schema: aiSchema })
  assert.equal(raw.summary, 'review')
  assert.equal(validateAiAnalysis(raw, { findings: [], decisionBasis: 'assertions' }, []).modelOutputValidated, true)
  const seen = JSON.parse(await readFile(capture, 'utf8'))
  assert.equal(seen.args[0], 'exec')
  assert.equal(seen.args.at(-1), '-')
  assert.equal(seen.args[seen.args.indexOf('--model') + 1], 'selected-model')
  for (const flag of ['--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check']) assert.ok(seen.args.includes(flag), flag)
  assert.equal(seen.args[seen.args.indexOf('--sandbox') + 1], 'read-only')
  for (const config of ['forced_login_method="chatgpt"', 'features.shell_tool=false', 'web_search="disabled"', 'approval_policy="never"',
    'features.skip_host_skill_discovery=true', 'features.plugins=false', 'features.hooks=false', 'project_doc_max_bytes=0']) assert.ok(seen.args.includes(config), config)
  assert.match(seen.prompt, /untrusted data/)
  assert.ok(seen.prompt.includes(JSON.stringify(input)))
  assert.ok(!seen.args.join(' ').includes('r1'))
  assert.deepEqual(seen.schema, aiSchema)
  assert.equal(seen.env.HOME, process.env.HOME)
  assert.equal(seen.env.CODEX_HOME, process.env.CODEX_HOME)
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY', 'QA_SEED_PHRASE', 'SLACK_BOT_TOKEN', 'WEBAPP_READ_TOKEN', 'NODE_OPTIONS', 'OPENAI_BASE_URL']) assert.equal(seen.env[key], undefined, key)
  await assert.rejects(access(seen.cwd), { code: 'ENOENT' })
})

test('Codex uses its default model when no override is configured', async t => {
  const { command } = await fixture(t, `
if (args.includes('--model')) process.exit(2);
writeFileSync(option('--output-last-message'), '{"summary":"default"}');`)
  const result = await requestAnalysisWith(aiConfig({ QA_AI_PROVIDER: 'codex-cli', QA_CODEX_BIN: command }), { input: {}, schema: {} })
  assert.equal(result.summary, 'default')
})

test('Codex rejects failures without exposing CLI diagnostics or accepting partial output', async t => {
  const { command } = await fixture(t, `
writeFileSync(option('--output-last-message'), '{"summary":"partial"}');
console.error('private diagnostic sk-do-not-leak');
process.exit(1);`)
  await assert.rejects(requestAnalysisWith({ provider: 'codex-cli', configured: true, command }, { input: {}, schema: {} }), error => {
    assert.match(error.message, /Codex.*failed/)
    assert.ok(!error.message.includes('sk-do-not-leak'))
    return true
  })
})

test('Codex rejects missing binaries, missing output, and invalid JSON', async t => {
  await assert.rejects(requestAnalysisWith({ provider: 'codex-cli', configured: true, command: '/missing/qa-codex' }, { input: {}, schema: {} }), /Codex/)
  for (const body of ['', "writeFileSync(option('--output-last-message'), 'not JSON');", "writeFileSync(option('--output-last-message'), '');"]) {
    const { command } = await fixture(t, body)
    await assert.rejects(requestAnalysisWith({ provider: 'codex-cli', configured: true, command }, { input: {}, schema: {} }), /Codex.*(output|JSON)/)
  }
})

test('Codex times out, kills its process, and removes temporary files', async t => {
  const { command, capture } = await fixture(t, `
writeFileSync(capture, JSON.stringify({ cwd: process.cwd(), pid: process.pid }));
setInterval(() => {}, 1000);`)
  await assert.rejects(requestAnalysisWith({ provider: 'codex-cli', configured: true, command, timeoutMs: 3000 }, { input: {}, schema: {} }), /Codex.*timed out/)
  const seen = JSON.parse(await readFile(capture, 'utf8'))
  assert.throws(() => process.kill(seen.pid, 0), { code: 'ESRCH' })
  await assert.rejects(access(seen.cwd), { code: 'ENOENT' })
})

test('Codex rejects oversized final output', async t => {
  const { command } = await fixture(t, `writeFileSync(option('--output-last-message'), 'x'.repeat(1_048_577));`)
  await assert.rejects(requestAnalysisWith({ provider: 'codex-cli', configured: true, command }, { input: {}, schema: {} }), /oversized output/)
})

test('Codex refuses global instructions before starting an analysis', async t => {
  const { command, capture } = await fixture(t, `writeFileSync(capture, 'started'); writeFileSync(option('--output-last-message'), '{}');`)
  for (const name of ['AGENTS.md', 'AGENTS.override.md']) {
    const path = join(process.env.CODEX_HOME, name)
    await writeFile(path, 'Unrelated private runner instructions')
    try {
      await assert.rejects(requestAnalysisWith({ provider: 'codex-cli', configured: true, command }, { input: {}, schema: {} }), /Codex.*global AGENTS/)
      await assert.rejects(access(capture), { code: 'ENOENT' })
    } finally { await rm(path) }
  }
})

test('pipeline validates Codex output against recorded evidence and preserves test outcomes', async t => {
  environment(t, { QA_AI_PROVIDER: 'codex-cli', QA_CODEX_BIN: '' })
  const run = { runId: 'codex-fixture', suite: 'regression', env: 'fixture', status: 'passed',
    counts: { passed: 1, failed: 0 }, versions: { app: { id: 'fixture' } }, groups: [],
    tests: [{ key: 'one', title: 'passing assertion', status: 'passed' }] }
  for (const inventedEvidence of [false, true]) {
    const raw = { summary: 'review', findings: inventedEvidence ? [{ title: 'invented', classification: 'confirmed',
      evidenceIds: ['missing'], requirementIds: [], rationale: 'invented' }] : [], duplicateGroups: [], scenarios: [] }
    const { command, capture } = await fixture(t, `writeFileSync(option('--output-last-message'), ${JSON.stringify(JSON.stringify(raw))});`)
    process.env.QA_CODEX_BIN = command
    const dir = join(capture, '..')
    const result = await analyzeRun(run, dir, [])
    assert.equal(result.status, inventedEvidence ? 'rejected' : 'ok')
    if (inventedEvidence) {
      assert.match(result.reason, /missing evidence/)
      await assert.rejects(access(join(dir, 'ai-analysis.json')), { code: 'ENOENT' })
    } else {
      const saved = JSON.parse(await readFile(join(dir, 'ai-analysis.json'), 'utf8'))
      assert.equal(saved.provider, 'codex-cli')
      assert.equal(saved.modelOutputValidated, true)
    }
    assert.equal(run.status, 'passed')
    assert.deepEqual(run.counts, { passed: 1, failed: 0 })
  }
})
