export type Annotation = { type: string; description?: string }
export type Requirement = { id: string; approved: boolean; description: string }
export type RunMetadata = { environment: string; version: string; owner: string; label: string }
export type TestRecord = {
  id: string; title: string; status: string; outcome: string; errors: string[]
  annotations: Annotation[]; evidence: { name: string; path: string }[]
  /** Added for the pipeline; optional so older summaries still parse. */
  durationMs?: number; retries?: number; tags?: string[]; project?: string; startedAt?: string
}
export type Finding = {
  id: string; title: string; classification: 'confirmed' | 'suspected' | 'usability-related'
  executionFailureConfirmed: boolean; requirementIds: string[]; details: string[]; critical: boolean
}

export function redact(value: string, secrets: string[] = []): string {
  let output = value
  for (const secret of secrets.filter(Boolean)) output = output.split(secret).join('[REDACTED]')
  return output.replace(/0x[0-9a-fA-F]{64}\b/g, '[REDACTED KEY]')
    .replace(/(?:authorization|cookie|set-cookie):[^\r\n]*/gi, '[REDACTED AUTH]')
    .slice(0, 6_000)
}

export function summarizeRun(records: TestRecord[], metadata: RunMetadata, requirements: Requirement[], runnerStatus: string) {
  const approved = new Set(requirements.filter(r => r.approved).map(r => r.id))
  const counts = { passed: 0, failed: 0, skipped: 0, blocked: 0, flaky: 0 }
  const findings: Finding[] = []
  for (const row of records) {
    if (row.status === 'skipped') {
      if (row.annotations.some(a => a.type === 'blocked')) counts.blocked++
      else counts.skipped++
    } else if (row.status === 'interrupted' || row.status === 'not-run') counts.blocked++
    else if (row.outcome === 'expected' || row.outcome === 'flaky') {
      counts.passed++
      if (row.outcome === 'flaky') counts.flaky++
    } else counts.failed++

    const failed = !['expected', 'flaky'].includes(row.outcome) && ['failed', 'timedOut'].includes(row.status)
    const confirmation = row.annotations.find(a => a.type === 'defect-confirmed')
    const requirementId = confirmation?.description?.split(':')[0]?.trim()
    const confirmed = failed && !!requirementId && approved.has(requirementId)
    const observations = row.annotations.filter(a => ['external-blocked', 'usability-related', 'blocked'].includes(a.type))
    if (failed || observations.length) {
      findings.push({
        id: row.id, title: row.title,
        classification: confirmed ? 'confirmed' : observations.some(a => a.type === 'usability-related') && !failed ? 'usability-related' : 'suspected',
        executionFailureConfirmed: failed,
        requirementIds: confirmed && requirementId ? [requirementId] : [],
        details: [...row.errors, ...observations.map(a => a.description ?? a.type)],
        critical: confirmed && row.annotations.some(a => a.type === 'severity' && a.description === 'critical'),
      })
    }
  }
  const status = runnerStatus !== 'passed' ? runnerStatus : counts.failed ? 'failed' : counts.blocked ? 'blocked' : counts.flaky ? 'unstable' : 'passed'
  return { metadata, status, counts, findings, records, generatedAt: new Date().toISOString(),
    decisionBasis: 'Explicit Playwright assertions. AI output does not change test outcomes.' }
}
export type RegressionRun = ReturnType<typeof summarizeRun>

export function formatSummary(run: RegressionRun): string {
  const { metadata: m, counts: c } = run
  const critical = run.findings.filter(f => f.critical)
  const lines = [
    `MPC QA — ${m.label} ${run.status}`,
    `Environment: ${m.environment} | Version: ${m.version}`,
    `${c.passed} passed | ${c.failed} failed | ${c.skipped} skipped | ${c.blocked} blocked`,
    `Critical: ${critical.length ? critical.map(f => f.title).join('; ') : 'No confirmed critical defects'}`,
    'Evidence: [Full report](index.html) | [Structured results](regression-summary.json)',
    `Owner: ${m.owner}`, '', `Flaky tests: ${c.flaky}`, '', run.decisionBasis, '',
    'Finding labels: confirmed, suspected, usability-related.',
    'A confirmed test failure is not automatically a confirmed product defect.', '',
  ]
  for (const finding of run.findings) {
    lines.push(`- **${finding.classification}**: ${finding.title}`, ...finding.details.map(d => `  ${d.replace(/\n/g, ' ')}`))
    const evidence = run.records.find(r => r.id === finding.id)?.evidence ?? []
    for (const item of evidence) lines.push(`  [${item.name}](${item.path})`)
  }
  return lines.join('\n') + '\n'
}

