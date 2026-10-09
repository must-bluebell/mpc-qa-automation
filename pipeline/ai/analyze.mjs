#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { aiSchema, redact, summarizeRun, validateAiAnalysis } from '../../utils/regression-analysis.ts'
import { config, knownSecrets } from '../lib/env.mjs'
import { readRun, runDir, saveRun } from '../lib/run-store.mjs'
import { aiConfig, requestAnalysisWith } from './providers.mjs'
import { redactValue } from '../lib/safe-output.mjs'

/**
 * Builds the redacted evidence brief for one pipeline run, asks the configured model, and keeps only
 * output that passes validateAiAnalysis (existing evidence IDs, approved requirement IDs, no promoted
 * "confirmed" findings). Screenshots, traces, cookies and keys never leave the machine.
 */
export function buildBrief(run, requirements) {
  const secrets = knownSecrets()
  const ids = new Map(run.tests.map((t, i) => [t.key, `T${i + 1}`]))
  const records = run.tests.map(t => ({
    id: ids.get(t.key), title: t.title,
    status: t.status === 'blocked' ? 'skipped' : t.status, outcome: t.status === 'passed' ? (t.flaky ? 'flaky' : 'expected') : t.status === 'failed' ? 'unexpected' : 'skipped',
    errors: (t.errors ?? []).map(e => redact(e, secrets).slice(0, 1_500)),
    annotations: [...(t.annotations ?? []), ...(t.status === 'blocked' ? [{ type: 'blocked', description: 'not run' }] : [])],
    evidence: (t.evidence ?? []).map(e => ({ name: e.name, path: e.path })),
  }))
  const regression = summarizeRun(records, { environment: run.env, version: run.versions.app.id, owner: process.env.QA_OWNER || 'Unconfigured', label: run.suite },
    requirements, run.status === 'passed' ? 'passed' : 'failed')
  const brief = {
    run: { id: run.runId, suite: run.suite, env: run.env, status: run.status, counts: run.counts, seededDefect: run.seededDefect },
    approvedRequirements: requirements.filter(r => r.approved).map(({ id, description, critical }) => ({ id, description, critical })),
    findings: regression.findings.map(f => ({ ...f, details: f.details.map(d => d.slice(0, 1_200)) })),
    failureGroups: run.groups.map(g => ({ classification: g.classification, reason: g.reason, message: g.message, evidenceIds: g.tests.map(t => ids.get(t.key)) })),
    comparison: run.comparison && {
      newFailures: run.comparison.newFailures.map(f => ids.get(f.key)), recurring: run.comparison.persisting.map(f => ids.get(f.key)),
      newVariants: run.comparison.newVariants.map(f => ids.get(f.key)), recovered: run.comparison.recovered.map(f => f.title) },
    tests: records.map(r => ({ id: r.id, title: r.title, status: r.status })),
    load: run.load ? { breaches: run.load.breaches, throughputRps: run.load.throughputRps } : undefined,
  }
  return { brief:redactValue(brief), regression, ids }
}

export async function analyzeRun(run, dir = runDir(run.runId), requirements = config.requirements(), { client, fetchImpl } = {}) {
  const cfg = aiConfig()
  if (!cfg.configured) return { status: 'not-configured', provider: cfg.provider, reason: 'Set QA_AI_PROVIDER and the provider key in .env to enable AI review.' }
  const { brief, regression } = buildBrief(run, requirements)
  writeFileSync(join(dir, 'ai-input.json'), JSON.stringify(brief, null, 2))
  const started = Date.now()
  try {
    const raw = await requestAnalysisWith(cfg, { input: brief, schema: aiSchema, client, fetchImpl })
    const analysis = validateAiAnalysis(raw, regression, requirements)
    const result = { status: 'ok', provider: cfg.provider, model: cfg.model, durationMs: Date.now() - started, generatedAt: new Date().toISOString(), ...analysis }
    writeFileSync(join(dir, 'ai-analysis.json'), JSON.stringify(result, null, 2))
    return { status: 'ok', provider: cfg.provider, model: cfg.model, durationMs: result.durationMs, summary: analysis.summary,
      findings: analysis.findings.length, duplicateGroups: analysis.duplicateGroups.length, scenarios: analysis.scenarios.length, file: 'ai-analysis.json' }
  } catch (error) {
    return { status: 'rejected', provider: cfg.provider, model: cfg.model, durationMs: Date.now() - started, reason: error.message.slice(0, 400) }
  }
}

// CLI: node pipeline/ai/analyze.mjs <runId>  — (re)runs AI review for a finished run.
if (process.argv[1]?.endsWith('analyze.mjs')) {
  const run = readRun(process.argv[2])
  if (!run) { console.error('Usage: node pipeline/ai/analyze.mjs <runId>'); process.exit(1) }
  run.ai = await analyzeRun(run)
  saveRun(run)
  console.log(JSON.stringify(run.ai, null, 2))
  process.exit(run.ai.status === 'ok' ? 0 : 1)
}
