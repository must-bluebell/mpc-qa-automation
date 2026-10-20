import { test, expect } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync } from 'node:fs'

const exec = promisify(execFile)
const profiles: Record<string, { stack: { composeProject: string; ports: { anvil: number; opbnbAnvil: number } } }> = JSON.parse(
  readFileSync(new URL('../../pipeline/config/environments.json', import.meta.url), 'utf8'),
)
test.describe('System Health', { tag: ['@health', '@critical'] }, () => {
  test.beforeEach(() => {
    test.skip(!['local-docker', 'web-isolated'].includes(process.env.QA_ENVIRONMENT ?? ''), 'System health checks require the isolated local stack')
  })
  for (const path of ['/', '/api/quests', '/api/vote/proposals']) {
    test(`HEALTH - Application and backend respond at ${path}`, async ({ request }) => {
      const response = await request.get(path)
      expect(response.status()).toBe(200)
      if (path.startsWith('/api/')) expect(response.headers()['content-type']).toContain('application/json')
    })
  }
  test('HEALTH - Required Docker, database and pool services are running and healthy', async ({}, info) => {
    const profile = profiles[process.env.QA_ENVIRONMENT!]!
    const rows = []
    for (const service of ['web', 'postgres', 'neon-proxy', 'pgbouncer', 'anvil', 'anvil-opbnb']) {
      const result = await exec('docker', ['inspect', '--format', '{{json .State}}', `${profile.stack.composeProject}-${service}-1`])
      const state = JSON.parse(result.stdout)
      rows.push({ service, running: state.Running, health: state.Health?.Status ?? 'not configured' })
      expect(state.Running, service).toBe(true)
      if (state.Health) expect(state.Health.Status, service).toBe('healthy')
    }
    await info.attach('System service health', { body: JSON.stringify(rows, null, 2), contentType: 'application/json' })
  })
  for (const [name, port, chainId] of [['BSC', 'anvil', 97], ['opBNB', 'opbnbAnvil', 5611]] as const) {
    test(`HEALTH - ${name} RPC has the expected chain and advances blocks`, async ({ request }) => {
      const profile = profiles[process.env.QA_ENVIRONMENT!]!
      const url = `http://127.0.0.1:${profile.stack.ports[port]}`
      const rpc = async (method: string) => {
        const response = await request.post(url, { data: { jsonrpc: '2.0', id: 1, method, params: [] } })
        expect(response.status()).toBe(200)
        const body = await response.json()
        expect(body.error).toBeUndefined()
        return body.result as string
      }
      expect(Number(BigInt(await rpc('eth_chainId')))).toBe(chainId)
      const first = BigInt(await rpc('eth_blockNumber'))
      await expect.poll(async () => BigInt(await rpc('eth_blockNumber')), { timeout: 15_000 }).toBeGreaterThan(first)
    })
  }
})
