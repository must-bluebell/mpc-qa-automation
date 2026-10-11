/**
 * wallet-standalone.spec.ts
 *
 * Every piece of wallet-related code from the MPC QA agent, in one self-contained Playwright file:
 *
 *   1. Target config          (config/target.ts)          — base URL, chain id, chain names
 *   2. Wallet generator       (utils/wallet-generator.ts) — HD wallets derived from QA_SEED_PHRASE
 *   3. Mock EIP-6963 wallet   (fixtures/wallet.ts)        — injected provider + Node-side signing
 *   4. Network stubs          (fixtures/network.ts)       — analytics stub used by the wallet tests
 *   5. Capability probe       (fixtures/tiers.ts)         — skips SIWE tests when writes are refused
 *   6. App copy               (pages/copy.ts)             — wallet/sign/switch strings only
 *   7. Page object            (pages/JoinSheet.ts)        — wallet-step locators and actions
 *   8. Tests                  (tests/wallet/wallet-flow.spec.ts + tests/wallet/wallet-errors.spec.ts)
 *
 * ── Setup in the other project ──────────────────────────────────────────────────────────────────
 *   npm i -D @playwright/test viem @types/node
 *   npx playwright install chromium
 *
 * ── Environment ─────────────────────────────────────────────────────────────────────────────────
 *   BASE_URL        target deployment (default https://globalmpc-webapp.vercel.app)
 *   QA_CHAIN_ID     56 = BSC mainnet, 97 = BSC testnet (default 56)
 *   QA_SEED_PHRASE  test-only mnemonic. 🔴 NEVER COMMIT. Tests skip when unset.
 *
 * ── Run ─────────────────────────────────────────────────────────────────────────────────────────
 *   BASE_URL=... QA_CHAIN_ID=97 QA_SEED_PHRASE="..." npx playwright test wallet-standalone.spec.ts
 *
 * The tests navigate to '/', so either set `use.baseURL` in playwright.config to BASE_URL, or
 * leave it unset — `test.use` below sets it from BASE_URL for this file.
 */
import {
  expect,
  request as apiRequest,
  test,
  type Locator,
  type Page,
} from '@playwright/test'
import { getAddress, isAddress, type HDAccount } from 'viem'
import { mnemonicToAccount } from 'viem/accounts'

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 1. Target config
// ════════════════════════════════════════════════════════════════════════════════════════════════

/** BSC mainnet. Vercel Production and Staging both build against this. */
export const MAINNET = 56
/** BSC testnet. Vercel Preview builds against this. */
export const TESTNET = 97

export type Target = {
  baseUrl: string
  chainId: number
  /** Hex form, as EIP-1193 reports it (`eth_chainId`). */
  chainIdHex: string
  isTestnet: boolean
}

const DEFAULT_BASE_URL = 'https://globalmpc-webapp.vercel.app'
const DEFAULT_CHAIN_ID = MAINNET

export function target(): Target {
  const baseUrl = (process.env.BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '')
  const raw = process.env.QA_CHAIN_ID
  const chainId = raw ? Number(raw) : DEFAULT_CHAIN_ID

  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new Error(`QA_CHAIN_ID must be a positive integer, got ${JSON.stringify(raw)}`)
  }

  return {
    baseUrl,
    chainId,
    chainIdHex: `0x${chainId.toString(16)}`,
    isTestnet: chainId === TESTNET,
  }
}

/**
 * The chain name the app puts into switch-failure copy, i.e. `CHAIN.name`.
 * 🔴 56 is overridden by the app to "BNB Chain" (not viem's default); 97 keeps viem's name.
 */
const CHAIN_NAMES: Record<number, string> = {
  [MAINNET]: 'BNB Chain',
  [TESTNET]: 'BNB Smart Chain Testnet',
}

