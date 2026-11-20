import { expect, test, type APIRequestContext, type TestInfo } from '@playwright/test'
import { appOrigin, writesAllowed, requireWrites } from './api'
import { target } from '../config/target'
import { assertIsolatedTarget, loadApiCases } from './api-case-config.mjs'
import { readFileSync } from 'node:fs'

export type Expected = {
  status: number; error?: string; fields?: Record<string, unknown>; types?: Record<string, string>
  text?: string; contentType?: string; empty?: boolean; location?: string
}
export type Contract = {
  id: string; method: string; route: string; source: string; sourceAvailable: boolean
  path: string; wallet: boolean; originCheck: boolean; baseline: Expected | null; blocked?: string
  body?: unknown; headers?: Record<string, string>
}
export const contracts: Contract[] = JSON.parse(readFileSync(new URL('../testplans/api/contracts.json', import.meta.url), 'utf8'))

/** Every expanded test is isolated, including GET cron jobs and development sign-in. */
export function requireIsolatedApi() {
  test.skip(!writesAllowed(), 'Expanded API cases require the isolated QA_ALLOW_WRITES=1 environment.')
  // A mistakenly exported write flag must never enable this suite on the public deployments.
  assertIsolatedTarget(target().baseUrl, process.env.QA_ALLOW_WRITES)
}

export const requireApiWrites = requireWrites

export function field(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((v, k) => v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined, value)
}

export async function contractCall(request: APIRequestContext, info: TestInfo, method: string, path: string,
  options: { body?: unknown; raw?: string; headers?: Record<string, string>; origin?: string } = {}) {
  expect(new URL(path, target().baseUrl).origin, 'Request must stay on the isolated origin').toBe(new URL(target().baseUrl).origin)
  expect(path.startsWith('/') && !path.startsWith('//') && !path.includes('://'), 'Only relative application paths are permitted').toBe(true)
  expect(path, 'Resolve fixture placeholders before calling the API').not.toMatch(/\{\{|\[|\]/)
  const data = options.raw !== undefined ? Buffer.from(options.raw) : options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body))
  const response = await request.fetch(path, { method, maxRedirects: 0, failOnStatusCode: false,
    headers: { origin: options.origin ?? appOrigin(), ...(data === undefined ? {} : { 'content-type': 'application/json' }), ...options.headers }, data })
  const text = await response.text()
  let json: unknown
  try { json = JSON.parse(text) } catch { /* Text, SVG, redirects and 204 are valid contracts. */ }
  // Never attach payloads/cookies: admin replies can contain temporary credentials and vouchers.
  await info.attach(`${method} ${path.split('?')[0]}`, { contentType: 'application/json', body: JSON.stringify({
    method, route: path.split('?')[0], status: response.status(), contentType: response.headers()['content-type'], bytes: Buffer.byteLength(text),
  }) })
  return { status: response.status(), headers: response.headers(), text, json }
}

export function assertContract(result: Awaited<ReturnType<typeof contractCall>>, expected: Expected) {
  expect(result.status, `Expected HTTP ${expected.status}`).toBe(expected.status)
  if (expected.error !== undefined) expect(field(result.json, 'error')).toBe(expected.error)
  if (expected.fields || expected.types || expected.error) {
    expect(result.headers['content-type']).toContain('application/json')
    expect(result.json).toBeDefined()
  }
  for (const [key, value] of Object.entries(expected.fields ?? {})) expect(field(result.json, key), key).toEqual(value)
  for (const [key, type] of Object.entries(expected.types ?? {})) {
    const value = field(result.json, key)
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
    expect(type.split('|'), `Type of ${key}: ${actual}`).toContain(actual)
  }
  if (expected.empty) expect(result.text).toBe('')
  if (expected.text !== undefined) expect(result.text).toContain(expected.text)
  if (expected.contentType) expect(result.headers['content-type']).toContain(expected.contentType)
  if (expected.location) expect(result.headers.location).toContain(expected.location)
}

export const configuredCases = loadApiCases(process.env.QA_API_CASES_FILE, contracts)
