#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// One PID namespace makes the existing pipeline/scheduler lock ownership checks valid.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const services = ['dashboard/server.mjs']
if (process.env.QA_SCHEDULER_ENABLED === '1') services.push('pipeline/scheduler.mjs')
if (process.env.QA_SLACK_AGENT_ENABLED === '1') services.push('pipeline/slack-agent/server.mjs')
const children = new Set()
let stopping = false, result = 0, deadline

function signalGroup(child, signal) {
  try { process.kill(-child.pid, signal) } catch { /* child group already exited */ }
}

function stop(code) {
  if (stopping) return
  stopping = true
  result = code
  for (const child of children) signalGroup(child, 'SIGTERM')
  deadline = setTimeout(() => {
    for (const child of children) signalGroup(child, 'SIGKILL')
  }, 30000)
  deadline.unref()
}

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stop(0))
for (const service of services) {
  const child = spawn(process.execPath, [resolve(root, service)], {
    cwd: root, env: process.env, stdio: 'inherit', detached: true,
  })
  children.add(child)
  child.once('error', () => stop(1))
  child.once('close', (code, signal) => {
    // A crashed service can leave descendants in its process group.
    signalGroup(child, 'SIGTERM')
    children.delete(child)
    if (!stopping) {
      console.error(`Automation service stopped: ${service} (code ${code ?? signal}).`)
      stop(code || 1)
    }
    if (!children.size) {
      clearTimeout(deadline)
      process.exitCode = result
    }
  })
}