export const aiSchema = {
  type: 'object', additionalProperties: false, required: ['summary', 'findings', 'duplicateGroups', 'scenarios'],
  properties: {
    summary: { type: 'string' },
    findings: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      required: ['title', 'classification', 'evidenceIds', 'requirementIds', 'rationale'],
      properties: { title: { type: 'string' }, classification: { type: 'string', enum: ['confirmed', 'suspected', 'usability-related'] },
        evidenceIds: { type: 'array', items: { type: 'string' } }, requirementIds: { type: 'array', items: { type: 'string' } }, rationale: { type: 'string' } },
    } },
    duplicateGroups: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['evidenceIds', 'rationale'],
      properties: { evidenceIds: { type: 'array', items: { type: 'string' } }, rationale: { type: 'string' } },
    } },
    scenarios: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['title', 'requirementIds', 'steps', 'expectedResult'],
      properties: { title: { type: 'string' }, requirementIds: { type: 'array', items: { type: 'string' } },
        steps: { type: 'array', items: { type: 'string' } }, expectedResult: { type: 'string' } },
    } },
  },
}

export function validateAiAnalysis(raw: unknown, run: RegressionRun, requirements: Requirement[]) {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid AI review object.')
  const input = raw as Record<string, unknown>
  if (typeof input.summary !== 'string' || !Array.isArray(input.findings) || !Array.isArray(input.duplicateGroups) || !Array.isArray(input.scenarios)) throw new Error('Invalid AI review shape.')
  const evidence = new Set(run.findings.map(f => f.id))
  const approved = new Set(requirements.filter(r => r.approved).map(r => r.id))
  const strings = (value: unknown): string[] => {
    if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) throw new Error('Invalid AI review list.')
    return value
  }
  const text = (value: unknown): string => { if (typeof value !== 'string') throw new Error('Invalid AI review text.'); return value }
  const checkIds = (ids: string[], allowed: Set<string>) => { if (ids.some(id => !allowed.has(id))) throw new Error('AI review referenced unapproved requirements or missing evidence.') }
  const findings = input.findings.map((item: Record<string, unknown>) => {
    const evidenceIds = strings(item.evidenceIds), requirementIds = strings(item.requirementIds)
    checkIds(evidenceIds, evidence); checkIds(requirementIds, approved)
    if (!evidenceIds.length || !['confirmed', 'suspected', 'usability-related'].includes(String(item.classification))) throw new Error('AI finding has no valid evidence or classification.')
    const confirmed = requirementIds.length > 0 && evidenceIds.every(id => run.findings.some(f => f.id === id && f.classification === 'confirmed' && requirementIds.every(r => f.requirementIds.includes(r))))
    return { title: text(item.title), classification: item.classification === 'confirmed' && !confirmed ? 'suspected' : String(item.classification), evidenceIds, requirementIds, rationale: text(item.rationale) }
  })
  const duplicateGroups = input.duplicateGroups.map((item: Record<string, unknown>) => {
    const evidenceIds = strings(item.evidenceIds); checkIds(evidenceIds, evidence)
    if (new Set(evidenceIds).size < 2) throw new Error('Duplicate group requires at least two distinct failures.')
    return { evidenceIds, rationale: text(item.rationale), classification: 'suspected' }
  })
  const scenarios = input.scenarios.map((item: Record<string, unknown>) => {
    const requirementIds = strings(item.requirementIds); checkIds(requirementIds, approved)
    const steps = strings(item.steps)
    if (!requirementIds.length || !steps.length) throw new Error('Scenario needs an approved requirement and actionable steps.')
    return { title: text(item.title), requirementIds, steps, expectedResult: text(item.expectedResult), validationStatus: 'proposed; not an acceptance check' }
  })
  return { summary: input.summary, findings, duplicateGroups, scenarios,
    decisionBasis: run.decisionBasis, modelOutputValidated: true, generatedTestsValidated: false }
}
