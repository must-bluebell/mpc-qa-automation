import test from 'node:test'
import assert from 'node:assert/strict'
import {outputRedactor} from '../../pipeline/lib/output-redactor.mjs'
import {runProcess} from '../../pipeline/lib/proc.mjs'

test('a missing executable resolves as a failed process without waiting for the timeout', {timeout:3000}, async()=>{
  const result=await runProcess('/nonexistent/qa-missing-executable',[],{echo:false,timeoutMs:1000})
  assert.notEqual(result.code,0)
  assert.equal(result.timedOut,false)
  assert.match(result.tail,/ENOENT/)
})


test('split secrets are absent from the process tail, log, and echoed output',async t=>{
  const {mkdtempSync,readFileSync,rmSync}=await import('node:fs')
  const {tmpdir}=await import('node:os')
  const {join}=await import('node:path')
  const {execFile}=await import('node:child_process')
  const {promisify}=await import('node:util')
  const dir=mkdtempSync(join(tmpdir(),'qa-split-output-')),logFile=join(dir,'out.log')
  t.after(()=>rmSync(dir,{recursive:true,force:true}))
  const secret='qa-secret-🔐-split-across-chunks'
  const childScript=`
    const bytes=Buffer.from(process.env.QA_SEED_PHRASE);
    for(const stream of [process.stdout,process.stderr]) {
      stream.write('before:');
      for(const byte of bytes){stream.write(Buffer.from([byte]));await new Promise(r=>setTimeout(r,5))}
      stream.write(':after\\n');
    }
  `
  const script=`
    import {runProcess} from ${JSON.stringify(new URL('../../pipeline/lib/proc.mjs',import.meta.url).href)};
    const result=await runProcess(process.execPath,['--input-type=module','-e',${JSON.stringify(childScript)}],{
      passSecrets:['QA_SEED_PHRASE'],logFile:${JSON.stringify(logFile)},echo:true
    });
    console.log(JSON.stringify(result));
  `
  const {stdout}=await promisify(execFile)(process.execPath,['--input-type=module','-e',script],{
    env:{...process.env,QA_SEED_PHRASE:secret},timeout:10000,
  })
  const log=readFileSync(logFile,'utf8')
  assert.ok(!stdout.includes(secret),'echo and returned tail must redact chunked secrets')
  assert.ok(!log.includes(secret),'on-disk logs must redact chunked secrets')
  assert.match(stdout,/before:\[REDACTED\]:after/)
  assert.match(log,/before:\[REDACTED\]:after/)
})


test('stream redaction preserves UTF-8 and ordinary trailing prefixes with overlapping secrets',()=>{
  let text=''
  const redactor=outputRedactor(chunk=>{text+=chunk},['abcd','abcdef'])
  for(const byte of Buffer.from('⚡abcdef-abcd-abc'))redactor.write(Buffer.from([byte]))
  redactor.end()
  assert.equal(text,'⚡[REDACTED]-[REDACTED]-abc')
})
