import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import '/app/scripts/ci-next-worker.mjs'
import { nextWorkerOptions } from './next-worker-options.mjs'

const spawn = childProcess.spawn
childProcess.spawn = function (command, args = [], options = {}) {
  const next = Array.isArray(args) ? args.findIndex(arg => String(arg).endsWith('/next/dist/bin/next')) : -1
  if (process.env.QA_APP_RUNTIME === 'production' && Array.isArray(args)
    && next >= 0 && args[next + 1] === 'dev') {
    return spawn.call(this, command, [...args.slice(0, next), '/qa-runtime/production-app.mjs', ...args.slice(next + 2)], options)
  }
  return spawn.call(this, command, args, options)
}

const fork = childProcess.fork
childProcess.fork = function (modulePath, args = [], options = {}) {
  if (!Array.isArray(args)) { options = args ?? {}; args = [] }
  return fork.call(this, modulePath, args, nextWorkerOptions(modulePath, options))
}
syncBuiltinESMExports()
