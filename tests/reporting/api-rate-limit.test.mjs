import test from 'node:test'
import assert from 'node:assert/strict'

async function fixture(){
  const module=await import('../../fixtures/api-rate-limit.mjs').catch(()=>({}))
  assert.equal(typeof module.createApiFetcher,'function')
  let time=0;const waits=[]
  const fetch=module.createApiFetcher({now:()=>time,wait:async ms=>{waits.push(ms);time+=ms}})
  return {fetch,waits,now:()=>time}
}
const response=(status,headers={})=>({status:()=>status,headers:()=>headers,dispose:async()=>{}})

test('authorized production authentication requests respect the per-route rate window',async()=>{
  const f=await fixture(),sent=[]
  for(let i=0;i<3;i++)await f.fetch('/api/auth/verify',async()=>{sent.push(f.now());return response(401)},{production:true})
  assert.deepEqual(sent,[0,6100,12200])
  await f.fetch('/api/auth/nonce',async()=>response(200),{production:true})
  await f.fetch('/api/auth/nonce',async()=>response(200),{production:true})
  assert.equal(f.waits.at(-1),3100)
})

test('explicit auth 429 rejection honors Retry-After once, keeping the eventual assertion response',async()=>{
  const f=await fixture();let sends=0
  const result=await f.fetch('/api/auth/verify',async()=>response(++sends===1?429:401,{'retry-after':'30'}),{production:true})
  assert.equal(sends,2);assert.equal(result.status(),401);assert.ok(f.now()>=30000)
})

test('pacing never retries application failures, other writes, unbounded waits or local test requests',async()=>{
  for(const [path,status,headers,production] of [
    ['/api/auth/verify',500,{},true],['/api/auth/verify',401,{},true],
    ['/my-mine/run',429,{'retry-after':'1'},true],['/api/auth/verify',429,{},true],
    ['/api/auth/verify',429,{'retry-after':'999'},true],['/api/auth/verify',429,{'retry-after':'1'},false],
  ]){
    const f=await fixture();let sends=0
    const result=await f.fetch(path,async()=>{sends++;return response(status,headers)},{production})
    assert.equal(sends,1);assert.equal(result.status(),status);assert.deepEqual(f.waits,[])
  }
})

test('repeated rate-limit rejection is returned as a failure response, never retried indefinitely',async()=>{
  const f=await fixture();let sends=0
  const result=await f.fetch('/api/auth/verify',async()=>{sends++;return response(429,{'retry-after':'1'})},{production:true})
  assert.equal(sends,2);assert.equal(result.status(),429)
})
