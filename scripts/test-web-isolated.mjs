#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ROOT } from '../pipeline/lib/env.mjs'
import { webTestEnvironment } from '../pipeline/lib/web-isolated.mjs'
import { stackStatus, stackUp } from '../pipeline/adapters/local-stack.mjs'
import { acquireLock } from '../pipeline/lib/lock.mjs'
import { newRunId } from '../pipeline/lib/run-store.mjs'
import { runProcess } from '../pipeline/lib/proc.mjs'
import { prepareTestData } from '../pipeline/lib/test-data.mjs'
import { randomInt } from 'node:crypto'
import { mnemonicToAccount } from 'viem/accounts'

const exec = promisify(execFile)
const env = webTestEnvironment()
// Both profile aliases now share the scheduler's chains and database.
const lock = acquireLock(newRunId('web-isolated'))
if (!(await stackStatus(env)).healthy) {
  const result = await stackUp(env, { build: false })
  if (result.code !== 0) throw new Error('Isolated web stack could not start; existing volumes were preserved.')
}
const container = `${env.stack.composeProject}-web-1`
console.log('Preparing a fresh local member with real registration and certificates…')
// Read only the disposable chain's mnemonic into the child environment; never log it or .env.
const { stdout: mnemonic } = await exec('docker', ['exec', container, 'node', '-e', 'process.stdout.write(process.env.ANVIL_MNEMONIC)'])
const index = randomInt(10_000, 1_000_000_000)
const wallet = mnemonicToAccount(mnemonic.trim(), { addressIndex: index })
process.env.QA_SEED_PHRASE = mnemonic.trim()
process.env.WALLET_ADDRESS = wallet.address
process.env.WALLET_ADDRESS_INDEX = String(index)
// Host-side setup stops with this process; no in-container mutating fixture can outlive its lock.
const prepared = await prepareTestData(env)
if (prepared.status !== 'ready') throw new Error('Local member preparation failed; see isolated stack health.')
const result = await runProcess('npx', ['playwright', 'test', '--project=chromium', ...process.argv.slice(2)], {
  cwd: ROOT, passSecrets: true, timeoutMs: 1_800_000, env: {
    BASE_URL: env.baseUrl, QA_APP_ORIGIN: env.appOrigin, QA_CHAIN_ID: String(env.chainId), QA_CHAIN_NAME: env.chainName,
    QA_ALLOW_WRITES: '1', QA_ENVIRONMENT: env.name, QA_NAVIGATION: env.navigation,
    QA_WEB_FIXTURE_CONTAINER: container,
    QA_SEED_PHRASE: mnemonic.trim(), WALLET_ADDRESS: wallet.address, WALLET_ADDRESS_INDEX: String(index),
  },
})
lock.release()
process.exitCode = result.code ?? 1
