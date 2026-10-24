import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { childEnv } from '../lib/proc.mjs'
import { isLoopback } from '../lib/env.mjs'

const exec = promisify(execFile)

/** Clear accumulated development compiler memory without replacing database or chain state. */
export async function prepareWebRuntime(env, {purpose='load',execImpl=exec,fetchImpl=fetch,wait=delay,timeoutMs=240_000}={}) {
  const permitted=purpose==='scenarios'?env.allowWrites:purpose==='load'&&env.allowLoad
  if (!env.isolated || !permitted || !isLoopback(env.baseUrl)) throw new Error('Web preparation requires an authorized isolated loopback target.')
  if (!env.stack?.verificationRuntime) return
  const container=`${env.stack.composeProject}-web-1`,options={env:childEnv(),timeout:180_000}
  const {stdout}=await execImpl('docker',['inspect','--format','{{json .Config.Labels}}',container],options)
  const labels=JSON.parse(stdout)
  if(labels['com.docker.compose.project']!==env.stack.composeProject||labels['com.docker.compose.service']!=='web')throw new Error('Load web container identity does not match the configured stack.')
  await execImpl('docker',['restart','--timeout','90',container],options)
  const deadline=Date.now()+timeoutMs
  while(Date.now()<deadline) {
    try {
      const response=await fetchImpl(`${env.baseUrl}/`,{redirect:'error',signal:AbortSignal.timeout(15_000)})
      await response.arrayBuffer?.()
      if(response.ok)return
    }catch{/* Bootstrap and initial compilation can temporarily refuse connections. */}
    await wait(1000)
  }
  throw new Error('Load web runtime did not become ready after restart.')
}

/** Compile/JIT each measured route before sampling, retaining real HTTP responses and sessions. */
export async function warmLoadEndpoints(env, session, endpoints, {fetchImpl=fetch}={}) {
  if(!env.isolated||!env.allowLoad||!isLoopback(env.baseUrl))throw new Error('Load warmup requires an isolated loopback target.')
  for(let round=0;round<2;round++)for(const endpoint of endpoints) {
    const [method,path]=endpoint.split(' ')
    if(!['GET','POST'].includes(method)||!path?.startsWith('/api/')||path.startsWith('//')||/[?#]/.test(path))throw new Error('Unsupported load warmup endpoint.')
    const headers={}
    if(['/api/auth/session','/api/notifications'].includes(path))headers.cookie=session.cookie
    if(method==='POST')Object.assign(headers,{origin:env.appOrigin,'content-type':'application/json'})
    const response=await fetchImpl(`${env.baseUrl}${path}`,{method,headers,body:method==='POST'?'{}':undefined,redirect:'error',signal:AbortSignal.timeout(30_000)})
    await response.arrayBuffer()
    if(!response.ok&&!(path==='/api/auth/nonce'&&response.status===429))throw new Error(`Load warmup failed: ${method} ${path} answered ${response.status}.`)
  }
}
