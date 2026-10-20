import { test, expect } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const exec = promisify(execFile)
test('PR TypeScript checks', async ({}, info) => {
  const result = await exec(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '--noEmit'], { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 })
    .then(output => ({ ...output, code: 0 }), error => ({ stdout: error.stdout ?? '', stderr: error.stderr ?? '', code: error.code }))
  await info.attach('TypeScript result', { body: `${result.stdout}\n${result.stderr}`, contentType: 'text/plain' })
  expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0)
})
for (const [name, directory] of [['Scheduler, PR checks and reporting', 'tests/reporting'], ['Dashboard controls and results', 'tests/dashboard']] as const) {
  test(name, async ({}, info) => {
    const files = readdirSync(directory).filter(file => file.endsWith('.test.mjs')).map(file => resolve(directory, file))
    const result = await exec(process.execPath, ['--test', ...files], { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 })
      .then(output => ({ ...output, code: 0 }), error => ({ stdout: error.stdout ?? '', stderr: error.stderr ?? '', code: error.code }))
    await info.attach('Automation test results', { body: `${result.stdout}\n${result.stderr}`, contentType: 'text/plain' })
    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0)
  })
}
