import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
import { createPublicClient, createWalletClient, defineChain, getAddress, http, parseEther } from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import { createSiweMessage } from 'viem/siwe'
import { ROOT, isLoopback } from './env.mjs'
import { childEnv } from './proc.mjs'

/**
 * Pipeline stage 1b: prepares the configured QA wallet on the isolated stack before any suite runs.
 * It funds the wallet on both local Anvil chains and, through the app's own API (no DB writes), makes it
 * a waitlist member holding a My Mine certificate — the state the recorded journey (W20) needs.
 * Every step is idempotent: existing balance, membership and certificate are detected and left alone.
 * Shared/remote environments are never written to; the stage reports itself skipped there.
 */
const MIN_BALANCE = parseEther('10')
const FUND_TO = '0x56bc75e2d63100000' // 100 ETH, same as the WEB MPC scenario harness

export async function prepareTestData(env, { log = () => {}, fetchImpl = fetch } = {}) {
  const steps = []
  const step = (name, status, detail) => { steps.push({ name, status, detail }); log(`test-data: ${name} — ${status}${detail ? ` (${detail})` : ''}`) }
  const done = status => ({ status, steps, preparedAt: new Date().toISOString() })
  if (!env.isolated || !env.allowWrites || !env.stack?.ports) {
    step('environment', 'skipped', 'shared environment; test data is read-only')
    return done('skipped')
  }
  try {
    const account = qaAccount()
    step('wallet', 'ready', `QA wallet ${account.address.slice(0, 6)}…${account.address.slice(-4)}`)
    const ports = env.stack.ports
    const chains = { 97: await localChain(97, ports.anvil, account), 5611: await localChain(5611, ports.opbnbAnvil, account) }
    for (const c of Object.values(chains)) step(`funding chain ${c.id}`, ...(await fund(c, account)))

    const s = new AppSession(env.baseUrl, env.appOrigin, fetchImpl)
    await s.signIn(account, env.chainId)
    step('sign-in', 'ready', 'SIWE session for the QA wallet')

    const before = await s.request('/my-mine/claim', undefined, [200, 404])
    if (before.status === 404) { step('my-mine certificate', 'skipped', 'My Mine is not open on this deployment'); return done('ready') }
    if (before.body?.held) { step('membership', 'ready', 'already a member'); step('my-mine certificate', 'ready', 'already held'); return done('ready') }

    const answers = await examAnswers(env)
    let claim = await s.request('/my-mine/claim/self', { answers }, [200, 409])
    if (claim.status === 409 && claim.body?.error === 'not-waitlist-member') {
      await joinWaitlist(s, account, chains)
      step('membership', 'created', 'waitlist SBT claimed through the relay')
      claim = await s.request('/my-mine/claim/self', { answers }, [200, 409])
    } else step('membership', 'ready', 'already a member')
    if (claim.status === 409) {
      if (claim.body?.error !== 'already-claimed') throw new Error(`certificate claim refused: ${safeCode(claim.body?.error)}`)
      step('my-mine certificate', 'ready', 'already claimed')
      return done('ready')
    }
    const tx = claim.body.transaction
    const chain = chains[Number(tx.chainId ?? 5611)]
    if (!chain) throw new Error(`certificate transaction targets unexpected chain ${safeCode(tx.chainId)}`)
    await send(chain, tx)
    await eventually(async () => (await s.request('/my-mine/claim')).body?.held === true, 'certificate visible to the app')
    step('my-mine certificate', 'created', 'claimed on local opBNB')
    return done('ready')
  } catch (error) {
    step('preparation', 'failed', error.message.slice(0, 300))
    return done('failed')
  }
}

function qaAccount() {
  const phrase = process.env.QA_SEED_PHRASE?.trim()
  if (!phrase) throw new Error('QA_SEED_PHRASE is not set')
  const index = Number(process.env.WALLET_ADDRESS_INDEX ?? '0')
  if (!Number.isInteger(index) || index < 0) throw new Error('WALLET_ADDRESS_INDEX must be a non-negative integer')
  const account = mnemonicToAccount(phrase, { addressIndex: index })
  if (process.env.WALLET_ADDRESS && getAddress(process.env.WALLET_ADDRESS) !== account.address) throw new Error('QA_SEED_PHRASE/WALLET_ADDRESS_INDEX do not derive WALLET_ADDRESS')
  return account
}

/** Refuses anything but a loopback Anvil reporting the expected chain id, so funding can never reach a real network. */
async function localChain(id, port, account) {
  if (!port) throw new Error(`no local port configured for chain ${id}`)
  const url = `http://127.0.0.1:${port}`
  if (!isLoopback(url)) throw new Error('test data may only be written to loopback chains')
  const chain = defineChain({ id, name: `Local ${id}`, nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 }, rpcUrls: { default: { http: [url] } } })
  const pub = createPublicClient({ chain, transport: http(url, { timeout: 15_000 }) })
  const [chainId, version] = await Promise.all([pub.getChainId(), pub.request({ method: 'web3_clientVersion' })])
  if (chainId !== id || !String(version).toLowerCase().includes('anvil')) throw new Error(`port ${port} is not the local Anvil for chain ${id}`)
  return { id, pub, wallet: createWalletClient({ chain, account, transport: http(url, { timeout: 15_000 }) }) }
}

