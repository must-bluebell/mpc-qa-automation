import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateLoad } from '../../pipeline/adapters/k6.mjs'
const name='GET /api/home'
const thresholds={endpoints:{[name]:{p95Ms:100,maxErrorRate:0.01}},maxP95RegressionPct:25,maxErrorRateRegressionPct:2}
function summary(duration={'p(95)':50},failed={rate:0},requests={count:10}) {
  return {metrics:{[`http_req_duration{name:${name}}`]:{values:duration},[`http_req_failed{name:${name}}`]:{values:failed},[`http_reqs{name:${name}}`]:{values:requests}}}
}
test('load requires latency and error metrics, even if requests were recorded',()=>{
  for(const data of [summary({}),summary(undefined,{}),summary({'p(95)':NaN}),summary(undefined,{rate:Infinity})])
    assert.ok(evaluateLoad(data,thresholds).breaches.length>0)
})
test('load enforces absolute latency and error SLOs',()=>{
  assert.equal(evaluateLoad(summary(),thresholds).breaches.length,0)
  assert.match(evaluateLoad(summary({'p(95)':101}),thresholds).breaches.join(' '),/p95/)
  assert.match(evaluateLoad(summary(undefined,{rate:0.02}),thresholds).breaches.join(' '),/error rate/)
})
test('load cannot pass unmeasured endpoints and detects baseline regression',()=>{
  assert.match(evaluateLoad(summary(undefined,undefined,{count:0}),thresholds).breaches.join(' '),/no requests/)
  const baseline={endpoints:{[name]:{p95Ms:100,errorRate:0}}}
  assert.match(evaluateLoad(summary({'p(95)':170}),thresholds,baseline).breaches.join(' '),/regressed/)
})
