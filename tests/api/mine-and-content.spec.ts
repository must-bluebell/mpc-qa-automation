import { expect, test } from '@playwright/test'
import { call, requireWrites, signIn, skipIfMineClosed } from '../../fixtures/api'

test.describe('My Mine API validation', { tag: ['@api', '@feature-mine', '@critical', '@regression'] }, () => {
  test('M01 - A malformed run body is rejected and nothing is stored', { tag: ['@VAL-01'] }, async ({ request }, info) => {
    requireWrites()
    await signIn(request, info)
    const before = await call(request, info, 'GET', '/my-mine/run')
    skipIfMineClosed(before.status)
    expect(before.status).toBe(200)
    const bad = await call(request, info, 'POST', '/my-mine/run', { body: { script: 'not-a-list' } })
    expect(bad.status).toBe(400)
    const after = await call(request, info, 'GET', '/my-mine/run')
    expect(after.json?.script).toEqual(before.json?.script)
  })

  test('M02 - A malformed draw request is rejected', { tag: ['@VAL-02'] }, async ({ request }, info) => {
    requireWrites()
    await signIn(request, info)
    for (const body of [{}, { intent: { t: 'mine' }, index: -1 }, { intent: 'dig', index: 0 }]) {
      const res = await call(request, info, 'POST', '/my-mine/draw', { body })
      skipIfMineClosed(res.status)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(res.json?.error, JSON.stringify(body)).toBe('bad_draw_request')
    }
  })

  test('M03 - A new wallet starts with an empty run', { tag: ['@MINE-01'] }, async ({ request }, info) => {
    requireWrites()
    await signIn(request, info)
    const run = await call(request, info, 'GET', '/my-mine/run')
    skipIfMineClosed(run.status)
    expect(run.status).toBe(200)
    expect(Array.isArray(run.json?.script)).toBe(true)
  })
})

test.describe('Public content API', { tag: ['@api', '@feature-content', '@regression'] }, () => {
  test('C01 - Quests list is served', { tag: ['@smoke', '@critical'] }, async ({ request }, info) => {
    const res = await call(request, info, 'GET', '/api/quests')
    expect(res.status).toBe(200)
    expect(res.text.length).toBeGreaterThan(0)
  })

  test('C02 - Home facts are served to anonymous visitors', { tag: ['@smoke', '@critical'] }, async ({ request }, info) => {
    const res = await call(request, info, 'GET', '/api/home')
    expect(res.status).toBe(200)
    expect(res.json).not.toBeNull()
  })

  test('C03 - Vote proposals are served', { tag: ['@smoke'] }, async ({ request }, info) => {
    const res = await call(request, info, 'GET', '/api/vote/proposals')
    expect(res.status).toBe(200)
  })
})
