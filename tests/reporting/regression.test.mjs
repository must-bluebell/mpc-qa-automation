import test from 'node:test'
import assert from 'node:assert/strict'
import { summarizeRun, validateAiAnalysis, redact } from '../../utils/regression-analysis.ts'

const meta = { environment: 'Staging', version: 'abc123', owner: 'QA', label: 'Nightly regression' }
const requirements = [{ id: 'AUTH-01', approved: true, description: 'Verify the signed-in address' }]
const row = (id, status, extra = {}) => ({ id, title: id, status, outcome: status === 'passed' ? 'expected' : 'unexpected', errors: [], annotations: [], evidence: [], ...extra })

test('reports final results without double-counting retry attempts', () => {
 const run = summarizeRun([row('a','passed',{ outcome:'flaky' }),row('b','failed'),row('c','skipped'),row('d','skipped',{ annotations:[{type:'blocked',description:'Target missing'}] })],meta,requirements,'failed')
 assert.deepEqual(run.counts,{ passed:1,failed:1,skipped:1,blocked:1,flaky:1 })
 assert.equal(run.status,'failed')
})
test('passing assertions plus a blocked external step keep test counts intact', () => {
 const run = summarizeRun([row('a','passed',{ annotations:[{type:'external-blocked',description:'X: HTTP 403'}] })],meta,requirements,'passed')
 assert.equal(run.counts.passed,1)
 assert.equal(run.counts.blocked,0)
 assert.equal(run.findings[0].classification,'suspected')
})
test('an assertion failure alone is not a confirmed product defect', () => {
 const run = summarizeRun([row('a','failed',{errors:['Copy button timed out']})],meta,requirements,'failed')
 assert.equal(run.findings[0].classification,'suspected')
 assert.equal(run.findings[0].executionFailureConfirmed,true)
})
test('a confirmed defect needs a failed assertion and an approved requirement', () => {
 const annotations=[{type:'defect-confirmed',description:'AUTH-01: Wrong signed-in address'}]
 assert.equal(summarizeRun([row('a','failed',{annotations})],meta,requirements,'failed').findings[0].classification,'confirmed')
 assert.equal(summarizeRun([row('a','failed',{annotations})],meta,[],'failed').findings[0].classification,'suspected')
})
test('AI cannot promote an unconfirmed failure or invent requirement evidence', () => {
 const run=summarizeRun([row('a','failed')],meta,requirements,'failed')
 const raw={summary:'Needs review',findings:[{title:'Defect',classification:'confirmed',evidenceIds:['a'],requirementIds:['AUTH-01'],rationale:'A timeout'}],duplicateGroups:[],scenarios:[{title:'Suggested test',requirementIds:['AUTH-01'],steps:['Sign in'],expectedResult:'Address matches'}]}
 const validated=validateAiAnalysis(raw,run,requirements)
 assert.equal(validated.findings[0].classification,'suspected')
 assert.equal(validated.scenarios[0].validationStatus,'proposed; not an acceptance check')
 assert.throws(()=>validateAiAnalysis({...raw,scenarios:[{...raw.scenarios[0],requirementIds:['MADE-UP']}]},run,requirements))
})
test('global runner failures cannot produce a passing regression summary', () => {
 assert.equal(summarizeRun([row('a','passed')],meta,requirements,'failed').status,'failed')
})
test('redacts signing phrases, keys and authentication headers', () => {
 const secret='test seed phrase never disclose'
 const input=`${secret} private=${'0x'+'a'.repeat(64)} Authorization: Bearer abc123\nCookie: session=abc`
 const output=redact(input,[secret])
 assert.ok(!output.includes(secret))
 assert.ok(!output.includes('a'.repeat(64)))
 assert.ok(!output.includes('Bearer abc123'))
 assert.ok(!output.includes('session=abc'))
})
