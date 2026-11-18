import { test, expect, type APIRequestContext } from '@playwright/test'
import { signIn, writesAllowed } from '../../fixtures/api'
import { contractCall, assertContract, requireIsolatedApi } from '../../fixtures/api-contracts'
import { target } from '../../config/target'

type Validation = { id: string; path: string; method?: string; body?: unknown; raw?: string; error: string; status?: number }
const cases: Validation[] = [
  { id: 'API088', path: '/api/energy/history?page=invalid', method: 'GET', error: 'bad_page' },
  { id: 'API086', path: '/api/energy/deposits/invalid', method: 'GET', error: 'invalid_transfer_id' },
  { id: 'API149', path: '/api/relay/status?challenge=invalid', method: 'GET', error: 'bad_request' },
  { id: 'API124', path: '/my-mine/run?record=-1', method: 'GET', error: 'invalid_record' },
  { id: 'API129', path: '/api/notifications', method: 'PATCH', body: {}, error: 'bad_notification' },
  { id: 'API129', path: '/api/notifications', method: 'PATCH', body: { id: '-1' }, error: 'bad_notification' },
  { id: 'API129', path: '/api/notifications', method: 'PATCH', body: { all: true }, error: 'bad_notification' },
  { id: 'API125', path: '/my-mine/run', body: { script: 'invalid' }, error: 'bad_run_body' },
  { id: 'API125', path: '/my-mine/run', body: { script: [null] }, error: 'every move needs a name' },
  { id: 'API125', path: '/my-mine/run', body: { script: [], moves: [] }, error: 'bad_run_body' },
  { id: 'API125', path: '/my-mine/run', raw: '{invalid', error: 'bad_run_body' },
  { id: 'API125', path: '/my-mine/run', body: { script: [], rollbackFromMoves: -1 }, error: 'rollback must withdraw the pending move' },
  { id: 'API106', path: '/my-mine/draw', body: {}, error: 'bad_draw_request' },
  { id: 'API106', path: '/my-mine/draw', body: { intent: { t: 'mine' }, index: -1 }, error: 'bad_draw_request' },
  { id: 'API108', path: '/my-mine/energy', body: { script: 'invalid' }, error: 'bad_run_body' },
  { id: 'API120', path: '/my-mine/record', body: { script: [] }, error: 'needs a move list and the press index inside it' },
  { id: 'API122', path: '/my-mine/record/self', body: { script: [] }, error: 'needs a move list and the press index inside it' },
  { id: 'API121', path: '/my-mine/record/self/register', body: {}, error: 'needs the press index and transaction hash' },
  { id: 'API123', path: '/my-mine/record/submit', body: {}, error: 'needs the press index and the wallet signature' },
  { id: 'API104', path: '/my-mine/claim/submit', body: {}, error: 'bad_claim_body' },
  { id: 'API113', path: '/my-mine/jv/claim/submit', body: {}, error: 'bad_take_body' },
  { id: 'API115', path: '/my-mine/jv/settle', body: {}, error: 'bad_invite' },
  { id: 'API127', path: '/my-mine/state-run', body: { script: [] }, error: 'bad_run_body' },
  { id: 'API133', path: '/api/quest/link-open', body: {}, error: 'bad_request' },
  { id: 'API134', path: '/api/quest/result', body: {}, error: 'bad_request' },
  { id: 'API135', path: '/api/quest/seen', body: { key: '!invalid!' }, error: 'bad_request' },
  { id: 'API136', path: '/api/quest/sent', body: {}, error: 'bad_request' },
  { id: 'API137', path: '/api/quest/voucher', body: {}, error: 'bad_request' },
  { id: 'API139', path: '/api/quiz/answer', body: {}, error: 'bad_request' },
  { id: 'API140', path: '/api/quiz/checkin/result', body: {}, error: 'bad_request' },
  { id: 'API141', path: '/api/quiz/checkin/sent', body: {}, error: 'bad_request' },
  { id: 'API144', path: '/api/register/send-code', body: {}, error: 'missing_fields' },
  { id: 'API144', path: '/api/register/send-code', body: { email: 'invalid' }, error: 'bad_email' },
  { id: 'API144', path: '/api/register/send-code', raw: '{invalid', error: 'bad_json' },
  { id: 'API147', path: '/api/register/verify-code', body: {}, error: 'missing_fields' },
  { id: 'API147', path: '/api/register/verify-code', body: { email: 'qa@example.com', code: 'abc' }, error: 'bad_code_format' },
  { id: 'API148', path: '/api/relay/challenge', body: {}, error: 'bad_request' },
  { id: 'API150', path: '/api/relay/submit', body: {}, error: 'bad_request' },
  { id: 'API150', path: '/api/relay/submit', body: { challenge: '0x' + '1'.repeat(64), userSig: 'bad' }, error: 'bad_request' },
  { id: 'API164', path: '/api/vote/activity', body: {}, error: 'bad_request' },
  { id: 'API167', path: '/api/vote/relay/prepare', body: {}, error: 'bad_request' },
  { id: 'API168', path: '/api/vote/relay/submit', body: {}, error: 'bad_request' },
  { id: 'API169', path: '/api/word/guess', body: {}, error: 'bad_request' },
]

test.describe('Authenticated input validation', { tag: ['@api', '@regression', '@collection-validation'] }, () => {
  // A single throwaway wallet avoids hitting the sign-in rate limiter for every invalid field.
  let context: APIRequestContext | undefined
  test.beforeAll(async ({ playwright }) => {
    if (!writesAllowed()) return
    requireIsolatedApi()
    context = await playwright.request.newContext({ baseURL: target().baseUrl })
    await signIn(context, test.info())
  })
  test.afterAll(async () => { await context?.dispose() })
  test.beforeEach(() => requireIsolatedApi())
  for (const [i, c] of cases.entries()) {
    test(`${c.id}-V${i + 1} ${c.method ?? 'POST'} ${c.path} rejects ${c.error}`, async ({}, info) => {
      expect(context).toBeDefined()
      // These requests stop at input validation; no valid transaction is ever submitted.
      assertContract(await contractCall(context!, info, c.method ?? 'POST', c.path, { body: c.body, raw: c.raw }), {
        status: c.status ?? 400, error: c.error,
      })
    })
  }
})