export function chainName(t: Target = target()): string {
  const name = CHAIN_NAMES[t.chainId]
  if (!name) throw new Error(`No chain display name recorded for chain ${t.chainId}`)
  return name
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 2. Wallet generator
// ════════════════════════════════════════════════════════════════════════════════════════════════

/** Derive the configured account in Node; never send the phrase to the browser. */
export function getTestWallet(addressIndex: number): HDAccount {
  const mnemonic = process.env.QA_SEED_PHRASE
  if (!mnemonic) throw new Error('QA_SEED_PHRASE is not set. Configure it locally in .env.')
  if (!Number.isInteger(addressIndex) || addressIndex < 0 || addressIndex >= 2 ** 31) {
    throw new Error('Wallet address index must be an integer between 0 and 2147483647.')
  }
  try {
    return mnemonicToAccount(mnemonic.trim(), { addressIndex })
  } catch {
    throw new Error('Could not derive the configured wallet. Check the recovery phrase locally.')
  }
}

/** Use exactly the requested account and reject a mismatched signing phrase. */
export function getConfiguredWallet(): HDAccount {
  const expected = process.env.WALLET_ADDRESS
  if (!expected || !isAddress(expected)) {
    throw new Error('WALLET_ADDRESS must contain a valid Ethereum address in .env.')
  }
  const index = Number(process.env.WALLET_ADDRESS_INDEX ?? '0')
  const account = getTestWallet(index)
  if (account.address.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`The recovery phrase at index ${index} does not derive ${getAddress(expected)}. Check WALLET_ADDRESS_INDEX and the phrase locally.`)
  }
  return account
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 3. Mock EIP-6963 wallet
// ════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * A mock browser wallet, injected before page load.
 *
 * 🔴 A bare `window.ethereum` renders no wallet to click — the app only lists wallets that announced
 *    themselves over EIP-6963. So this provider announces, with a name.
 * 🔴 The signature is verified for real by `/api/auth/verify`, so signing uses the actual derived
 *    key. The key never enters the browser: signing is bridged out to Node via `page.exposeFunction`.
 */

/** The five branches the app's `classifyWalletError` recognises. */
export type WalletFailure = 'rejected' | 'pending' | 'locked' | 'no_wallet' | 'unknown'

/** Methods a test can force to fail, to drive the app's failure copy. */
export type FailableMethod =
  | 'eth_requestAccounts'
  | 'personal_sign'
  | 'wallet_switchEthereumChain'
  | 'eth_signTypedData_v4'

export type InjectWalletOptions = {
  account: HDAccount
  /** Reported by `eth_chainId`. Must match the target's chain or the app will ask to switch. */
  chainId: number
  /** The name shown on the wallet row — this is `connector.name`, so it is the button's label. */
  walletName?: string
  failOn?: Partial<Record<FailableMethod, WalletFailure>>
}

const SIGN_BRIDGE = '__mpcQaSign'

/** mipd (the EIP-6963 store wagmi uses) validates the shape of uuid and rdns. */
const WALLET_UUID = 'f1a3c9e2-5b7d-4c81-9e6a-2d4f8b0c1a37'
const WALLET_RDNS = 'tech.globalmpc.qa'
const WALLET_ICON =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiI+PHJlY3Qgd2lkdGg9IjMyIiBoZWlnaHQ9IjMyIiByeD0iOCIgZmlsbD0iI2I4NzMzMyIvPjwvc3ZnPg=='

export type MockWallet = {
  account: HDAccount
  address: `0x${string}`
  walletName: string
}

export async function injectTestWallet(
  page: Page,
  options: InjectWalletOptions,
): Promise<MockWallet> {
  const { account, chainId, walletName = 'Trust Wallet', failOn = {} } = options
  const address = account.address

  // The bridge: the page hands over what to sign, this process signs it with the derived key.
  await page.exposeFunction(
    SIGN_BRIDGE,
    async (request: { method: string; params: unknown[] }): Promise<string> => {
      if (request.method === 'personal_sign') {
        // EIP-191 `personal_sign` params are [dataHex, address].
        const [data] = request.params as [`0x${string}`, string]
        return account.signMessage({ message: { raw: data } })
      }
      if (request.method === 'eth_signTypedData_v4' || request.method === 'eth_signTypedData_v3') {
        // EIP-712 params are [address, jsonPayload].
        const [, payload] = request.params as [string, string]
        return account.signTypedData(JSON.parse(payload))
      }
      throw new Error(`sign bridge: unhandled method ${request.method}`)
    },
  )

  await page.addInitScript(
    (cfg: {
      address: string
      chainIdHex: string
      walletName: string
      uuid: string
      rdns: string
      icon: string
      bridge: string
      failOn: Record<string, string>
    }) => {
      let currentChainHex = cfg.chainIdHex

      // Forced failures, kept mutable on `window` so a test can change them mid-flow.
      ;(window as unknown as Record<string, unknown>).__mpcQaFailOn = { ...cfg.failOn }

      /**
       * Error shapes chosen to land on each branch of `classifyWalletError` (type, then EIP-1193
       * code, then copy). Changing this wording can silently move a branch.
       */
      const makeError = (kind: string): Error => {
        switch (kind) {
          case 'rejected': {
            // EIP-1193 4001.
            const e = new Error('User rejected the request.')
            return Object.assign(e, { code: 4001 })
          }
          case 'pending': {
            // EIP-1474 -32002, "resource unavailable".
            const e = new Error('Request of type eth_requestAccounts is already pending.')
            return Object.assign(e, { code: -32002 })
          }
          case 'locked':
            return new Error('The wallet is locked. Unlock it and try again.')
          case 'no_wallet':
            return new Error('provider not found')
          default:
            // Must match none of the copy patterns, so it lands on the `unknown` branch.
            return new Error('The wallet could not complete the request.')
        }
      }

      const handlers: Record<string, Array<(...args: unknown[]) => void>> = {}
      const emit = (event: string, ...args: unknown[]) => {
        for (const fn of handlers[event] ?? []) fn(...args)
      }

      const provider = {
        isMetaMask: true,
        isMpcQaWallet: true,
        get chainId() {
          return currentChainHex
        },
        get selectedAddress() {
          return cfg.address
        },
        async request({ method, params }: { method: string; params?: unknown[] }): Promise<unknown> {
          const table = (window as unknown as Record<string, Record<string, string>>).__mpcQaFailOn
          const forced = table?.[method]
          if (forced) throw makeError(forced)

          switch (method) {
            case 'eth_requestAccounts':
            case 'eth_accounts':
              return [cfg.address]
            case 'eth_chainId':
              return currentChainHex
            case 'net_version':
              return String(parseInt(currentChainHex, 16))

            case 'personal_sign':
            case 'eth_signTypedData_v4':
            case 'eth_signTypedData_v3': {
              const sign = (window as unknown as Record<string, unknown>)[cfg.bridge] as (
                req: { method: string; params: unknown[] },
              ) => Promise<string>
              return sign({ method, params: params ?? [] })
            }

            case 'wallet_switchEthereumChain': {
              const next = (params?.[0] as { chainId?: string } | undefined)?.chainId
              if (typeof next === 'string') {
                currentChainHex = next
                emit('chainChanged', next)
              }
              return null
            }
            case 'wallet_addEthereumChain':
              return null
            case 'wallet_requestPermissions':
              return [{ parentCapability: 'eth_accounts' }]
            case 'wallet_revokePermissions':
              return null

            case 'eth_sendTransaction':
              // Failing loudly is safer than returning a fake hash the app would poll forever.
              throw makeError('unknown')

            default: {
              // EIP-1193 4200, "unsupported method".
              const e = new Error(`The mock wallet does not implement ${method}.`)
              throw Object.assign(e, { code: 4200 })
            }
          }
        },
        on(event: string, handler: (...args: unknown[]) => void) {
          ;(handlers[event] ??= []).push(handler)
        },
        removeListener(event: string, handler: (...args: unknown[]) => void) {
          handlers[event] = (handlers[event] ?? []).filter((h) => h !== handler)
        },
      }

      /**
       * EIP-6963 announcement. 🔴 The listener is what matters: this script runs before wagmi
       * exists, so wagmi only hears the re-announce in response to `eip6963:requestProvider`.
       */
      const detail = Object.freeze({
        info: { uuid: cfg.uuid, name: cfg.walletName, icon: cfg.icon, rdns: cfg.rdns },
        provider,
      })
      const announce = () =>
        window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }))

      window.addEventListener('eip6963:requestProvider', announce)
      announce()

      // Also exposed the classic way, like a real extension; the app dedupes on object identity.
      ;(window as unknown as Record<string, unknown>).ethereum = provider
    },
    {
      address,
      chainIdHex: `0x${chainId.toString(16)}`,
      walletName,
      uuid: WALLET_UUID,
      rdns: WALLET_RDNS,
      icon: WALLET_ICON,
      bridge: SIGN_BRIDGE,
      failOn: failOn as Record<string, string>,
    },
  )

  return { account, address, walletName }
}

