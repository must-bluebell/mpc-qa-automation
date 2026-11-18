import { test } from '@playwright/test'
import { requireIsolatedApi, contractCall, assertContract } from '../../fixtures/api-contracts'
import { target } from '../../config/target'

// An isolated admin session is an explicit fixture, never a wallet promoted to admin.
const cases = [
  ['API012', 'PATCH', '/api/admin/admins/invalid', {}, 'bad_id'],
  ['API013', 'DELETE', '/api/admin/admins/invalid', undefined, 'bad_id'],
  ['API015', 'POST', '/api/admin/admins', {}, 'bad_email'],
  ['API019', 'POST', '/api/admin/checkin/reconcile', { day: -1 }, 'bad_request'],
  ['API021', 'PATCH', '/api/admin/join-policy', { skipEmailOtp: 'yes' }, 'bad_body'],
  ['API028', 'POST', '/api/admin/quest/reconcile', { limit: 0 }, 'bad_request'],
  ['API029', 'GET', '/api/admin/quests/invalid!/edits', undefined, 'bad_key'],
  ['API030', 'PATCH', '/api/admin/quests/invalid!', {}, 'bad_key'],
  ['API031', 'POST', '/api/admin/quests/batch', {}, 'bad_batch'],
  ['API034', 'POST', '/api/admin/quiz/batches', {}, 'bad_batch'],
  ['API035', 'POST', '/api/admin/quiz/items/invalid!', {}, 'bad_id'],
  ['API037', 'POST', '/api/admin/quiz/items', {}, 'bad_batch'],
  ['API038', 'POST', '/api/admin/quiz/translations', {}, 'bad_request'],
  ['API040', 'PATCH', '/api/admin/roles/invalid', {}, 'bad_id'],
  ['API042', 'POST', '/api/admin/roles', {}, 'bad_name'],
  ['API043', 'POST', '/api/admin/telegram/unlink', {}, 'bad_request'],
  ['API044', 'POST', '/api/admin/votes/lifecycle', {}, 'bad_body'],
  ['API045', 'POST', '/api/admin/votes', {}, 'bad_body'],
] as const

test.use({ trace: 'off' })
test.describe('Administrator validation', { tag: ['@api', '@collection-admin'] }, () => {
  test.beforeEach(() => {
    requireIsolatedApi()
    test.skip(!process.env.QA_API_ADMIN_STATE_FILE, 'Requires an isolated administrator storageState file in QA_API_ADMIN_STATE_FILE')
  })
  for (const [id, method, path, body, error] of cases) {
    test(`${id} ${method} ${path} rejects invalid input after admin authentication`, async ({ playwright }, info) => {
      const context = await playwright.request.newContext({ baseURL: target().baseUrl, storageState: process.env.QA_API_ADMIN_STATE_FILE })
      try { assertContract(await contractCall(context, info, method, path, { body }), { status: 400, error }) }
      finally { await context.dispose() }
    })
  }
})