async function fund(c, account) {
  if (await c.pub.getBalance({ address: account.address }) >= MIN_BALANCE) return ['ready', 'balance already sufficient']
  await c.pub.request({ method: 'anvil_setBalance', params: [account.address, FUND_TO] })
  await c.pub.request({ method: 'anvil_mine', params: ['0x1', '0x0'] }) // commit before the app reads latest
  return ['created', 'funded to 100']
}

async function send(c, tx) {
  const hash = await c.wallet.sendTransaction({ to: tx.to, data: tx.data ?? tx.calldata, value: BigInt(tx.value ?? 0), ...(tx.gas ? { gas: BigInt(tx.gas) } : {}) })
  const receipt = await c.pub.waitForTransactionReceipt({ hash, timeout: 60_000 })
  if (receipt.status !== 'success') throw new Error('certificate transaction reverted')
}

/** Same flow as the WEB MPC scenario harness `member()`: social steps, then a relayed waitlist SBT claim. */
async function joinWaitlist(s, account, chains) {
  await s.request('/api/join/x-open', {}, [200])
  await s.request('/api/join/social-complete', {}, [200])
  await s.request('/api/register/skip-otp', { email: `qa-${account.address.slice(2, 10).toLowerCase()}@example.com` }, [200, 409])
  const prepared = (await s.request('/api/relay/challenge', { kind: 'claim' })).body
  const chain = chains[Number(prepared.typedData.domain.chainId)]
  if (!chain) throw new Error('membership claim targets an unexpected chain')
  const userSig = await account.signTypedData(prepared.typedData)
  const submitted = (await s.request('/api/relay/submit', { challenge: prepared.challenge, userSig, activityId: prepared.activityId })).body
  if (submitted?.txHash) await chain.pub.waitForTransactionReceipt({ hash: submitted.txHash, timeout: 60_000 })
  await eventually(async () => (await s.request(`/api/relay/status?challenge=${encodeURIComponent(prepared.challenge)}`)).body?.state === 'landed', 'membership relay landed')
}

/** The exam key is read from the app's own source (read-only) so it can never drift from what the app checks. */
export async function examAnswers(env) {
  const root = resolve(ROOT, env.stack.webmpcPath)
  // App modules validate chain wiring at import time. Load them in a separate process
  // with this target's settings, without changing or caching the parent's environment.
  const script = `
    import { createRequire } from 'node:module';
    const root = process.cwd();
    const { createJiti } = createRequire(root + '/package.json')('jiti');
    const jiti = createJiti(root + '/package.json', { alias: { '@modules': root + '/src/modules', '@platform': root + '/src/platform', '@shared': root + '/src/shared', '@config': root + '/config' } });
    const { WAY_QUIZ } = await jiti.import(root + '/src/modules/my-mine/glossary/text.ts');
    if (!Array.isArray(WAY_QUIZ) || !WAY_QUIZ.length) throw new Error('could not read the My Mine exam key');
    console.log(JSON.stringify(WAY_QUIZ.map(q => q.a)));
  `
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
    cwd: root, timeout: 30_000,
    env: childEnv({ NEXT_PUBLIC_CHAIN_ID: String(env.chainId),
      NEXT_PUBLIC_LOCAL_RPC_URL: `http://127.0.0.1:${env.stack.ports?.anvil ?? 8555}`,
      NEXT_PUBLIC_LOCAL_OPBNB_RPC_URL: `http://127.0.0.1:${env.stack.ports?.opbnbAnvil ?? 8556}` }),
  })
  return JSON.parse(stdout.trim())
}

class AppSession {
  constructor(baseUrl, origin, fetchImpl) { Object.assign(this, { baseUrl, origin, fetchImpl, jar: new Map() }) }
  async request(path, body, expected = [200]) {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, { method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(60_000),
      headers: { origin: this.origin, 'content-type': 'application/json', cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ') },
      body: body === undefined ? undefined : JSON.stringify(body) })
    for (const value of res.headers.getSetCookie?.() ?? []) { const part = value.split(';')[0], at = part.indexOf('='); this.jar.set(part.slice(0, at), part.slice(at + 1)) }
    const text = await res.text()
    // Only the path and status are reported; response bodies may carry wallet data and stay out of logs.
    if (!expected.includes(res.status)) throw new Error(`${body === undefined ? 'GET' : 'POST'} ${path.split('?')[0]} answered ${res.status}`)
    let parsed = null
    try { parsed = text ? JSON.parse(text) : null } catch { /* non-JSON bodies (e.g. 404 pages) are not needed */ }
    return { status: res.status, body: parsed }
  }
  async signIn(account, chainId) {
    const { nonce } = (await this.request('/api/auth/nonce', {})).body
    const origin = new URL(this.origin)
    const message = createSiweMessage({ address: account.address, chainId, domain: origin.host, scheme: origin.protocol.replace(':', ''), uri: origin.origin,
      version: '1', nonce, issuedAt: new Date(), expirationTime: new Date(Date.now() + 300_000) })
    await this.request('/api/auth/verify', { message, signature: await account.signMessage({ message }) })
  }
}

async function eventually(check, label, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (await check().catch(() => false)) return
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error(`timed out waiting for ${label}`)
}

const safeCode = value => String(value ?? 'unknown').replace(/[^\w-]/g, '').slice(0, 60)