/**
 * Change (or clear with `null`) a forced failure after the page is already running. Needed for
 * paths only reachable after an earlier failure, e.g. the explicit "Switch network" button.
 */
export async function setWalletFailure(
  page: Page,
  method: FailableMethod,
  failure: WalletFailure | null,
): Promise<void> {
  await page.evaluate(
    ({ method, failure }) => {
      const table = (window as unknown as Record<string, Record<string, string>>).__mpcQaFailOn
      if (!table) throw new Error('no mock wallet is injected on this page')
      if (failure === null) delete table[method]
      else table[method] = failure
    },
    { method, failure },
  )
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 4. Network stubs
// ════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Third-party analytics served as empty scripts, so DNS blockers do not change test outcomes.
 * 🔴 Only third-party analytics — never stub the app's own origin or /api/**.
 */
const ANALYTICS_HOSTS = [
  '**://*.googletagmanager.com/**',
  '**://*.google-analytics.com/**',
  '**://*.analytics.google.com/**',
]

export async function stubAnalytics(page: Page): Promise<void> {
  for (const pattern of ANALYTICS_HOSTS) {
    await page.route(pattern, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/javascript',
        body: '/* analytics stubbed by the QA agent */',
      }),
    )
  }
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 5. Capability probe
// ════════════════════════════════════════════════════════════════════════════════════════════════

