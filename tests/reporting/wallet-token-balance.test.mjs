import test from 'node:test'
import assert from 'node:assert/strict'

const { evaluateWalletBalance, parseTokenAddresses, readWalletBalance, runWatchdog } = await import('../../pipeline/lib/watchdog.mjs')

const NOW = new Date('2026-11-21T10:00:00Z')
const TOKEN_A = '0x1111111111111111111111111111111111111111'
const TOKEN_B = '0x2222222222222222222222222222222222222222'
const WALLET = '0x000000000000000000000000000000000000dEaD'

function withEnv(t, values) {
  const previous = {}
  for (const key of Object.keys(values)) previous[key] = process.env[key]
  Object.assign(process.env, values)
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}

test('a positive balance of any watched token is a finding even when native is empty', () => {
  const result = evaluateWalletBalance({ balanceWei: 0n, tokens: [{ address: TOKEN_A, ok: true, balanceWei: 5n }] })
  assert.equal(result.funded, true)
  assert.equal(result.nativeFunded, false)
  assert.deepEqual(result.tokens, [{ address: TOKEN_A, balanceWei: '5' }])
})

test('zero token balances and unchecked tokens are not findings', () => {
  const result = evaluateWalletBalance({ balanceWei: 0n, tokens: [
    { address: TOKEN_A, ok: true, balanceWei: 0n },
    { address: TOKEN_B, ok: false, reason: 'lookup failed' },
  ] })
  assert.equal(result.funded, false)
  assert.deepEqual(result.tokens, [])
})

test('the native rule is unchanged when no tokens are watched', () => {
  assert.equal(evaluateWalletBalance({ balanceWei: 0n }).funded, false)
  assert.equal(evaluateWalletBalance({ balanceWei: 1n }).funded, true)
})

test('token addresses are parsed, and malformed entries are reported rather than dropped silently', () => {
  const parsed = parseTokenAddresses(` ${TOKEN_A}, not-an-address ,${TOKEN_B},`)
  assert.deepEqual(parsed.addresses, [TOKEN_A, TOKEN_B])
  assert.deepEqual(parsed.invalid, ['not-an-address'])
  assert.deepEqual(parseTokenAddresses(undefined), { addresses: [], invalid: [] })
})

test('an unreachable RPC leaves the wallet unchecked, never funded, with or without tokens', async () => {
  const read = await readWalletBalance({ address: WALLET, chainId: 56, rpcUrl: 'http://127.0.0.1:9', tokens: [TOKEN_A], timeoutMs: 2000 })
  assert.equal(read.ok, false)
})

test('the watchdog alerts when a watched token is held, and names the token', async t => {
  withEnv(t, { WALLET_ADDRESS: WALLET, QA_WALLET_TOKEN_ADDRESSES: TOKEN_A, QA_WALLET_CHAIN_ID: '56' })
  const sent = []
  const facts = await runWatchdog({
    now: NOW, expectScheduler: false, schedules: { timezone: 'Asia/Seoul', schedules: [] }, readIndexImpl: () => [], readJobs: () => [], readHeartbeat: () => null,
    loadState: () => ({}), persistImpl: () => {},
    balanceReader: async ({ tokens }) => {
      assert.deepEqual(tokens, [TOKEN_A])
      return { ok: true, balanceWei: 0n, balance: '0.0', tokens: [{ address: TOKEN_A, ok: true, balanceWei: 7n }] }
    },
    notifyImpl: async (key, title, summary) => { sent.push({ key, title, summary }); return true },
  })
  assert.equal(facts.wallet.funded, true)
  assert.deepEqual(sent.map(s => s.key), ['wallet-funded'])
  assert.match(sent[0].summary, new RegExp(TOKEN_A))
})

test('an unchecked token is reported in the facts and does not raise an alert', async t => {
  withEnv(t, { WALLET_ADDRESS: WALLET, QA_WALLET_TOKEN_ADDRESSES: TOKEN_B })
  const sent = []
  const facts = await runWatchdog({
    now: NOW, expectScheduler: false, schedules: { timezone: 'Asia/Seoul', schedules: [] }, readIndexImpl: () => [], readJobs: () => [], readHeartbeat: () => null,
    loadState: () => ({}), persistImpl: () => {},
    balanceReader: async () => ({ ok: true, balanceWei: 0n, balance: '0.0', tokens: [{ address: TOKEN_B, ok: false, reason: 'lookup failed' }] }),
    notifyImpl: async (key) => { sent.push(key); return true },
  })
  assert.equal(facts.wallet.funded, false)
  assert.deepEqual(facts.wallet.tokensUnchecked, [TOKEN_B])
  assert.deepEqual(sent, [])
})
