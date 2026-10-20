import type { HDAccount } from 'viem'
import { getAddress, isAddress } from 'viem'
import { mnemonicToAccount } from 'viem/accounts'

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
