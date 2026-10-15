import test from 'node:test'
import assert from 'node:assert/strict'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { recoverTypedDataAddress } from 'viem'
import { injectTestWallet } from '../../fixtures/wallet.ts'

const payload = {
  domain: { name: 'Signature guard test', version: '1', chainId: 204 },
  types: { Approval: [{ name: 'count', type: 'uint256' }] },
  primaryType: 'Approval', message: { count: '3' },
}
async function signingBridge(account, beforeSignTypedData) {
  let bridge
  await injectTestWallet({
    exposeFunction: async (_name, callback) => { bridge = callback },
    addInitScript: async () => {},
  }, { account, chainId: 204, beforeSignTypedData })
  return () => bridge({ method: 'eth_signTypedData_v4', params: [account.address, JSON.stringify(payload)] })
}

test('a refused typed-data request never reaches the signer', async () => {
  const account = privateKeyToAccount(generatePrivateKey())
  let signed = false
  const bridge = await signingBridge({ ...account, signTypedData: async () => { signed = true; return 'unexpected' } }, async () => {
    throw new Error('Unexpected signing domain')
  })
  await assert.rejects(bridge(), /Unexpected signing domain/)
  assert.equal(signed, false)
})

test('an approved request produces a real signature bound to the inspected payload', async () => {
  const account = privateKeyToAccount(generatePrivateKey())
  let checked = false
  const bridge = await signingBridge(account, async actual => {
    assert.deepEqual(actual, payload)
    checked = true
  })
  const signature = await bridge()
  assert.equal(checked, true)
  assert.equal((await recoverTypedDataAddress({ ...payload, signature })).toLowerCase(), account.address.toLowerCase())
})
