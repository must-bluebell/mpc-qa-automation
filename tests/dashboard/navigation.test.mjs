import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

class Element {
  children = []
  append(...children) { this.children.push(...children) }
  replaceChildren(...children) { this.children = children }
  setAttribute() {}
  get textContent() { return this.children.map(c => c instanceof Element ? c.textContent : c).join('') }
}

for (const stale of ['run', 'list', 'error']) test(`a stale ${stale} response cannot replace the current navigation`, async () => {
  const app = new Element(), chips = new Element(), requests = []
  const location = { hash: stale === 'list' ? '#/' : '#/runs/old' }
  let navigate
  runInNewContext(readFileSync(new URL('../../dashboard/read-only/app.js', import.meta.url), 'utf8'), {
    document: { getElementById: id => id === 'app' ? app : chips, createElement: () => new Element(), createTextNode: s => s },
    Node: Element, location,
    window: { addEventListener: (_, handler) => { navigate = handler } },
    fetch: () => new Promise((resolve, reject) => requests.push({ resolve, reject })),
  })
  location.hash = '#/runs/current'
  const current = navigate()
  requests[1].resolve({ ok: true, json: async () => ({ runId: 'current', suite: 'regression' }) })
  await current
  const expected = app.textContent, expectedChips = chips.textContent
  if (stale === 'error') requests[0].reject(new Error('old failure'))
  else requests[0].resolve({ ok: true, json: async () => stale === 'list' ? { runs: [], generatedAt: '2026-01-01' } : { runId: 'old', suite: 'regression' } })
  await new Promise(resolve => setImmediate(resolve))
  assert.match(expected, /run current/)
  assert.equal(app.textContent, expected)
  assert.equal(chips.textContent, expectedChips)
})
