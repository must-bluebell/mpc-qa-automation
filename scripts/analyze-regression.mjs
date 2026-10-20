import dotenv from 'dotenv'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { aiSchema, validateAiAnalysis } from '../utils/regression-analysis.ts'
import { aiConfig, requestAnalysisWith } from '../pipeline/ai/providers.mjs'

dotenv.config()
try {
  const cfg=aiConfig()
  if (!cfg.configured) {
    throw new Error('AI model review has not run. Configure OpenClaw gateway access, Ollama, or a cloud provider. The automatic evidence brief is in playwright-report/ai-analysis.md.')
  }
  const folder = resolve('playwright-report')
  const input = JSON.parse(await readFile(resolve(folder, 'ai-analysis-input.json'), 'utf8'))
  const raw = await requestAnalysisWith(cfg, { input, schema: aiSchema })
  const analysis = validateAiAnalysis(raw, input, input.requirements)
  const output = { ...analysis, provider:cfg.provider,model: cfg.model, runGeneratedAt: input.generatedAt, generatedAt: new Date().toISOString() }
  await writeFile(resolve(folder, 'ai-analysis.json'), JSON.stringify(output, null, 2))
  const lines = ['AI analysis — advisory review', '', `Model: ${output.model}`, '', output.summary, '', output.decisionBasis, '', 'Findings:']
  for (const f of output.findings) lines.push(`- **${f.classification}**: ${f.title}. ${f.rationale} Evidence IDs: ${f.evidenceIds.join(', ')}`)
  lines.push('', 'Likely duplicate failures — suspected:')
  for (const g of output.duplicateGroups) lines.push(`- ${g.evidenceIds.join(', ')}: ${g.rationale}`)
  lines.push('', 'Scenario proposals — not validated acceptance tests:')
  for (const s of output.scenarios) lines.push(`- ${s.title} (${s.requirementIds.join(', ')}): ${s.steps.join(' → ')}. Assert: ${s.expectedResult}`)
  lines.push('', 'Before acceptance or release use: review the requirement mapping, implement explicit assertions, reproduce the defect, run the regression test, and review its evidence.', '')
  await writeFile(resolve(folder, 'ai-analysis.md'), lines.join('\n'))
  console.log('Saved validated advisory AI output to playwright-report/ai-analysis.md. Test counts and outcomes are unchanged.')
} catch (error) {
  // No request bodies, authorization headers, model payloads, or secrets in diagnostics.
  console.error(error instanceof Error ? error.message : 'AI analysis failed; test results are unchanged.')
  process.exitCode = 1
}