/** Whether state-changing requests from this origin survive the app's `guardSameOrigin`. */
export type Capabilities = { sameOriginWrites: boolean; reason?: string }

let cachedCaps: Promise<Capabilities> | undefined

/** Probed once per worker; the answer is a property of the deployment, not of any one test. */
export function capabilities(): Promise<Capabilities> {
  cachedCaps ??= probeCapabilities()
  return cachedCaps
}

async function probeCapabilities(): Promise<Capabilities> {
  const t = target()
  const context = await apiRequest.newContext({ baseURL: t.baseUrl })
  try {
    // The cheapest guarded write: issues a nonce into the session and touches nothing else.
    const res = await context.post('/api/auth/nonce', { headers: { origin: t.baseUrl } })

    if (res.status() === 403 && (await res.text()).includes('cross_origin')) {
      return {
        sameOriginWrites: false,
        reason:
          `${t.baseUrl} rejects its own origin (403 cross_origin) — its APP_ORIGIN is set to a ` +
          `different deployment, so no sign-in or write can succeed from this URL`,
      }
    }

    return res.ok()
      ? { sameOriginWrites: true }
      : {
          sameOriginWrites: false,
          reason: `POST /api/auth/nonce answered ${res.status()} on ${t.baseUrl}`,
        }
  } catch (e) {
    return {
      sameOriginWrites: false,
      reason: `could not reach ${t.baseUrl}: ${e instanceof Error ? e.message : String(e)}`,
    }
  } finally {
    await context.dispose()
  }
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 6. App copy (wallet-related strings only)
// ════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * 🔴 These are match keys, not prose — do not paraphrase. Ellipses are the single character `…`.
 * Source of truth: globalmpc-webapp/lib/messages/en.ts
 */
export const copy = {
  ui: {
    copyAddress: 'Copy address',
  },
  landing: {
    join: 'Join Unity',
  },
  join: {
    title: 'Join',

    // Step names (the progressbar's accessible name).
    stepWallet: 'Wallet',
    stepSign: 'Sign',
    stepSocial: 'Community',

    // Connect step
    connect: 'Connect Wallet',
    connectDetecting: 'Looking for installed wallets…',
    connectWalletConnect: 'WalletConnect',
    connectOtherWallets: 'View other wallets',
    connecting: 'Connecting…',
    connectDefaultWallet: 'Browser wallet',

    // Sign step
    signIn: 'Sign in',
    signing: 'Sign in wallet…',
    signingHint: 'Confirm the signature in your wallet.',
    switchChain: 'Switch network',

    // Failure copy
    failRejected: 'The request was cancelled in your wallet. Try again when you are ready.',
    /** On the connect axis this appears instead of `failNoWallet` (WalletConnect always exists). */
    failNoWalletWithWc: 'No browser wallet found. On mobile, connect with WalletConnect.',
    failNoWallet: 'No browser wallet found. Install a wallet extension and refresh.',
    failLocked: 'Your wallet is locked. Unlock it and try again.',
    failPending: 'Your wallet already has a pending request. Check that window.',
    failUnknown: 'Could not connect. Please try again shortly.',
    signRejected: 'The signature was cancelled in your wallet. Please try again.',
    signFailed: 'Could not sign in. Please try again.',
  },
} as const

/** Switch-chain failure copy, built from the chain's display name. */
export const switchCopy = {
  wrongChain: (chain: string) =>
    `Could not switch to the ${chain} network. Switch it in your wallet and try again.`,
  switchRejected: (chain: string) => `Network switch cancelled. Signing is only possible on ${chain}.`,
} as const

/** The accessible name of the address chip. */
export const addressChipName = (address: string): string =>
  `${copy.ui.copyAddress} ${address.toLowerCase()}`

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 7. Page object (wallet step)
// ════════════════════════════════════════════════════════════════════════════════════════════════

export class JoinSheet {
  constructor(private readonly page: Page) {}

  /** Matched by role, not text — a same-text placeholder `<span role="status">` also exists. */
  cta(): Locator {
    return this.page.getByRole('main', { name: 'Home', exact: true }).getByRole('button', { name: copy.landing.join, exact: true })
  }

  sheet(): Locator {
    return this.page.getByRole('dialog', { name: copy.join.title })
  }

  /** Carries the current step's name as its accessible name. */
  stepBar(): Locator {
    return this.sheet().getByRole('progressbar')
  }

  detecting(): Locator {
    return this.sheet().getByText(copy.join.connectDetecting)
  }

  /** A wallet row; the label is the name the wallet announced over EIP-6963. */
  walletRow(name: string): Locator {
    return this.sheet().getByRole('button', { name })
  }

  walletConnectRow(): Locator {
    return this.sheet().getByRole('button', { name: copy.join.connectWalletConnect })
  }

  addressChip(address: string): Locator {
    return this.sheet().getByRole('button', { name: addressChipName(address) })
  }

  signInButton(): Locator {
    return this.sheet().getByRole('button', { name: copy.join.signIn, exact: true })
  }

  switchChainButton(): Locator {
    return this.sheet().getByRole('button', { name: copy.join.switchChain })
  }

  /** Failure copy is rendered as `role="alert"`. */
  error(): Locator {
    return this.sheet().getByRole('alert')
  }

  async open(): Promise<void> {
    const consent = this.page.getByRole('dialog', { name: 'Audience measurement choice', exact: true })
    const needsChoice = await consent.waitFor({ state: 'visible', timeout: 3_000 }).then(() => true, () => false)
    if (needsChoice) await consent.getByRole('button', { name: 'Reject', exact: true }).click()
    await this.cta().click()
    await expect(this.sheet()).toBeVisible()
  }

  /** Click the mock wallet's row once the injected-wallet probe has found it. */
  async connectWith(walletName: string): Promise<void> {
    const row = this.walletRow(walletName)
    await expect(row).toBeVisible({ timeout: 15_000 })
    await row.click()
  }

  async expectStep(stepName: string): Promise<void> {
    await expect(this.stepBar()).toHaveAccessibleName(stepName, { timeout: 20_000 })
  }
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 8. Tests
// ════════════════════════════════════════════════════════════════════════════════════════════════

const t = target()
const CHAIN = chainName(t)

test.use({ baseURL: t.baseUrl })
test.describe.configure({ mode: 'serial' })
test.describe.configure({ timeout: 60_000 })

// ── T1 — wallet connect ─────────────────────────────────────────────────────────────────────────

test.describe('Wallet discovery', () => {
  test.skip(
    () => !process.env.QA_SEED_PHRASE,
    'QA_SEED_PHRASE is not set — there is no seed to derive a test wallet from',
  )

  test('W01 - Display Trust Wallet and WalletConnect options', async ({ page }, testInfo) => {
    await stubAnalytics(page)
    const wallet = await injectTestWallet(page, {
      account: getConfiguredWallet(),
      chainId: t.chainId,
    })

    await page.goto('/')
    const sheet = new JoinSheet(page)
    await sheet.open()

    // The row exists only because the mock announced itself over EIP-6963 with a name.
    await expect(sheet.walletRow(wallet.walletName)).toBeVisible({ timeout: 15_000 })
    // WalletConnect is always offered too.
    await expect(sheet.walletConnectRow()).toBeVisible()
  })
})

// ── T1 — SIWE sign-in (needs a target that accepts same-origin writes) ──────────────────────────

test.describe('Wallet sign-in and recovery', () => {
  test.setTimeout(180_000)
  test.beforeEach(async () => {
    test.skip(
      !process.env.QA_SEED_PHRASE,
      'QA_SEED_PHRASE is not set — there is no seed to derive a test wallet from',
    )
    const caps = await capabilities()
    test.skip(!caps.sameOriginWrites, caps.reason ?? 'the target refuses writes from this origin')
    test.skip(
      Boolean(process.env.CI) && !t.isTestnet,
      `refusing to write sign-in data to a mainnet target (chain ${t.chainId}) from CI`,
    )
  })

  test('W02 - Sign in with Trust Wallet and open Digging', async ({ page }, testInfo) => {
    await stubAnalytics(page)
    const wallet = await injectTestWallet(page, {
      account: getConfiguredWallet(),
      chainId: t.chainId,
    })

    await page.goto('/')
    const sheet = new JoinSheet(page)
    await sheet.open()
    await sheet.expectStep(copy.join.stepWallet)

    // One click connects and signs.
    await sheet.connectWith(wallet.walletName)

    await expect.poll(async () => {
      const response = await page.request.get('/api/auth/session')
      if (!response.ok()) return null
      return (await response.json()).address
    }, { timeout: 60_000 }).toBe(wallet.address.toLowerCase())

    const session = await page.request.get('/api/auth/session')
    expect(session.ok(), 'GET /api/auth/session should succeed').toBe(true)
    expect((await session.json()).address).toBe(wallet.address.toLowerCase())

    await page.goto('/?view=dig')
    await expect(page).toHaveURL(/\?view=dig/)
    await expect(page.getByRole('heading', { name: 'Digging', exact: true })).toBeVisible()
    // Intentional viewing pause after the connected Digging screen is ready.
    await page.waitForTimeout(10_000)
    const connectedSession = await page.request.get('/api/auth/session')
    expect((await connectedSession.json()).address).toBe(wallet.address.toLowerCase())
    await page.screenshot({ path: testInfo.outputPath('connected-wallet-digging.png'), fullPage: true })
  })

  test('W03 - Display the connected account and recover from cancelled signing', async ({ page }, testInfo) => {
    await stubAnalytics(page)
    // Failing the signature holds the flow on the sign step, where the address is shown.
    const wallet = await injectTestWallet(page, {
      account: getConfiguredWallet(),
      chainId: t.chainId,
      failOn: { personal_sign: 'rejected' },
    })

    await page.goto('/')
    const sheet = new JoinSheet(page)
    await sheet.open()
    await sheet.connectWith(wallet.walletName)

    await sheet.expectStep(copy.join.stepSign)
    await expect(sheet.addressChip(wallet.address)).toBeVisible()
    await expect(sheet.signInButton()).toBeVisible()

    // Confirm the rejection, then allow the retry to sign normally.
    await expect(sheet.error()).toHaveText(copy.join.signRejected)
    await setWalletFailure(page, 'personal_sign', null)
    await sheet.signInButton().click()
    await expect.poll(async () => {
      const response = await page.request.get('/api/auth/session')
      if (!response.ok()) return null
      return (await response.json()).address
    }, { timeout: 60_000 }).toBe(wallet.address.toLowerCase())
    await expect(sheet.error()).not.toBeVisible()

    await page.goto('/?view=dig')
    await expect(page.getByRole('heading', { name: 'Digging', exact: true })).toBeVisible()
    // Intentional viewing pause after the connected Digging screen is ready.
    await page.waitForTimeout(10_000)

  })
})

// ── T1f — the failure table (connect / sign / switch × 5 reasons) ───────────────────────────────

const ERROR_CASE_NAMES: Record<WalletFailure, string> = {
  rejected: 'rejected request',
  pending: 'pending request',
  locked: 'locked wallet',
  no_wallet: 'unavailable wallet',
  unknown: 'unexpected wallet error',
}
const ERROR_CASE_ORDER: WalletFailure[] = ['rejected', 'pending', 'locked', 'no_wallet', 'unknown']
const errorCaseName = (start: number, action: string, failure: WalletFailure): string =>
  `W${String(start + ERROR_CASE_ORDER.indexOf(failure)).padStart(2, '0')} - ${action}: ${ERROR_CASE_NAMES[failure]}`

type Cell = { failure: WalletFailure; expected: string }

const CONNECT_CELLS: Cell[] = [
  { failure: 'rejected', expected: copy.join.failRejected },
  { failure: 'pending', expected: copy.join.failPending },
  { failure: 'locked', expected: copy.join.failLocked },
  { failure: 'no_wallet', expected: copy.join.failNoWalletWithWc },
  { failure: 'unknown', expected: copy.join.failUnknown },
]

const SIGN_CELLS: Cell[] = [
  { failure: 'rejected', expected: copy.join.signRejected },
  { failure: 'pending', expected: copy.join.failPending },
  { failure: 'locked', expected: copy.join.failLocked },
  { failure: 'no_wallet', expected: copy.join.signFailed },
  { failure: 'unknown', expected: copy.join.signFailed },
]

const SWITCH_CELLS: Cell[] = [
  { failure: 'rejected', expected: switchCopy.switchRejected(CHAIN) },
  { failure: 'pending', expected: copy.join.failPending },
  { failure: 'locked', expected: copy.join.failLocked },
  { failure: 'no_wallet', expected: switchCopy.wrongChain(CHAIN) },
  { failure: 'unknown', expected: switchCopy.wrongChain(CHAIN) },
]

/** A chain the app is not built for, so the flow is forced down the switch path. */
const WRONG_CHAIN = 1

test.describe('Wallet connection errors', () => {
  test.skip(() => !process.env.QA_SEED_PHRASE, 'QA_SEED_PHRASE is not set')

  for (const { failure, expected } of CONNECT_CELLS) {
    test(errorCaseName(4, 'Explain failed wallet connection', failure), async ({ page }, testInfo) => {
      await stubAnalytics(page)
      const wallet = await injectTestWallet(page, {
        account: getConfiguredWallet(),
        chainId: t.chainId,
        failOn: { eth_requestAccounts: failure },
      })

      await page.goto('/')
      const sheet = new JoinSheet(page)
      await sheet.open()
      await sheet.connectWith(wallet.walletName)

      await expect(sheet.error()).toHaveText(expected)
      // The flow must not advance on a failed connect.
      await sheet.expectStep(copy.join.stepWallet)
    })
  }
})

/**
 * The explicit "Switch network" button only appears after an automatic switch has failed, so each
 * test fails the switch twice — once to raise the button, then with the reason under test.
 */
test.describe('Wallet network errors', () => {
  test.skip(() => !process.env.QA_SEED_PHRASE, 'QA_SEED_PHRASE is not set')

  for (const { failure, expected } of SWITCH_CELLS) {
    test(errorCaseName(9, 'Explain failed network switch', failure), async ({ page }, testInfo) => {
      await stubAnalytics(page)
      const wallet = await injectTestWallet(page, {
        account: getConfiguredWallet(),
        chainId: WRONG_CHAIN,
        failOn: { wallet_switchEthereumChain: 'unknown' },
      })

      await page.goto('/')
      const sheet = new JoinSheet(page)
      await sheet.open()
      await sheet.connectWith(wallet.walletName)

      await expect(sheet.switchChainButton()).toBeVisible()

      await setWalletFailure(page, 'wallet_switchEthereumChain', failure)
      await sheet.switchChainButton().click()

      await expect(sheet.error()).toHaveText(expected)
    })
  }
})

test.describe('Wallet connection network cancellation', () => {
  test.skip(() => !process.env.QA_SEED_PHRASE, 'QA_SEED_PHRASE is not set')

  /**
   * Records current behaviour, not an ideal one: a 4001 rejection of the switch wagmi performs
   * inside `connect` surfaces on the connect axis ("request was cancelled").
   */
  test('W14 - Show cancellation when network switching is rejected during connection', async ({ page }, testInfo) => {
    await stubAnalytics(page)
    const wallet = await injectTestWallet(page, {
      account: getConfiguredWallet(),
      chainId: WRONG_CHAIN,
      failOn: { wallet_switchEthereumChain: 'rejected' },
    })

    await page.goto('/')
    const sheet = new JoinSheet(page)
    await sheet.open()
    await sheet.connectWith(wallet.walletName)

    await expect(sheet.error()).toHaveText(copy.join.failRejected)
  })
})

test.describe('Wallet signature errors', () => {
  test.beforeEach(async () => {
    test.skip(!process.env.QA_SEED_PHRASE, 'QA_SEED_PHRASE is not set')
    // The signature axis is only reached after /api/auth/nonce succeeds.
    const caps = await capabilities()
    test.skip(!caps.sameOriginWrites, caps.reason ?? 'the target refuses writes from this origin')
  })

  for (const { failure, expected } of SIGN_CELLS) {
    test(errorCaseName(15, 'Explain failed message signing', failure), async ({ page }, testInfo) => {
      await stubAnalytics(page)
      const wallet = await injectTestWallet(page, {
        account: getConfiguredWallet(),
        chainId: t.chainId,
        failOn: { personal_sign: failure },
      })

      await page.goto('/')
      const sheet = new JoinSheet(page)
      await sheet.open()
      await sheet.connectWith(wallet.walletName)

      await expect(sheet.error()).toHaveText(expected)
      // A failed signature holds the flow on the sign step.
      await sheet.expectStep(copy.join.stepSign)
    })
  }
})
