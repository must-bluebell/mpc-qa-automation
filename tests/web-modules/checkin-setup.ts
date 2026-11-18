import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomInt } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { mnemonicToAccount } from 'viem/accounts'
import { expect, test } from '@playwright/test'
import { requireWrites } from '../../fixtures/api'
import { target } from '../../config/target'

/** Prepare a separate real member for each check-in case, including retries. */
export async function prepareCheckInAccount() {
  requireWrites()
  test.skip(!process.env.QA_SEED_PHRASE, 'Configured member wallet is missing (QA_SEED_PHRASE).')
  expect(['web-isolated', 'local-docker']).toContain(process.env.QA_ENVIRONMENT)
  expect(['localhost', '127.0.0.1']).toContain(new URL(target().baseUrl).hostname)
  const index = randomInt(10_000, 1_000_000_000)
  const account = mnemonicToAccount(process.env.QA_SEED_PHRASE!, { addressIndex: index })
  // The child owns its wallet settings; other tests retain their configured member.
  await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
    import { prepareTestData } from './pipeline/lib/test-data.mjs';
    import { webTestEnvironment } from './pipeline/lib/web-isolated.mjs';
    const env = webTestEnvironment();
    if (new URL(env.baseUrl).origin !== new URL(process.env.BASE_URL).origin
      || env.chainId !== Number(process.env.QA_CHAIN_ID)) throw new Error('Check-in fixture target mismatch');
    const result = await prepareTestData(env);
    if (result.status !== 'ready') throw new Error('Fresh check-in member preparation failed');
  `], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)), timeout: 180_000,
    env: { ...process.env, BASE_URL: target().baseUrl, QA_CHAIN_ID: String(target().chainId),
      WALLET_ADDRESS_INDEX: String(index), WALLET_ADDRESS: account.address },
  })
  return account
}
