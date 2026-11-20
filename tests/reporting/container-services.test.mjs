import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function serviceFixture(t, { scheduler = '1', fail = false, agent = '0' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mpc-container-'))
  mkdirSync(join(root, 'pipeline/docker'), { recursive: true })
  mkdirSync(join(root, 'dashboard'))
  copyFileSync('pipeline/docker/services.mjs', join(root, 'pipeline/docker/services.mjs'))
  mkdirSync(join(root, 'pipeline/slack-agent'), { recursive: true })
  for (const name of ['dashboard', 'scheduler', 'agent']) {
    const file = name === 'dashboard' ? 'dashboard/server.mjs' : name === 'agent' ? 'pipeline/slack-agent/server.mjs' : 'pipeline/scheduler.mjs'
    writeFileSync(join(root, file), `
      import fs from 'node:fs';
      fs.writeFileSync(${JSON.stringify(join(root, `${name}.pid`))}, String(process.pid));
      console.log('${name} ready');
      setInterval(() => {}, 1000);
      ${name === 'scheduler' && fail ? `const timer = setInterval(() => {
        if (fs.existsSync(${JSON.stringify(join(root, 'dashboard.pid'))})) {
          clearInterval(timer); setTimeout(() => process.exit(42), 50);
        }
      }, 20);` : ''}
    `)
  }
  const child = spawn(process.execPath, [join(root, 'pipeline/docker/services.mjs')], {
    env: { ...process.env, QA_SCHEDULER_ENABLED: scheduler, QA_SLACK_AGENT_ENABLED: agent }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  const closed = once(child, 'close')
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM')
    await closed
    rmSync(root, { recursive: true, force: true })
  })
  return { child, root, closed, output: () => output }
}

test('a failed scheduler stops its dashboard peer and fails the container', { timeout: 10000 }, async t => {
  const f = serviceFixture(t, { fail: true })
  const [code] = await f.closed
  assert.equal(code, 42, f.output())
  assert.match(f.output(), /dashboard ready/)
  const pid = Number(readFileSync(join(f.root, 'dashboard.pid'), 'utf8'))
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
})

test('dashboard-only mode does not start a scheduler and shuts down cleanly', { timeout: 10000 }, async t => {
  const f = serviceFixture(t, { scheduler: '0' })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(f.output())), 5000)
    const check = () => { if (f.output().includes('dashboard ready')) { clearTimeout(timer); resolve() } }
    f.child.stdout.on('data', check)
    check()
  })
  f.child.kill('SIGTERM')
  const [code] = await f.closed
  assert.equal(code, 0, f.output())
  assert.doesNotMatch(f.output(), /scheduler ready/)
  const pid = Number(readFileSync(join(f.root, 'dashboard.pid'), 'utf8'))
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
})


test('conversational agent is supervised only when explicitly enabled', { timeout: 10000 }, async t => {
  const f = serviceFixture(t, { scheduler: '0', agent: '1' })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(f.output())), 5000)
    const check = () => { if (f.output().includes('agent ready') && f.output().includes('dashboard ready')) { clearTimeout(timer); resolve() } }
    f.child.stdout.on('data', check); check()
  })
  f.child.kill('SIGTERM')
  assert.equal((await f.closed)[0], 0)
  const pid = Number(readFileSync(join(f.root, 'agent.pid'), 'utf8'))
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
})
