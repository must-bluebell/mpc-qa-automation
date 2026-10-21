import test from 'node:test'
import assert from 'node:assert/strict'
import {runProcess} from '../../pipeline/lib/proc.mjs'

test('a missing executable resolves as a failed process without waiting for the timeout', {timeout:3000}, async()=>{
  const result=await runProcess('/nonexistent/qa-missing-executable',[],{echo:false,timeoutMs:1000})
  assert.notEqual(result.code,0)
  assert.equal(result.timedOut,false)
  assert.match(result.tail,/ENOENT/)
})
