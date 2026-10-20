/**
 * Which deployment the suite is pointed at, and what that permits.
 *
 * The target is a single source of truth because two separate things depend on it: the mock wallet
 * reports the chain id from here, and signing tests use it to decide what can run.
 * Split them and the suite can end up signing on one chain while believing it is on another.
 */

/** BSC mainnet. Vercel Production and Staging both build against this. */
export const MAINNET = 56
/** BSC testnet. Vercel Preview builds against this. */
export const TESTNET = 97

export type Target = {
  baseUrl: string
  chainId: number
  displayName?: string
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
    displayName: process.env.QA_CHAIN_NAME || undefined,
    chainIdHex: `0x${chainId.toString(16)}`,
    isTestnet: chainId === TESTNET,
  }
}

/**
 * The chain name the app puts into switch-failure copy, i.e. `CHAIN.name`.
 *
 * 🔴 56 is **not** viem's default `BNB Smart Chain`. `lib/chain.ts` overrides it to the name
 *    MetaMask's registry expects, because the viem default raises a "display name doesn't match
 *    chain ID" warning in the wallet. 97 keeps viem's name, `BNB Smart Chain Testnet`
 *    (verified against preview 2026-08-18). (globalmpc-webapp/lib/chain.ts:100)
 */
const CHAIN_NAMES: Record<number, string> = {
  [MAINNET]: 'BNB Chain',
  [TESTNET]: 'BNB Smart Chain Testnet',
}

export function chainName(t: Target = target()): string {
  const name = t.displayName || CHAIN_NAMES[t.chainId]
  if (!name) throw new Error(`No chain display name recorded for chain ${t.chainId}`)
  return name
}
