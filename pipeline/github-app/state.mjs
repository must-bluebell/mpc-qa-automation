import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Keeps completed comment IDs and unfinished jobs together for restart recovery. */
export function createState(file, { limit = 2000 } = {}) {
  let handled = {}, pending = {}
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    handled = saved.handled ?? {}
    pending = saved.pending ?? {}
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  const save = (nextHandled, nextPending) => {
    mkdirSync(dirname(file), { recursive: true })
    const entries = Object.entries(nextHandled).sort((a, b) => a[1].localeCompare(b[1])).slice(-limit)
    const retained = Object.fromEntries(entries)
    writeFileSync(`${file}.tmp`, JSON.stringify({ handled: retained, pending: nextPending }), { mode: 0o600 })
    renameSync(`${file}.tmp`, file)
    handled = retained
    pending = nextPending
  }
  return {
    has: commentId => Object.hasOwn(handled, String(commentId)) || Object.hasOwn(pending, String(commentId)),
    /** Persist the job in the same atomic write as its claim. */
    claim(commentId, job) {
      const key = String(commentId)
      if (Object.hasOwn(handled, key) || Object.hasOwn(pending, key)) return false
      if (job) save(handled, { ...pending, [key]: { ...job, commentId } })
      else save({ ...handled, [key]: new Date().toISOString() }, pending)
      return true
    },
    pending: () => Object.values(pending),
    saveResult(commentId, resultBody) {
      const key = String(commentId)
      if (!Object.hasOwn(pending, key)) throw new Error('Cannot save a result for an unclaimed job')
      save(handled, { ...pending, [key]: { ...pending[key], resultBody } })
    },
    /** Merges fields into a pending job (the Actions run it started, its check, its result) in one atomic write. False if it already completed. */
    patch(commentId, fields) {
      const key = String(commentId)
      if (!Object.hasOwn(pending, key)) return false
      save(handled, { ...pending, [key]: { ...pending[key], ...fields } })
      return true
    },
    complete(commentId) {
      const remaining = { ...pending }
      delete remaining[String(commentId)]
      save({ ...handled, [String(commentId)]: new Date().toISOString() }, remaining)
    },
  }
}
