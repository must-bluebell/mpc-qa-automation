import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareWebRuntime, warmLoadEndpoints } from '../../pipeline/adapters/web-runtime.mjs'

const env={isolated:true,allowLoad:true,baseUrl:'http://localhost:3460',appOrigin:'http://localhost:3460',stack:{composeProject:'qa-test',verificationRuntime:true}}
test('load preparation restarts only the verified web container and waits for readiness',async()=>{
  const calls=[];let probes=0
  await prepareWebRuntime(env,{execImpl:async(command,args)=>{calls.push([command,...args]);return {stdout:args[0]==='inspect'?JSON.stringify({'com.docker.compose.project':'qa-test','com.docker.compose.service':'web'}):''}},
    fetchImpl:async()=>({ok:++probes>1}),wait:async()=>{}})
  assert.deepEqual(calls.map(c=>c.slice(0,2)),[['docker','inspect'],['docker','restart']])
  assert.deepEqual(calls[1],['docker','restart','--timeout','90','qa-test-web-1'])
  assert.equal(probes,2)
})
test('load preparation refuses a mismatched container before restarting it',async()=>{
  const calls=[]
  await assert.rejects(prepareWebRuntime(env,{execImpl:async(command,args)=>{calls.push(args[0]);return {stdout:JSON.stringify({'com.docker.compose.project':'other','com.docker.compose.service':'web'})}}}),/identity/)
  assert.deepEqual(calls,['inspect'])
})
test('load preparation refuses remote targets before any Docker operation',async()=>{
  await assert.rejects(prepareWebRuntime({...env,baseUrl:'https://example.com'},{execImpl:async()=>{throw new Error('Docker must not be called')}}),/isolated loopback/)
})
test('scenario preparation requires local writes and does not require load permission',async()=>{
  const calls=[]
  await prepareWebRuntime({...env,allowLoad:false,allowWrites:true},{purpose:'scenarios',
    execImpl:async(command,args)=>{calls.push(args[0]);return {stdout:args[0]==='inspect'?JSON.stringify({'com.docker.compose.project':'qa-test','com.docker.compose.service':'web'}):''}},
    fetchImpl:async()=>({ok:true})})
  assert.deepEqual(calls,['inspect','restart'])
})
test('warmup covers every measured endpoint with real session and origin boundaries',async()=>{
  const calls=[]
  await warmLoadEndpoints(env,{cookie:'private-session'},['GET /api/home','GET /api/auth/session','GET /api/notifications','POST /api/auth/nonce'],{
    fetchImpl:async(url,options)=>{calls.push({url,options});return {ok:true,status:200,arrayBuffer:async()=>new ArrayBuffer(0)}}})
  assert.equal(calls.length,8)
  assert.deepEqual(calls.slice(0,4).map(c=>new URL(c.url).pathname),['/api/home','/api/auth/session','/api/notifications','/api/auth/nonce'])
  assert.equal(calls[1].options.headers.cookie,'private-session')
  assert.equal(calls[2].options.headers.cookie,'private-session')
  assert.equal(calls[0].options.headers.cookie,undefined)
  assert.equal(calls[3].options.method,'POST')
  assert.equal(calls[3].options.headers.origin,'http://localhost:3460')
  assert.ok(calls.every(c=>c.options.redirect==='error'))
})
test('warmup HTTP failures abort preparation instead of becoming measured results',async()=>{
  let calls=0
  await assert.rejects(warmLoadEndpoints(env,{cookie:'private'},['GET /api/home','GET /api/auth/session'],{
    fetchImpl:async()=>{calls++;return {ok:false,status:503,arrayBuffer:async()=>new ArrayBuffer(0)}}}),/503/)
  assert.equal(calls,1)
})
