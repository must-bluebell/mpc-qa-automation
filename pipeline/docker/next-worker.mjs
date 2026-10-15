import childProcess from 'node:child_process'
import '/app/scripts/ci-next-worker.mjs'
import { nextWorkerOptions } from './next-worker-options.mjs'

const fork = childProcess.fork
childProcess.fork = function (modulePath, args = [], options = {}) {
  if (!Array.isArray(args)) { options = args ?? {}; args = [] }
  return fork.call(this, modulePath, args, nextWorkerOptions(modulePath, options))
}
