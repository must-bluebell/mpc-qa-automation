import type { Reporter, FullConfig, FullResult, Suite } from '@playwright/test/reporter'
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises'
import { basename, join, relative, resolve } from 'node:path'
import { formatSummary, redact, summarizeRun, type Requirement, type TestRecord } from './regression-analysis'

export default class RegressionReporter implements Reporter {
  private suite?: Suite
  private root = process.cwd()
  private result?: FullResult
  private errors: string[] = []
  onBegin(config: FullConfig, suite: Suite) { this.suite = suite; this.root = config.configFile ? resolve(config.configFile, '..') : process.cwd() }
  onError(error: { message?: string }) { this.errors.push(error.message ?? 'Runner error') }
  onEnd(result: FullResult) { this.result = result }
  async onExit() {
    if (!this.suite || !this.result) return
    // `playwright test --list` runs reporters without executing anything; keep the last real report.
    if (!this.suite.allTests().some(t => t.results.length)) return
    const output = process.env.QA_REPORT_DIR ? resolve(process.env.QA_REPORT_DIR) : join(this.root, 'playwright-report')
    await mkdir(output, { recursive: true })
    const requirements = JSON.parse(await readFile(join(this.root, 'config/qa-requirements.json'), 'utf8')) as Requirement[]
    const secrets = [process.env.QA_SEED_PHRASE ?? '', process.env.OPENAI_API_KEY ?? '', process.env.ANTHROPIC_API_KEY ?? '', process.env.SLACK_ALERT_WEBHOOK_URL ?? '']
    const records: TestRecord[] = []
    for (const item of this.suite.allTests()) {
      const last = item.results.at(-1)
      const evidence: TestRecord['evidence'] = []
      for (const [index, attachment] of (last?.attachments ?? []).entries()) {
        if (!attachment.path && !attachment.body) continue
        const folder = join(output, 'evidence', item.id.replace(/[^a-zA-Z0-9_-]/g, '_'))
        await mkdir(folder, { recursive: true })
        if (attachment.path) {
          const destination = join(folder, `${index}-${basename(attachment.path)}`)
          await copyFile(attachment.path, destination)
          evidence.push({ name: attachment.name, path: relative(output, destination).split('\\').join('/') })
        } else if (attachment.body) {
          // In-memory attachments (API responses, navigation status) are evidence too; redact before writing.
          const extension = attachment.contentType.includes('json') ? 'json' : attachment.contentType.startsWith('text/') ? 'txt' : 'bin'
          const destination = join(folder, `${index}-${attachment.name.replace(/[^a-zA-Z0-9_.-]+/g, '_').slice(0, 80)}.${extension}`)
          await writeFile(destination, extension === 'bin' ? attachment.body : redact(attachment.body.toString('utf8'), secrets).slice(0, 6_000))
          evidence.push({ name: attachment.name, path: relative(output, destination).split('\\').join('/') })
        }
      }
      records.push({ id: item.id, title: item.titlePath().filter(Boolean).join(' > '),
        status: last?.status ?? 'not-run', outcome: item.outcome(),
        errors: (last?.errors ?? []).map(error => redact(error.message ?? 'Test failed', secrets)),
        annotations: [...new Map([...item.annotations, ...(last?.annotations ?? [])].map(a => [`${a.type}\u0000${a.description ?? ''}`, a])).values()].map(a => ({ type: a.type, description: redact(a.description ?? '', secrets) })), evidence,
        durationMs: item.results.reduce((sum, r) => sum + r.duration, 0), retries: Math.max(0, item.results.length - 1),
        tags: item.tags, project: item.parent.project()?.name, startedAt: item.results[0]?.startTime.toISOString() })
    }
    const metadata = {
      environment: process.env.QA_ENVIRONMENT || process.env.BASE_URL || 'Unconfigured target',
      version: process.env.QA_VERSION || 'Unspecified deployment version',
      owner: process.env.QA_OWNER || 'Unconfigured', label: process.env.QA_RUN_LABEL || 'Regression',
    }
    const run = summarizeRun(records, metadata, requirements, this.result.status)
    const evaluationPolicy = JSON.parse(await readFile(join(this.root, 'config/qa-evaluation.json'), 'utf8'))
    const full = { ...run, evaluation: { status: 'not-calculated', policy: evaluationPolicy }, runnerErrors: this.errors.map(error => redact(error, secrets)) }
    await writeFile(join(output, 'regression-summary.json'), JSON.stringify(full, null, 2))
    await writeFile(join(output, 'regression-summary.md'), formatSummary(run))
    // Only redacted text and identifiers go into the AI input, never trace/screenshot contents.
    const input = { ...full, requirements: requirements.filter(r => r.approved),
      records: records.map(({ evidence, ...record }) => ({ ...record, evidence: evidence.map(e => e.name) })) }
    await writeFile(join(output, 'ai-analysis-input.json'), JSON.stringify(input, null, 2))
    await writeFile(join(output, 'ai-analysis.md'), `AI review brief — model not run\n\n${formatSummary(run)}\nRun npm run analyze:ai with OPENAI_API_KEY and OPENAI_MODEL configured locally.\nAI suggestions require review and a reproduced failing assertion before becoming acceptance checks.\n`)
    console.log(`\nRegression summary: ${join(output, 'regression-summary.md')}`)
  }
}
