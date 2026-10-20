import type { Page } from '@playwright/test'
import type { HDAccount, TypedDataDefinition } from 'viem'

/**
 * A mock browser wallet, injected before page load.
 *
 * ## Why this is not the mock the build spec described
 *
 * The spec's version set `window.ethereum` and returned the literal string `'0xmocksignature'`.
 * Both fail against this app, for reasons that are deliberate on the app's side:
 *
 * 🔴 **A bare `window.ethereum` renders no wallet to click.** `JoinFlow.visibleInjectedWallets()`
 *    filters out wagmi's declared catch-all connector (`type === 'injected' && id === 'injected'`)
 *    because it cannot tell the user which extension will answer. Only wallets that announced
 *    themselves over **EIP-6963** are listed. So this provider announces, with a name.
 *    (globalmpc-webapp/components/join/JoinFlow.tsx:98,108)
 *
 * 🔴 **The signature is verified for real.** `/api/auth/verify` enforces `/^0x[0-9a-fA-F]{130}$/`,
 *    burns a single-use nonce, and recovers the address with domain and chain binding. A fake
 *    string is rejected with `bad_signature_format`. So signing happens with the actual derived
 *    key — see the sign bridge below.
 *    (globalmpc-webapp/app/api/auth/verify/route.ts:11,69,72)
 *
 * ## How signing works
 *
 * The init script runs in the browser, where the private key must never go. Signing is therefore
 * bridged out to Node through `page.exposeFunction`: the page asks, this process signs, the
 * signature comes back. The key stays on this side.
 */

/** The five branches `classifyWalletError` recognises. globalmpc-webapp/lib/client/wallet-errors.ts:140 */
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
  /** Validate the actual EIP-712 request before the Node signer approves it. */
  beforeSignTypedData?: (payload: TypedDataDefinition) => void | Promise<void>
  failOn?: Partial<Record<FailableMethod, WalletFailure>>
}

const SIGN_BRIDGE = '__mpcQaSign'

/**
 * A stable UUIDv4 and reverse-DNS id. mipd (the EIP-6963 store wagmi uses) validates the shape of
 * both, so these are not free-form. `crypto.randomUUID` is deliberately not used: it is
 * secure-context only, and a fixed id also keeps the wallet row stable between runs.
 */
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
        const typedData = JSON.parse(payload) as TypedDataDefinition
        await options.beforeSignTypedData?.(typedData)
        return account.signTypedData(typedData)
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

      /**
       * Forced failures, kept mutable on `window` so a test can change them mid-flow.
       *
       * This is needed for paths that are only reachable *after* an earlier failure. The explicit
       * "Switch network" button, for one, appears only once an automatic switch has already failed
       * (`needsSwitch` ANDs `switchAttemptFailed`), so driving its failure copy means failing twice
       * with two different reasons. See `setWalletFailure`.
       */
      ;(window as unknown as Record<string, unknown>).__mpcQaFailOn = { ...cfg.failOn }

      /**
       * Error shapes chosen to land on each branch of `classifyWalletError`. That function reads
       * type, then EIP-1193 code, then copy — so codes are used where a standard defines one and
       * message text where it does not. Changing this wording can silently move a branch.
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
            // No standard code exists; matched by LOCKED_TEXT /\block(ed)?\b|unlock/i.
            return new Error('The wallet is locked. Unlock it and try again.')
          case 'no_wallet':
            // Matched by NO_WALLET_TEXT /provider not found|.../i.
            return new Error('provider not found')
          default:
            // Must match none of the copy patterns, so it lands on the honest `unknown` terminus.
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
              // Wallet sign-in tests do not send transactions. Reject unsupported sends.
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
       * EIP-6963 announcement. 🔴 **The listener is what actually matters.** This script runs at
       * document start, before wagmi exists, so the eager announce below reaches nobody. wagmi
       * dispatches `eip6963:requestProvider` when it initialises, and the re-announce is what it
       * hears. Drop the listener and the wallet list stays empty.
       */
      const detail = Object.freeze({
        info: { uuid: cfg.uuid, name: cfg.walletName, icon: cfg.icon, rdns: cfg.rdns },
        provider,
      })
      const announce = () =>
        window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }))

      window.addEventListener('eip6963:requestProvider', announce)
      announce()

      /**
       * Also exposed the classic way, on purpose. A real extension does both, and the app dedupes
       * the two connectors **on provider object identity** — so handing over the same object here
       * exercises that dedup path rather than dodging it. (JoinFlow.tsx:504-527)
       */
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
 * Change (or clear) a forced failure after the page is already running.
 *
 * Some of the app's failure copy sits behind an earlier failure — the explicit "Switch network"
 * button only exists once an automatic switch has failed — so reaching it means failing twice, for
 * two different reasons. A static `failOn` cannot express that.
 *
 * Pass `null` to clear, which is how a test lets the second attempt succeed.
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
