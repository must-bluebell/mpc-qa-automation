import { expect, test as base, type APIRequestContext, type Page, type TestInfo } from '@playwright/test'
import { english, generateMnemonic, mnemonicToAccount, type HDAccount, type LocalAccount } from 'viem/accounts'
import { createSiweMessage } from 'viem/siwe'
import { chainName, target } from '../../config/target'
import { appOrigin, call, requireWrites } from '../../fixtures/api'
import { stubAnalytics } from '../../fixtures/network'
import { connectConfiguredWallet } from '../../fixtures/connected-wallet'
import { injectTestWallet, type InjectWalletOptions, type MockWallet } from '../../fixtures/wallet'
import { pendingRequestCopy, rejectedSwitchCopy, unavailableSigningWalletCopy } from '../../pages/copy'
import { JoinSheet } from '../../pages/JoinSheet'

/**
 * Shared support for the module test cases in testplans/app-module-test-cases.md.
 *
 * Every test title starts with the plan ID so the report can be matched to the plan. Test data here
 * is real-format and throwaway: no real person's address or inbox, and no key material.
 *
 * Three kinds of case:
 *  - automated: runs as written;
 *  - gated: needs a signed-in wallet or writes state, so it calls requireWrites() and runs only on
 *    the isolated stack (QA_ALLOW_WRITES=1);
 *  - todo(): the behaviour cannot be observed from a browser alone (a real inbox, the clock, a
 *    second Telegram account, a state fixture). It stays in the file as a skipped test with the
 *    reason, so it is visible in every report rather than silently absent.
 */

/** Session creation and authenticated cases are confined to the disposable local stack. */
export function requireModuleWrites(): void {
  requireWrites()
  test.skip(!['web-isolated', 'local-docker'].includes(process.env.QA_ENVIRONMENT ?? ''),
    'Authenticated module checks require an isolated environment.')
  test.skip(!['localhost', '127.0.0.1', '[::1]'].includes(new URL(target().baseUrl).hostname),
    'Authenticated module checks require a loopback target.')
}

export const usesMineTabs = () => process.env.QA_NAVIGATION === 'activities'

/** Copy from globalmpc-webapp src/shared/messages/en.ts. Match keys: keep them byte-for-byte. */
export const COPY = {
  rejected: 'The request was cancelled in your wallet. Try again when you are ready.',
  pending: pendingRequestCopy,
  locked: 'Your wallet is locked. Unlock it and try again.',
  connectUnknown: 'Could not connect. Please try again shortly.',
  signRejected: 'The signature was cancelled in your wallet. Please try again.',
  signFailed: 'Could not sign in. Please try again.',
  signUnavailable: unavailableSigningWalletCopy,
  switchRejected: rejectedSwitchCopy,
  wrongChain: (chain: string) => `Could not switch to the ${chain} network. Switch it in your wallet and try again.`,
  disposableEmail: 'Temporary or disposable email addresses are not accepted. Please use a permanent address.',
  emailTaken: 'Another wallet is already using this email.',
  wrongCodeLeft: (n: number) => `Wrong code. ${n} attempts left.`,
  noCode: 'No code has been issued. Request a code first.',
  alreadyRegistered: 'This wallet is already verified.',
  checkedIn: 'You have checked in today.',
  justDug: 'Just dug',
  noWallet: 'No browser wallet found. Install a wallet extension and refresh.',
} as const

/** Real-format addresses used by the email cases. */
export const EMAIL = {
  permanent: 'ana.perez@gmail.com',
  mixedCase: 'Ana.Perez@GMail.com',
  alias: 'ana.perez+mpc1@gmail.com',
  lookalike: 'ana.perez@not10mail.org',
  disposable: 'sam@mailinator.com',
  disposableSubdomain: 'sam@x.mailinator.com',
  disposableGuerrilla: 'sam@guerrillamail.com',
  tempmail: 'sam@tempmail.com',
  unicodeDomain: 'ana@bücher.de',
  /** 254 characters: 242 local + "@example.com". Exactly the RFC 5321 path limit. */
  maxLength: `${'a'.repeat(242)}@example.com`,
  /** 255 characters, one over the limit. */
  overLength: `${'a'.repeat(243)}@example.com`,
} as const

export const CODE_BVA = ['12345', '123456', '1234567', '12345a', '004821'] as const
export const INJECTION_EMAILS = [
  'ana@x.com\r\nBcc: a@b.com',
  '"a b"@x.com',
  'a+<script>@x.com',
  'a@x.com<script>alert(1)</script>',
] as const

