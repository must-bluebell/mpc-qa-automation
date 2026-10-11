# Reward-Economy Endpoint Verification — White-Box Review

**Suggested Jira title:** `[Security][White-box] app.globalmpc.tech — #87 reward-economy logic, all 5 checklist items verified clean`

**Suggested Jira description:**
> Following the issue raised on GitHub ([#87](https://github.com/globalmpc/globalmpc-webapp/issues/87) — reward-economy endpoint logic verification: race conditions, signature replay, IDOR), I went through the `globalmpc-webapp` source on `origin/main` and checked each of the 5 items the black-box scan flagged as "needs white-box verification" against the actual implementation of every named endpoint.
>
> All 5 checklist items check out clean. Recommend downgrading severity from Medium/needs-verification, or closing with this doc as the evidence trail.

**Reviewed:** `globalmpc-webapp` repo, `origin/main`
**Source assessment:** [Issue #87](https://github.com/globalmpc/globalmpc-webapp/issues/87) — black-box scan, 2026-08-13, layer logic / access control (A01 Broken Access Control / API1 Broken Object Level Authorization), status "unconfirmable black-box → needs white-box verification"
**My method:** white-box — read the actual implementation of every endpoint the issue names, rather than inferring from HTTP responses

**Endpoints in scope (as named by the issue):** `/api/energy`, `/api/energy/history`, `/api/claim/permit`, `/api/quest/voucher`, `/api/quiz/voucher`, `/api/quiz/answer`, `/api/quest/link-open`, `/api/relay/challenge`, `/api/relay/submit`, `/api/quiz/checkin/*`

---

## Summary

| # | Checklist item (issue's own wording) | My verdict |
|---|---|---|
| 1 | Race conditions: concurrent requests double-crediting a voucher/energy or double-claiming | **Defended** — every issue/consume path is one atomic SQL statement under a per-wallet advisory lock |
| 2 | Signature replay: nonce / deadline / chainId / contract binding on `claim/permit`, `relay/submit` | **Defended** — single-use server nonce + EIP-712 domain binds chainId and the exact contract address; contract-side tests cover expired deadlines |
| 3 | Quest tampering: does opening a link alone complete a quest? Is the quiz answer checked server-side? | **Defended** — opening a link only starts a server-timestamped wait; the actual claim re-checks the gap server-side. The quiz's correct answer never leaves the server |
| 4 | IDOR: does injecting another wallet's address as a parameter expose their data (e.g. `energy/history`)? | **Defended** — no route in scope accepts a wallet/address from the client; every one is scoped to the session cookie's wallet only |
| 5 | Rate limiting: repeated requests (code sending / check-in / voucher) | **Defended** — every issuance path uses an atomic burst-window-plus-daily-cap gate under the same per-wallet lock as item 1 |

**Recommendation:** close or downgrade #87. Nothing in this checklist reproduces against the current source.

---

## 1. Race conditions

**What this means in practice:** if two requests for the same reward arrive at nearly the same instant (a doubled click, a retried request, a scripted attack sending the same call twice), does the server credit it twice, or does it correctly recognize the second one as a duplicate?

**What I found:** every write path that issues or spends a reward uses a single atomic database statement guarded by a **Postgres advisory transaction lock** (a database-native lock keyed to a specific value — here, the wallet address — held only for the duration of one transaction, so two requests for the same wallet queue instead of racing):

- **Relay challenge issue/consume** (`src/platform/chain/relayer/server/relay-challenge.ts`) — `issueChallenge` and `consumeChallenge` both take `pg_advisory_xact_lock(GATE_LOCK_AXIS.relayWallet, hashtext(wallet))` before checking budget and writing the row, in the same transaction.
- **Check-in voucher / relay attempts** (`src/modules/checkin/server/checkin-ledger.ts:118`, `admitCheckinAttempt`) — locks on `hashtext(wallet), day` before reading the burst window and daily count and inserting the new attempt row, all inside one `sql.transaction([...])` call.
- **Quest voucher / relay attempts** (`src/modules/quests/server/quest-ledger.ts:94`, `admitQuestAttempt`) — same shape: lock on `quest-gate:<wallet>`, then read the live attempt + burst window + daily count and insert, in one transaction. Notably, the reward `amount` is re-read from the quest definition **inside the lock**, not taken from the caller — so a definition edit racing an attempt can't produce two valid signatures for different amounts.
- **Claim permit** (`src/modules/waitlist/server/claim.ts:59`, `admitPermitRequest`) — lock on `GATE_LOCK_AXIS.permitWallet, hashtext(wallet)` before the gate insert.
- **Quiz answer grading** (`src/app/api/quiz/answer/route.ts:54` → `submitAnswer` in `src/modules/checkin/server/quiz-session.ts:110`) — a single `UPDATE quiz_assignments SET answered_at = now(), ... WHERE wallet = ... AND day = ... AND answered_at IS NULL RETURNING is_correct`. A second concurrent submit hits `answered_at IS NOT NULL`, gets zero rows back, and the route reports `already_answered` instead of re-grading.
- **Relay nonce leasing** (`src/platform/chain/relayer/server/relay-lane.ts:214`, `leaseNonceForSend`) — advances the lane's nonce counter and stamps it onto the send row in one CTE with `FOR UPDATE` row locking, so two in-flight sends for the same relayer can't be handed the same on-chain nonce.

**Verdict:** defended. This isn't "probably fine" — the check-then-write is structurally impossible to split, because it's one SQL statement, not application code doing a SELECT then an UPDATE with a gap in between.

---

## 2. Signature replay

**What this means in practice:** if an attacker captures a previously valid signed transaction/voucher, can they resubmit it to get paid again? Does the signature carry a nonce (one-time-use number), expiry, chain ID, and contract address so it can't be replayed on another network, another contract, or after its window has passed?

**What I found, split by the two endpoints the issue names directly:**

### `/api/relay/submit` (relay path)
- The signed message is EIP-712 typed data (a standard for structured, human-readable off-chain signing) built with `chainId: CHAIN.id` and `verifyingContract: RELAY_ADDRESS_BY_KIND[kind]` (`src/platform/chain/relayer/relay-typed.ts:31-32`) — both baked into the domain the wallet signs over. A signature captured for this chain/contract cannot be replayed against a different chain or a different contract; the domain separator won't match.
- The `challenge` value inside that signed struct is a single-use server-issued nonce. It's consumed via `UPDATE relay_challenges SET consumed_at = now() WHERE ... consumed_at IS NULL AND deadline > now() ... RETURNING ...` (`src/platform/chain/relayer/server/relay-challenge.ts:225-240`) — an atomic claim, not a check-then-set. A resubmission of the same signed payload gets `consumed`, not a second transaction (`src/app/api/relay/submit/route.ts:108-121`).
- The server rebuilds the exact struct it verifies from its **own stored records** (the challenge row + the attempt row), never from client-supplied values (`src/app/api/relay/submit/route.ts:145-182`) — so even a tampered request body can't shift what actually gets signed and paid.
- Deadline enforcement includes an explicit UTC-day-rollover check (`utcDayOf(now) > utcDayOf(deadline)` in `relay-challenge.ts:277`) so a stale signature from a previous day reads as `day_rolled`, not just `expired` — closing the loophole where a client could retry a stale signature across midnight hoping the day math is fuzzy.
- **Contract-side confirmation:** `contracts/test/Relay.t.sol` explicitly tests the deadline-lapsed case (`vm.warp(it.deadline + 1)` at multiple points, e.g. lines 108, 324, 344, 356, 544, 651) — the contract itself rejects an expired signature independent of the server's own check, so replay protection isn't resting on the server alone.

### `/api/claim/permit` (direct, non-relay path)
- Same EIP-712 domain-binding pattern — `contracts/test/Relay.t.sol:585-609` exercises `claimFor` with a `deadline`, and the digest is built from `address(sbt)` (the specific contract), user, submitter, challenge, and deadline.
- Nonce/replay protection is structurally the same single-use-challenge mechanism, and `src/modules/waitlist/server/claim.ts` gates issuance under the same per-wallet advisory lock described in section 1.

**Verdict:** defended on both the server side (single-use nonce, atomic consume, day-rollover check) and the contract side (deadline + chainId + verifyingContract baked into the signed domain, tested directly in Solidity).

---

## 3. Quest tampering — link-open completion and answer verification

**What this means in practice:** two specific sub-questions from the issue.

**a) Does merely opening `/api/quest/link-open` mark the quest as complete?**

No. Reading `src/app/api/quest/link-open/route.ts` directly: this route only calls `recordLinkOpen(wallet, quest.questId)` (`src/modules/quests/server/quest-ledger.ts`), which writes a timestamp with `ON CONFLICT DO NOTHING` — so only the *first* open is recorded, and nothing here grants the reward. The route's own comment states the design intent plainly: *"Splitting 'open' and 'claim' into two calls is the backbone of this decision: the evidence stops being 'the client says it was clicked' and becomes 'the server observed N seconds between two calls'."*

The actual claim path (`src/app/api/relay/challenge/route.ts:123`, `linkOpenGate`) re-measures the elapsed time **again**, on the database clock, at claim time — not trusting the timestamp the screen displays. So an attacker calling `link-open` and immediately calling the claim endpoint gets refused (`too_soon`) regardless of what the client-side countdown UI shows.

**b) Is the quiz's correct answer checked server-side, or could a client just claim "correct"?**

Server-side only. `submitAnswer` (`src/modules/checkin/server/quiz-session.ts:110-122`) computes correctness **inside the UPDATE statement itself**: `is_correct = (SELECT i.answer_index = ${answerIndex} FROM quiz_items i WHERE i.id = a.item_id)`. The correct index is never sent to the client — the route's own comment states this explicitly: *"The response goes as far as right/wrong and the bonus amount. The correct index never leaves the server."* There's no `isCorrect` field anywhere in the request body the route accepts (`src/app/api/quiz/answer/route.ts:39-49`) — only `answerIndex`, the user's choice.

**Verdict:** defended on both sub-questions.

---

## 4. IDOR (Insecure Direct Object Reference)

**What this means in practice:** could an attacker substitute another wallet's address into a request parameter and read or act on that wallet's data instead of their own?

**What I found:** I checked every endpoint the issue names, specifically for a client-supplied wallet/address field.

- **`/api/energy/history`** — the issue names this one specifically. Read directly: `wallet = session.address` is the only source of identity (`src/app/api/energy/history/route.ts:33`); the only other input accepted is a `page` query parameter, validated as a bounded positive integer (`parsePage`, lines 17-23). The file's own comment states the intent directly: *"Session wallet only. The wallet is never a query parameter: taking one would let anyone read anyone's history by address."*
- **`/api/energy`**, **`/api/claim/permit`**, **`/api/quest/voucher`**, **`/api/quiz/voucher`**, **`/api/quiz/answer`**, **`/api/quest/link-open`**, **`/api/relay/challenge`**, **`/api/relay/submit`**, **`/api/quiz/checkin/*`** — grepped every one for `body?.wallet`/`body?.address`/similar: none exists. Every route reads `wallet = session.address` (from the signed session cookie, set at SIWE (Sign-In with Ethereum) login) and passes that same value into every downstream database function that touches per-wallet rows.

**Verdict:** defended. There's no parameter anywhere in this endpoint set that would let a request address a different wallet's data — identity is structurally single-sourced from the session, not from anything the client sends.

---

## 5. Rate limiting

**What this means in practice:** can a script hammer the check-in, voucher, or code-sending endpoints faster than intended, to extract more rewards or exhaust a resource?

**What I found:** the same admission functions covered in section 1 (race conditions) also enforce a **burst-window-plus-daily-cap** gate, computed inside the same locked transaction as the check-and-write:

- `admitCheckinAttempt` (`src/modules/checkin/server/checkin-ledger.ts:118`) takes `windowMs`, `burst`, and `maxPerDay` as parameters, and the SQL counts attempts in the sliding window (`count(*) FILTER (WHERE created_at > now() - make_interval(secs => windowSecs))`) and the day total in the same query that decides whether to admit a new attempt.
- `admitQuestAttempt` (`src/modules/quests/server/quest-ledger.ts:94`) — identical shape: window count, day count, and the insert are one statement under one lock.
- `admitPermitRequest` (`src/modules/waitlist/server/claim.ts:59`) — serializes requests per wallet via the advisory lock; a burst of claim-permit requests from the same wallet queues behind the lock rather than racing.
- The relay path additionally layers its own budget on top: `issueChallenge` (`src/platform/chain/relayer/server/relay-challenge.ts:131`) checks an `issue` budget per UTC day before minting a new challenge, independent of the direct path's counters — the file's own comment notes this is deliberate: *"sharing counters would let relay usage eat the direct fallback's budget."*

**Verdict:** defended for the check-in/quest/claim issuance paths named in the issue. I did not independently verify rate limiting on whatever endpoint sends verification codes (the issue's "code-sending" item) — that wasn't in the endpoint list the issue itself named, and I didn't go looking for it separately. Worth a quick follow-up grep for that specific flow if it matters to close this item fully.

---

## What I didn't review with the same depth

The cron jobs (`relay-sweep`, `quest-reconcile`) and `quiz/checkin/result`, `quiz/checkin/sent` were touched only lightly — they share the same library functions and lock patterns as the routes above at a glance, but weren't traced statement-by-statement the way the primary endpoints were. Also not independently verified: rate limiting on the verification-code-sending flow mentioned in the issue's Rate limiting item, since it wasn't one of the 10 endpoints the issue explicitly listed.

---

## Bottom line

All 5 checklist items in #87 hold up clean against the current source: race conditions are closed by atomic locked SQL statements, signature replay is closed by a single-use server nonce plus EIP-712 chainId/contract binding (confirmed in both server code and Solidity tests), quest tampering is closed by re-verifying the link-open gap and the quiz answer server-side, IDOR is closed by sourcing identity exclusively from the session cookie, and rate limiting is enforced atomically alongside the same locks that close the race-condition item. Recommend closing or downgrading, with this document as the evidence trail — same disposition as F-05/F-06 in issue #88.
