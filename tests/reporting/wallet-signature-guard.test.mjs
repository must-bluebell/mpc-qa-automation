import test from 'node:test'
import assert from 'node:assert/strict'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { recoverTypedDataAddress, recoverMessageAddress, stringToHex } from 'viem'
import { createSiweMessage } from 'viem/siwe'
import { target } from '../../config/target.ts'
import { injectTestWallet } from '../../fixtures/wallet.ts'

test.beforeEach(t => {
  const previous = process.env.BASE_URL
  process.env.BASE_URL = 'https://waitlist.example'
  t.after(() => {
    if (previous === undefined) delete process.env.BASE_URL
    else process.env.BASE_URL = previous
  })
})

const payload = {
  domain: { name: 'Signature guard test', version: '1', chainId: 204 },
  types: { Approval: [{ name: 'count', type: 'uint256' }] },
  primaryType: 'Approval', message: { count: '3' },
}
async function bridgeFixture(account, beforeSignTypedData) {
  let bridge
  const origin = new URL(target().baseUrl).origin
  const frame = { url: () => origin }
  const page = {
    url: () => origin,
    mainFrame: () => frame,
    exposeBinding: async (_name, callback) => { bridge = callback },
    addInitScript: async () => {},
  }
  await injectTestWallet(page, { account, chainId: target().chainId, beforeSignTypedData })
  return { page, frame, send: (request, source = {page, frame}) => bridge(source, request) }
}
async function signingBridge(account, beforeSignTypedData) {
  const fixture = await bridgeFixture(account, beforeSignTypedData)
  return () => fixture.send({ method: 'eth_signTypedData_v4', params: [account.address, JSON.stringify(payload)] })
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


function siwe(account, overrides={}) {
  const origin=new URL(target().baseUrl)
  return createSiweMessage({address:account.address,chainId:target().chainId,domain:origin.host,
    scheme:origin.protocol.slice(0,-1),uri:origin.origin,version:'1',nonce:'testnonce123',
    statement:'MPC Waitlist sign-in',issuedAt:new Date(),expirationTime:new Date(Date.now()+300000),...overrides})
}

test('the bridge signs only the expected SIWE request and binds the signature to it',async()=>{
  const account=privateKeyToAccount(generatePrivateKey()),fixture=await bridgeFixture(account)
  const message=siwe(account)
  const signature=await fixture.send({method:'personal_sign',params:[stringToHex(message),account.address]})
  assert.equal((await recoverMessageAddress({message,signature})).toLowerCase(),account.address.toLowerCase())
})

test('arbitrary messages, altered SIWE fields, and unsupported typed requests never reach the signer',async()=>{
  const account=privateKeyToAccount(generatePrivateKey())
  let signed=0
  const fixture=await bridgeFixture({...account,signMessage:async()=>{signed++;return 'bad'},signTypedData:async()=>{signed++;return 'bad'}})
  const messages=[
    'Approve access to my assets',siwe(account,{domain:'attacker.example'}),
    siwe(account,{uri:'https://attacker.example'}),siwe(account,{chainId:target().chainId+1}),
    siwe(account,{statement:'Approve a transfer'}),siwe(account,{resources:['https://attacker.example']}),
    siwe(account,{expirationTime:new Date(Date.now()-1000)}),siwe(account,{expirationTime:new Date(Date.now()+86400000)}),
    siwe(account,{issuedAt:new Date(Date.now()+600000)}),siwe(account)+'\nApprove a transfer',
  ]
  for(const message of messages)await assert.rejects(fixture.send({method:'personal_sign',params:[stringToHex(message),account.address]}))
  await assert.rejects(fixture.send({method:'personal_sign',params:[stringToHex(siwe(account)),'0x0000000000000000000000000000000000000001']}))
  await assert.rejects(fixture.send({method:'personal_sign',params:['0xzz',account.address]}))
  await assert.rejects(fixture.send({method:'eth_signTypedData_v4',params:[account.address,JSON.stringify(payload)]}))
  assert.equal(signed,0)
})

test('signing refuses cross-origin pages and iframe callers even when the message is valid',async()=>{
  const account=privateKeyToAccount(generatePrivateKey()),fixture=await bridgeFixture(account)
  const request={method:'personal_sign',params:[stringToHex(siwe(account)),account.address]}
  await assert.rejects(fixture.send(request,{page:fixture.page,frame:{url:()=>new URL(target().baseUrl).origin}}))
  fixture.frame.url=()=> 'https://attacker.example'
  await assert.rejects(fixture.send(request))
})


test('the production Unity origin signs its expected purpose and refuses the waitlist purpose',async t=>{
  const previous=process.env.BASE_URL
  process.env.BASE_URL='https://app.globalmpc.tech'
  t.after(()=>{if(previous===undefined)delete process.env.BASE_URL;else process.env.BASE_URL=previous})
  const account=privateKeyToAccount(generatePrivateKey()),fixture=await bridgeFixture(account)
  const message=siwe(account,{statement:'MPC Unity sign-in'})
  const signature=await fixture.send({method:'personal_sign',params:[stringToHex(message),account.address]})
  assert.equal((await recoverMessageAddress({message,signature})).toLowerCase(),account.address.toLowerCase())
  await assert.rejects(fixture.send({method:'personal_sign',params:[stringToHex(siwe(account)),account.address]}))
})