export const freshAccount = (): HDAccount => mnemonicToAccount(generateMnemonic(english))

/** Unique, permanent-looking address for one run (so cooldowns from earlier runs never collide). */
export const uniqueEmail = (tag: string) => `qa.${tag}.${Date.now()}.${Math.floor(Math.random() * 1e6)}@example.com`

export async function sessionAddress(page: Page): Promise<string | null> {
  const response = await page.request.get('/api/auth/session', { maxRetries: 2 })
  if (!response.ok()) return null
  return ((await response.json()) as { address?: string | null }).address ?? null
}

/** Records page errors, console errors and any hydration warning. Third-party resource misses are excluded. */
export function watchErrors(page: Page): string[] {
  const problems: string[] = []
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    const text = message.text()
    if (/hydrat/i.test(text)) problems.push(`hydration: ${text}`)
    else if (message.type() === 'error' && !/Failed to load resource/.test(text)) problems.push(`console: ${text}`)
  })
  return problems
}

/** Connects a wallet that does not yet have a session. Stops wherever the flow stops. */
export async function connectWalletOnly(page: Page, options: Partial<InjectWalletOptions> = {}): Promise<MockWallet> {
  const wallet = await injectTestWallet(page, { account: freshAccount(), chainId: target().chainId, ...options })
  await stubAnalytics(page)
  await page.goto('/')
  const sheet = new JoinSheet(page)
  await sheet.open()
  await sheet.connectWith(wallet.walletName)
  return wallet
}

/** Connects and signs in a fresh wallet. Requires writes (creates a session). */
export async function connectFresh(page: Page): Promise<MockWallet> {
  requireModuleWrites()
  const wallet = await connectWalletOnly(page)
  await expect.poll(() => sessionAddress(page), { timeout: 60_000 }).toBe(wallet.address.toLowerCase())
  return wallet
}

/** Builds a SIWE message the way the app expects. Overrides exist for the negative cases. */
export async function siweMessage(account: LocalAccount, nonce: string, overrides: { domain?: string; chainId?: number } = {}) {
  const origin = new URL(appOrigin())
  return createSiweMessage({
    address: account.address,
    chainId: overrides.chainId ?? target().chainId,
    domain: overrides.domain ?? origin.host,
    scheme: origin.protocol.replace(':', ''),
    uri: origin.origin,
    version: '1',
    nonce,
    issuedAt: new Date(),
    expirationTime: new Date(Date.now() + 300_000),
  })
}

/** Fetches a nonce on this request context (cookies are kept for the verify call that follows). */
export async function fetchNonce(request: APIRequestContext, info: TestInfo): Promise<string> {
  requireModuleWrites()
  const res = await call(request, info, 'POST', '/api/auth/nonce', { body: {} })
  if (res.status !== 200 || typeof res.json?.nonce !== 'string') throw new Error(`nonce failed: ${res.status}`)
  return res.json.nonce
}

export async function verifySiwe(request: APIRequestContext, info: TestInfo, message: string, signature: `0x${string}`) {
  requireModuleWrites()
  return call(request, info, 'POST', '/api/auth/verify', { body: { message, signature } })
}

/** Records a case the browser cannot observe; it appears as skipped with the reason in every report. */
export function todo(id: string, title: string, reason: string): void {
  test(`${id} - ${title}`, { tag: ['@manual'] }, () => {
    test.skip(true, reason)
  })
}

/** Skips one test (inside its body) when a precondition is not met on this target. */
export function skipWhen(condition: boolean, reason: string): void {
  test.skip(condition, reason)
}

export const CHAIN_NAME = () => chainName(target())

/** The network-switch button in the Join sheet (the page also carries a same-named control). */
export const switchNetwork = (page: Page) => new JoinSheet(page).switchChainButton()

export const test = base.extend<{ member: MockWallet; newcomer: MockWallet }>({
  member: async ({ page }, use) => {
    requireModuleWrites()
    skipWhen(!process.env.QA_SEED_PHRASE, 'Configured member wallet is missing (QA_SEED_PHRASE).')
    await use(await connectConfiguredWallet(page))
  },
  newcomer: async ({ page }, use) => {
    requireModuleWrites()
    const wallet = await connectFresh(page)
    await new JoinSheet(page).expectStep('Community')
    await use(wallet)
  },
})

export { expect }
export type { APIRequestContext, Page, TestInfo }
