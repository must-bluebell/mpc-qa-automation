# MPC app: test cases for every module

Written: 2026-11-05. Source checked: `/Users/mac/WEB MPC` (code, constants and copy) and `reference/unity-*.md` (policy).
These are **expected results derived from code and acceptance criteria. They have not been run.** Each run records its own result in the log at the end.

Scope: Landing · Connect & sign-in · Wallet failures · Community (Telegram, X) · Email verification · SBT claim · Check-in · Quests · Digging · Materials · Forge · Market (sell and buy) · Refine · Rank · Holdings · Record · Rules · Security · Web/UI.

## 1. Conventions

**Env** (from `pipeline/config/environments.json`):

| Code | Target | Writes allowed |
|---|---|---|
| ISO | Isolated stack (`local-docker` / `web-isolated`, port 3461) | Yes |
| PRV | Preview (BSC testnet, chain 97) | No: read-only cases only |
| PRD | Production (`app.globalmpc.tech`, chain 56) | No: read-only cases only |
| ANY | Any environment, read-only | — |

Never run a case that writes (claim, send code, check-in, quest claim, buy, dig record) on PRV or PRD. Each write case is tagged ISO.

**Type:** RO = read-only, automatable · FULL = full flow, ISO · BVA = boundary value · SEC = security · UI = web/UI · MAN = manual · UNIT = repo unit test (no browser).

**Priority:** P0 = identity, money, credit or security · P1 = core flow · P2 = polish.

**IDs:** Existing IDs (T0-, T1-, T1F-, T2-, T3-, T4-, M-) keep their numbers from the acceptance sheets. New cases use a module prefix.

## 2. Gaps to decide before running

Found by reading the source against the acceptance criteria. Each one changes an expected result.

| # | Gap | Evidence | Affects |
|---|---|---|---|
| G1 | Switch-network failure for an unknown error and for no wallet shows the **wrong-network** message, not the plain error the spec requires. | `JoinFlow.tsx` failure matrix: `switch.unknown` and `switch.no_wallet` both map to `t.wrongChain(CHAIN.name)`. | T1F-14, T1F-15 |
| G2 | Signature rejection says "**cancelled**". The spec says "**declined**". | `en.ts` `signRejected`. | T1F-06 |
| G3 | The no-wallet message mentions WalletConnect only on mobile (`failNoWalletWithWc`). The desktop message says to install an extension. | `en.ts` `failNoWallet` / `failNoWalletWithWc`. | T1F-04 |
| G4 | **No QA test-inbox allowance exists.** The only protection is the disposable-domain list. "QA inbox is allowed" holds only if the QA inbox domain is not on that list. | `disposable-email.ts`. No allowlist anywhere in `src`. | T3-11, M-14 |
| G5 | `tempmail.com` is **not** on the blocklist. I checked the list with the same logic in Node. Mailinator, guerrillamail, yopmail, 10minutemail and trashmail are blocked. The list is a snapshot and needs updating. | Node check against `disposable-email-domains` (121,570 exact, 399 wildcard). | T3-10 |
| G6 | Streak rule not final. The code says a streak dies after one missed day **and a grace day**. The policy's "consecutive attendance table" is still an open decision (`00-plan.md` §9 item 9). | `my-mine/state/day.ts`, `attend.ts`, `unity-game-policy.md` §5. | M-17, M-18, CHK-06 |
| G7 | Check-in reward asset is inconsistent across docs: "Energy" in the acceptance criteria, "opBNB Crew" in `app-user-flows.md`. | Acceptance sheet vs `reference/app-user-flows.md`. | M-15, CHK-02 |
| G8 | Route format differs by target. The module list uses `?view=dig`, but the current code builds `?tab=mine&screen=dig` (`navigation.ts`). `wallet-flow.spec.ts` switches on the environment. Confirm the route for each target before running. | `navigation.ts`, `wallet-flow.spec.ts`. | All module URLs |
| G9 | "Forge" (`?view=market`) and "market" both appear in the module list. In code, both are the Market screen (`SCREEN_ORDER`: `market`). Forge is written here as the route shell and Market as the sell/buy actions. Confirm. | `glossary/names.ts` `SCREEN_ORDER`. | FRG-, MKT- |
| G10 | Runtime-unverified: refine selection grouping, the dig "centre tap" position, and the enlarged material view. The policy doc marks these "verify at runtime". | `unity-game-policy.md` §4, `unity-dig-screen.md`. | RFN-02, DIG-14, MAT-08 |
| G11 | "Dig what is left" and the refine selection rules have no in-code spec beyond the constants. Refine expectations below marked **verify** are inferred from `FUSE = 5`. | `economy.ts`. | RFN-03, RFN-04 |
| G12 | Acceptance says the Telegram token expires after 15 minutes. I did not find that constant in the source. Confirm the value. | Not found by grep. | T2-03 |
| G13 | At the fifth wrong code the screen shows "0 attempts left" and does not say to request a new code. The code is deleted at that point, so the `too_many_attempts` branch is effectively unreachable. The spec wants "asks for a new code". | `registration.ts` `verifyOtp`: deletes the row when `attemptsLeft === 0`. | T3-14 |

## 3. Test data

Real-format values only. No real person's data and no secrets. Seed phrases and keys stay in `.env` and are never copied here.

**Wallets**

| Name | Value | Use |
|---|---|---|
| QA_WALLET | Address in `.env` `WALLET_ADDRESS` (index `WALLET_ADDRESS_INDEX`). Registered, Telegram bound, holds SBT. | Member cases |
| NEW_WALLET_A / B | Fresh wallet per run, funded with test BNB on ISO or tBNB on PRV. Never mainnet. | Newcomer cases, cross-wallet cases |

**Emails**

| Value | Expected |
|---|---|
| `ana.perez@gmail.com` | Allowed |
| `Ana.Perez@GMail.com` | Allowed, normalised to lowercase |
| `  ana.perez@gmail.com  ` | Allowed, trimmed |
| `ana.perez+mpc1@gmail.com` | Allowed (alias allowed by approved decision) |
| `ana.perez@not10mail.org` | Allowed (lookalike of a listed domain) |
| `sam@mailinator.com` | Refused, disposable |
| `sam@x.mailinator.com` | Refused, subdomain of a listed service |
| `sam@guerrillamail.com` | Refused, disposable |
| `sam@tempmail.com` | **Should be refused. Currently allowed (G5).** |
| `mpc.qa.inbox@<QA_INBOX_DOMAIN>` | Must be allowed. Depends on G4. |
| `a@b` | Refused, format |
| `a@b.c` | Passes the format check (`EMAIL_FORMAT`). Delivery decides. |

**Telegram**: test accounts `@mpc_qa_01` and `@mpc_qa_02`. Use the isolated bot and webhook secret only.

**Time**: UTC boundaries on ISO use the Playwright clock. Check-in boundaries use 2026-11-05 `23:54:59Z`, `23:55:00Z`, `23:59:59Z` and `00:00:00Z`.

**Digging states** (`DIG_STATES` in `economy.ts`): (energy 30, mined 0) · (12, 2) · (600, 18) · (2, 0).

**Constants** (from `economy.ts`, `checkin-rules.ts`, `registration-rules.ts`, `quest-rules.ts`): COST 3 · CAP 20 · SAFETY 20 · ASSET_DAYS 15 · FUSE 5 · PAY_PER_UNIT 45 · BUYBACK 3 · SHOP_GRADES 3 · OTP 6 digits, 10 min, 5 attempts · resend 60 s · per-email 10/day · per-IP 30/day · per-wallet 20/day · check-in burst 3 per 5 min, 20/day · quest gap 15 s (max 600 s) · quest voucher TTL 600 s, reuse margin 60 s · permit TTL 3600 s, cooldown 10 s, 20/day · gasless inclusion timeout 120 s.

## 4. Module cases

### 4.1 Landing (T0)

| ID | Case (steps → expected) | Data | Env | Type | Pri |
|---|---|---|---|---|---|
| T0-01 | Open home → page loads, status 200 | — | ANY | RO | P0 |
| T0-02 | Find the Join button → it is visible and enabled | — | ANY | RO | P0 |
| T0-03 | Click Join → sheet opens on step 1 "Connect wallet" | — | ANY | RO | P0 |
| T0-04 | Open home → no uncaught errors in the console; only expected 401s from anonymous probes | — | ANY | RO | P0 |
| T0-05 | Page title contains "MPC" | — | ANY | RO | P1 |
| T0-06 | Legacy links redirect: `/join`, `/home` → `/`; `/quests` → `/?tab=quest`; `/mine` → `/?tab=mine`; `/vote` → `/?tab=vote` | — | ANY | RO | P1 |
| T0-07 | `/vote/<bad>` (non-numeric) → handled, no crash, no reflected input | `/vote/abc`, `/vote/1e3` | ANY | BVA | P1 |
| T0-08 | Unknown or hostile query → default screen, no script runs | `?view=<img src=x onerror=alert(1)>`, `?tab=zzz` | ANY | SEC | P0 |
| M-28 | Join flow on a phone → everything fits and works | 390×844 | ANY | MAN | P0 |
| UI-01 | Join button tap target ≥ 44×44 px and sheet fits at 360, 390 and 768 px wide with no horizontal scroll | 360 / 390 / 768 px | ANY | UI | P0 |
| UI-02 | Keyboard: Tab reaches Join → Enter opens sheet → Esc closes → focus returns to Join | — | ANY | UI | P1 |
| UI-03 | With reduced motion on, the sheet opens without animation and shows the final state | `prefers-reduced-motion: reduce` | ANY | UI | P2 |

### 4.2 Connect wallet and sign-in (T1)

| ID | Case (steps → expected) | Data | Env | Type | Pri |
|---|---|---|---|---|---|
| T1-01 | Wallet announces itself → shown by its name, never "Injected" | Named extension | ANY | RO | P0 |
| T1-02 | Connect and sign → session created | QA_WALLET | ISO | FULL | P0 |
| T1-03 | Reach sign step → connected address shown, read-only | QA_WALLET | ANY | RO | P0 |
| T1-04 | Unnamed injected provider (no name) → not listed; named wallets still listed | `window.ethereum` with no name | ANY | UNIT | P1 |
| T1-05 | Wallet list shows only installed, named wallets plus a WalletConnect entry | Extension present / absent | ANY | RO | P1 |
| T1-06 | Shown address matches the wallet account exactly (checksum case) | QA_WALLET | ANY | RO | P1 |
| T1-07 (M-27) | Switch account in wallet mid-sheet → app follows new wallet, old account data cleared, reason shown | NEW_WALLET_B | ISO | MAN | P0 |
| T1-08 | Connect on wrong chain → app asks to switch to BSC Testnet on PRV, BNB Chain on PRD | chain 1, 204, 97 (PRV), 56 (PRD) | ANY | BVA | P0 |
| T1-09 | Sign message names the site and the network, and includes a nonce | Message preview | ANY | RO | P0 |
| T1-10 | Replay: the same signed message sent again → refused. Each message is used once. | Signed message, sent twice | ISO | SEC | P0 |
| T1-11 | Signature from another wallet for this nonce → refused | NEW_WALLET_B signs NEW_WALLET_A's nonce | ISO | SEC | P0 |
| T1-12 | Message used after its nonce expires → refused with a retry message | Wait past nonce TTL (**verify value**) | ISO | BVA | P1 |
| T1-13 | Edit the domain or chain ID in the message → refused | Altered message | ISO | SEC | P0 |
| T1-14 | Sign-in sets a session cookie `HttpOnly`, `Secure`, `SameSite`; `/api/auth/session` returns only the address | — | ISO | SEC | P0 |
| T1-15 | Disconnect → session cleared; a protected deep link then asks to sign in | — | ISO | FULL | P0 |
| T1-16 | Refresh on the sign step → the step and address are kept | — | ISO | UI | P1 |

### 4.3 Wallet failure messages (T1F)

Expected copy comes from `en.ts` and the `JoinFlow.tsx` matrix. Gap notes refer to §2.

| ID | Case | Expected message | Env | Type | Pri |
|---|---|---|---|---|---|
| T1F-01 | Reject connect | "The request was cancelled in your wallet. Try again when you are ready." | ANY | RO | P0 |
| T1F-02 | Connect while a request is open | The "request waiting" message. Not labelled "Failed". | ANY | RO | P0 |
| T1F-03 | Connect with locked wallet | "Your wallet is locked. Unlock it and try again." | ANY | RO | P0 |
| T1F-04 | Connect with no wallet | "No browser wallet found…" and a WalletConnect option. **G3.** | ANY | RO | P0 |
| T1F-05 | Connect, unknown failure | "Could not connect. Please try again shortly." | ANY | RO | P0 |
| T1F-06 | Reject signature | "The signature was cancelled…" **G2: spec says "declined".** | ANY | RO | P0 |
| T1F-07 | Sign while a request is open | The "request waiting" message | ANY | RO | P0 |
| T1F-08 | Sign with locked wallet | "Your wallet is locked…" | ANY | RO | P0 |
| T1F-09 | Sign with no wallet | "Could not sign in. Please try again." | ANY | RO | P0 |
| T1F-10 | Sign, unknown failure | "Could not sign in. Please try again." | ANY | RO | P0 |
| T1F-11 | Reject network switch | Message names the chain ("BNB Smart Chain Testnet" on PRV, "BNB Chain" on PRD) | PRV/PRD | RO | P0 |
| T1F-12 | Switch while a request is open | The "request waiting" message | ANY | RO | P0 |
| T1F-13 | Switch with locked wallet | "Your wallet is locked…" | ANY | RO | P0 |
| T1F-14 | Switch with no wallet | Plain error. **G1: currently shows the wrong-network message.** | ANY | RO | P0 |
| T1F-15 | Switch, unknown failure | Plain error. **G1: currently shows the wrong-network message.** | ANY | RO | P0 |
| T1F-16 | Reject the switch during connect | Reported as a connect cancellation, not a switch problem. **Verify in code.** | ANY | RO | P0 |
| T1F-17 | Scan every failure message on screen | No error codes (`4001`, `-32002`, `EIP-`, hex) in the visible text | ANY | UI | P0 |

### 4.4 Community: Telegram, X, participation (T2)

| ID | Case (steps → expected) | Data | Env | Type | Pri |
|---|---|---|---|---|---|
| T2-01 | Community step shows Telegram row, X row, and a confirm-participation control | — | ANY | RO | P0 |
| T2-02 | Click Telegram → app builds a personal link with a token for this user only, opens it in a new tab | QA_WALLET and NEW_WALLET_A get different tokens | ISO | FULL | P0 |
| T2-03 (M-06) | Token boundary: used at 14:59 → accepted; at 15:00 → refused as expired. **G12: confirm TTL.** | Token age 899 s / 900 s | ISO | BVA | P0 |
| T2-04 | Gate on and link only opened → not counted as a join | — | ISO | FULL | P0 |
| T2-05 | Same bot event sent twice → counted once, no error | Same `update_id` | ISO | FULL | P0 |
| T2-06 | Bot event with wrong secret → refused | Wrong secret | ISO | SEC | P0 |
| T2-07 | X: opening the link records "opened" only. The row does not show verified. | — | ISO | FULL | P1 |
| T2-08 | Confirm participation before Telegram is joined (gate on) → blocked, explanation shown | QA_WALLET (not in group) | ISO | FULL | P0 |
| T2-09 | Gate off (preview) → link opened is enough to pass the Telegram step | — | PRV | RO | P1 |
| T2-10 | Webhook: missing secret header, empty secret, secret off by one character → each refused | Three variants | ISO | SEC | P0 |
| T2-11 | Webhook: same join event from a different `update_id` → still counted once | Two `update_id`s, one member | ISO | BVA | P1 |
| T2-12 | Token already linked to another Telegram account → refused | Token reuse | ISO | SEC | P0 |
| T2-13 | Second wallet presses START on an account already linked → bot says already linked | M-02 data | ISO | FULL | P0 |
| T2-14 | `/start` with a token belonging to another wallet → that wallet's link is not changed | Token of NEW_WALLET_A sent from Telegram of QA | ISO | SEC | P0 |
| T2-15 | Open redirect: `returnTo` of `https://evil.example`, `//evil.example`, `/\evil.example`, `javascript:alert(1)` → ignored or refused | Four values | ANY | SEC | P0 |
| T2-16 | Lookalike host `https://t.me.evil.example/...` is not treated as Telegram | `isTelegramQuest` | ANY | UNIT | P0 |
| T2-17 | Telegram row shows "verified" after join and still shows it after reload | — | ISO | UI | P1 |
| T2-18 | Leave for Telegram, then return → Community progress is kept | — | ISO | UI | P1 |
| M-01 | Press START with a valid token → account linked | Valid token | ISO | MAN | P0 |
| M-03 | Press START with no token → bot asks for the personal link | `/start` alone | ISO | MAN | P0 |
| M-04 | Press START with a broken token → bot says the link is not valid | Malformed token | ISO | MAN | P0 |
| M-05 | Join the group → Telegram row turns verified | `@mpc_qa_01` joins | ISO | MAN | P0 |
| M-07 | Personal link fails to build → user lands in the group, not the bot | Fault injection | ISO | MAN | P1 |

### 4.5 Email verification (T3)

| ID | Case (steps → expected) | Data | Env | Type | Pri |
|---|---|---|---|---|---|
| T3-01 | Send a code to a real inbox → wallet registered | QA inbox (G4) | ISO | FULL | P0 |
| T3-02 | Wrong code → refused, tries left shown | Wrong code | ISO | FULL | P0 |
| T3-03 | Send stays disabled until the address format is valid | `a`, `a@`, `a@b`, `@b.com`, `a b@c.com` (disabled); `a@b.c` (enabled, format only) | ANY | BVA | P0 |
| T3-04 | Length boundary: 254 characters accepted by format; 255 → "Check the email format." | 254 / 255 chars | ISO | BVA | P1 |
| T3-05 | Mixed-case address accepted and normalised; the code is bound to the normalised address | `Ana.Perez@GMail.com` | ISO | FULL | P1 |
| T3-06 | Leading and trailing spaces trimmed | `  ana.perez@gmail.com  ` | ISO | BVA | P2 |
| T3-07 | Throwaway address refused with "Temporary or disposable email addresses are not accepted. Please use a permanent address." Nothing saved, no email sent, no rate-limit count. | `sam@mailinator.com` | ISO | FULL | P0 |
| T3-08 | Subdomain of a blocked service refused | `sam@x.mailinator.com` | ISO | BVA | P0 |
| T3-09 | Lookalike domain allowed | `ana.perez@not10mail.org` | ISO | BVA | P0 |
| T3-10 | Known gap: throwaway not on the list → must be refused. **Currently allowed (G5).** | `sam@tempmail.com` | ISO | BVA | P0 |
| T3-11 | QA test inbox allowed. **Depends on G4.** | `mpc.qa.inbox@<QA_INBOX_DOMAIN>` | ISO | RO | P0 |
| T3-12 | Gmail alias and dot variants allowed (accepted sybil limit) | `ana.perez+mpc1@gmail.com`, `anaperez@gmail.com` | ISO | BVA | P2 |
| T3-13 | Code field accepts only 6 digits | `12345` (refused), `123456` (ok), `1234567` (refused), `12345a` (refused), `004821` (ok, leading zeros kept) | ISO | BVA | P0 |
| T3-14 | Wrong-code counter: 1st wrong → "Wrong code. 4 attempts left."; 4th → "1 attempt left"; 5th → "Wrong code. 0 attempts left." and the code is deleted. Next attempt → "no code" message asking for a new code. **G13.** | 5 wrong codes, then a 6th | ISO | BVA | P0 |
| T3-15 | Correct code on the 5th attempt (after 4 wrong) → accepted | 4 wrong, then correct | ISO | BVA | P1 |
| T3-16 | Code expiry: at 9:59 accepted; at 10:00 refused "The code expired. Please request a new one." | Clock | ISO | BVA | P0 |
| T3-17 | Resend cooldown: button reads "Resend (in 60s)"; disabled at 59 s; enabled at 60 s. Server resend at 59 s → 429 with retry time. | Clock | ISO | BVA | P0 |
| T3-18 | Per-email limit: 10th send OK, 11th refused "This email reached its daily send limit. Try again tomorrow." | 10 sends, 60 s apart | ISO | BVA | P0 |
| T3-19 | Per-IP limit: 30th send OK, 31st refused "Daily send limit reached. Try again tomorrow." | 30 sends from one trusted IP | ISO | BVA | P0 |
| T3-20 | Per-wallet limit: 20th send OK, 21st refused with a daily-limit message | One wallet, 21 different addresses | ISO | BVA | P0 |
| T3-21 | Email used by another wallet → "Another wallet is already using this email." | M-10 data | ISO | FULL | P0 |
| T3-22 | Registered wallet sends again → "already registered" (409) and routed to next step | QA_WALLET | ISO | FULL | P1 |
| T3-23 | Provider fails to send → app says the code was not sent, offers retry, quota not used up (**verify quota handling**) | Fault injection | ISO | FULL | P0 |
| T3-24 | Code not in the API response or logs; stored as a hash, bound to the address | `otp` table, response body, logs | ISO | SEC | P0 |
| T3-25 | Brute force: after 5 wrong codes, the correct code is refused | Loop | ISO | SEC | P0 |
| T3-26 | Replay: a code used once cannot be used again | Same code twice | ISO | SEC | P0 |
| T3-27 | Code sent to address A cannot verify address B | Two addresses | ISO | SEC | P0 |
| T3-28 | Telegram gate on, community not done → 403 `telegram_not_joined`, UI returns to Community | NEW_WALLET_A | ISO | SEC | P0 |
| T3-29 | Check order: registered wallet with a throwaway address → 409 (not 400) | QA_WALLET + `sam@mailinator.com` | ISO | BVA | P1 |
| T3-30 | Check order: throwaway address with community not done → 400 disposable (not 403) | NEW_WALLET_A + `sam@mailinator.com` | ISO | BVA | P1 |
| T3-31 | Injection in the email field refused, nothing sent | `ana@x.com\r\nBcc: a@b.com`, `"a b"@x.com`, `a+<script>@x.com`, `a@x.com<script>` | ISO | SEC | P0 |
| T3-32 | Masked address shown without raw HTML | `ana.perez@gmail.com` → expected `a********@gmail.com` (**verify**) | ISO | SEC | P1 |
| T3-33 | Unicode domain accepted by format | `ana@bücher.de` | ISO | BVA | P2 |
| M-08 | Ask for a second code too soon → asked to wait | — | ISO | MAN | P0 |
| M-09 | Pass the daily email limit → refused | — | ISO | MAN | P0 |
| M-10 | Use an email owned by another wallet → refused | — | ISO | MAN | P0 |
| M-11 | Let the code expire → refused, new code can be sent | — | ISO | MAN | P0 |
| M-12 | Use up all tries → asked for a new code | — | ISO | MAN | P0 |
| M-13 | Throwaway email → refused before any email is sent | `sam@mailinator.com` | ISO | MAN | P0 |
| M-14 | Test inbox → allowed | G4 | ISO | MAN | P0 |

### 4.6 SBT claim (T4)

| ID | Case (steps → expected) | Data | Env | Type | Pri |
|---|---|---|---|---|---|
| T4-01 | Whole join flow → SBT lands in wallet | NEW_WALLET_A | ISO | FULL | P0 |
| T4-02 | Claim without registering → "not registered" | NEW_WALLET_A | ISO | SEC | P0 |
| T4-03 | After registering → user reaches the claim step | QA_WALLET | ISO | FULL | P0 |
| T4-04 | Click Claim → wallet asks to sign | — | ISO | FULL | P0 |
| T4-05 | User pays no gas: wallet balance unchanged by the claim | Balance before and after | ISO | FULL | P0 |
| T4-06 | Token appears in wallet; `/api/sbt/[tokenId]` matches | — | ISO | FULL | P0 |
| T4-07 | Success message shown; reload keeps "claimed" and hides the Claim button | — | ISO | FULL | P1 |
| T4-08 | Telegram gate on, not joined → cannot claim, reason shown | NEW_WALLET_A | ISO | SEC | P0 |
| T4-09 | Permit lifetime boundary: used at 3599 s → accepted; at 3601 s → refused | Permit age | ISO | BVA | P0 |
| T4-10 | Wallet rejects claim signature → cancelled message, no record written, retry works | — | ISO | FULL | P1 |
| T4-11 | Claim while a wallet request is open → "request waiting", not "Failed" | — | ISO | RO | P1 |
| T4-12 | Transfer the SBT (direct, approve + transferFrom, marketplace) → reverts | Test transfer | ISO | SEC | P0 |
| M-25 | Claim the SBT twice → second refused | — | ISO | MAN | P0 |
| M-26 | Send the SBT to someone else → refused | — | ISO | MAN | P0 |
| T4-13 | Double-click Claim → one SBT, one permit row | Two clicks in 100 ms | ISO | SEC | P0 |
| T4-14 | Issue cooldown: 2nd permit request within 10 s → refused | Two requests | ISO | BVA | P1 |
| T4-15 | Issue cap: 20th permit request in a day OK, 21st refused | 21 requests | ISO | BVA | P1 |

### 4.7 Check-in (CHK, M-15 to M-18)

Check-in is a quiz plus an on-chain voucher. Expected total is `CORRECT_TOTAL_ENERGY` (20) on a correct answer, and the contract base otherwise. **G7: confirm the reward asset.**

| ID | Case (steps → expected) | Data | Env | Type | Pri |
|---|---|---|---|---|---|
| CHK-01 | Signed-in user sees the check-in button | QA_WALLET | ISO | RO | P0 |
| M-15 | Check in once → reward added | — | ISO | MAN | P0 |
| CHK-02 | Bonus by base: base 0 → bonus 20; base 10 → bonus 10; base 20 → 0; base 25 → 0 (never negative). Correct answer total 20; wrong answer total = base. | Contract base values | ISO | BVA | P0 |
| M-16 | Second check-in on the same UTC day → refused | — | ISO | MAN | P0 |
| CHK-03 | Day boundary: check in at 23:59:59Z → counts for that day; at 00:00:00Z → a new day, allowed again | Playwright clock | ISO | BVA | P0 |
| CHK-04 | Midnight grace: at 23:54:59Z voucher deadline is 23:55:00Z; at 23:55:00Z issuance refused | Clock | ISO | BVA | P0 |
| CHK-05 | Attempt window: 3 in 5 min OK; 4th inside 5 min refused; 4th after the first ages past 5 min OK | Clock | ISO | BVA | P0 |
| CHK-06 | Daily total: 20th attempt OK, 21st refused | 21 attempts | ISO | BVA | P1 |
| M-17 | Check in on consecutive days → streak goes up (day 7 pays the top rung). **G6.** | 3 and 7 days | ISO | MAN | P1 |
| M-18 | Miss a day → streak resets. **G6: grace day can keep it.** | Skip one day | ISO | MAN | P1 |
| CHK-07 | Energy shown on screen equals the ledger after reload | — | ISO | RO | P0 |
| CHK-08 | Quiz: the correct answer index is never in any response before answering | `/api/quiz/today`, `/api/quiz/answer` JSON | ISO | SEC | P0 |
| CHK-09 | Answer twice → second is `already_answered`, not graded again | Two submits | ISO | SEC | P0 |
| CHK-10 | Invalid answer index → 400, not graded | `-1`, `choices`, `"0"`, `1.5`, `null` | ISO | BVA | P0 |
| CHK-11 | No quiz answer → check-in works with no bonus | — | ISO | BVA | P1 |
| CHK-12 | Unregistered wallet → refused | NEW_WALLET_A | ISO | SEC | P0 |
| CHK-13 | Double-click check-in → one voucher, one transaction | Two clicks | ISO | SEC | P0 |

### 4.8 Quests (QST, M-19 to M-21)

| ID | Case (steps → expected) | Data | Env | Type | Pri |
|---|---|---|---|---|---|
| QST-01 | Signed-in user sees the quest list; each quest shows done or not | QA_WALLET | ISO | RO | P0 |
| M-19 | Open a quest link → recorded as opened | — | ISO | MAN | P0 |
| QST-02 | Second open of the same link does not reset the wait | Two opens | ISO | BVA | P1 |
| QST-03 | Gap boundary (15 s): claim at 14 s → too soon; at 15 s → passes the gap | Clock | ISO | BVA | P0 |
| QST-04 | Gap 0 (admin) → no wait; gap above 600 s → refused by admin | Gap 0, 600, 601 | ISO | BVA | P1 |
| QST-05 | Claim with no link open → `link_not_opened` | — | ISO | SEC | P0 |
| M-20 | Finish a quest → energy paid once | — | ISO | MAN | P0 |
| M-21 | Claim the same quest twice → refused | — | ISO | MAN | P0 |
| QST-06 | Telegram quest locked until Telegram is verified | QA_WALLET (not verified) | ISO | FULL | P0 |
| QST-07 | Prerequisite quest not done → locked; done → unlocked | Two linked quests | ISO | FULL | P1 |
| QST-08 | Quest list matches the ledger (sum of rewards) | — | ISO | RO | P0 |
| QST-09 | Voucher reuse margin 60 s: with 59 s left a new voucher is issued | Clock | ISO | BVA | P1 |
| QST-10 | Quest link schemes: `https` clickable; `javascript:`, `data:`, `file:` never rendered as links | Admin-entered URLs | ISO | SEC | P0 |
| QST-11 | Quest links open in a new tab with `rel="noopener noreferrer"` | — | ISO | UI | P1 |
| QST-12 | Reward amount is read server-side: client sends `amount: 999999` → ignored | Modified request | ISO | SEC | P0 |
| QST-13 | Quest for another wallet's ID → refused | Other wallet's quest ID | ISO | SEC | P0 |

### 4.9 Digging (DIG)

| ID | Case (steps → expected) | Data | Env | Type | Pri |
|---|---|---|---|---|---|
| DIG-01 | Seam tabs read "Silicon", "Lithium", "Rare earth" | — | ANY | RO | P1 |
| DIG-02 | One dig → Crew −3, one mineral added to the cart | 30 Crew | ISO | FULL | P0 |
| DIG-03 | Dig with no items left (energy 2) → "insufficient Crew" with a path to quests | (2, 0) | ISO | BVA | P0 |
| DIG-04 | Daily cap reached → different wording and a countdown to the next day | (600, 20) | ISO | BVA | P0 |
| DIG-05 | "Dig what is left" count: (30, 0) → 10; (12, 2) → 4; (600, 18) → 2; (2, 0) → 0, button disabled | `DIG_STATES` | ISO | BVA | P0 |
| DIG-06 | Cap maths: (600, 19) → 1; (600, 20) → 0 | — | ISO | BVA | P0 |
| DIG-07 | Exactly 3 Crew → 1 dig → 0 Crew | (3, 0) | ISO | BVA | P0 |
| DIG-08 | Put back: 20th put-back OK, 21st refused | 21 put-backs | ISO | BVA | P1 |
| DIG-09 | Leave a record: 2 per day OK, 3rd refused | 3 runs | ISO | BVA | P1 |
| DIG-10 | Record batch limit: 100 items OK, 101 refused. **Verify.** | 101 items | ISO | BVA | P1 |
| DIG-11 | Record shows pending until the chain confirms. Success text alone is not confirmation. | — | ISO | FULL | P0 |
| DIG-12 | Seam chosen → 60% of outcomes match it, 20% and 20% the others (seeded RNG, 10,000 digs, ±2 pts) | Seed | ANY | UNIT | P0 |
| DIG-13 | No dig is ever empty (1,000 seeded digs, zero empty results) | Seed | ANY | UNIT | P0 |
| DIG-14 | Tapping the centre digs; face at most 52 dvh; strike button in bottom third (G10) | 360×640, 390×844, 1440×900 | ANY | UI | P1 |
| DIG-15 | Five rapid taps → Crew falls by exactly 3 × accepted digs; never negative | Five taps | ISO | SEC | P0 |
| DIG-16 | Daily count resets at UTC midnight | Clock 23:59:59Z → 00:00:00Z | ISO | BVA | P1 |
| DIG-17 | Empty cart shows "Nothing here yet" | — | ISO | RO | P2 |

### 4.10 Materials (MAT, "Collection")

| ID | Case (steps → expected) | Data | Env | Type | Pri |
|---|---|---|---|---|---|
| MAT-01 | All mineral types shown, owned and unowned | — | ISO | RO | P0 |
| MAT-02 | Unowned names visible (no "?" placeholders); only a subtle visual difference | — | ISO | UI | P1 |
| MAT-03 | Total score at top = sum of held goods' weights. Ladder: 4, 22, 132, 858, 6,006, 45,045. | 1 tier-0 = 4; 2 tier-0 = 8; 1 tier-0 + 1 tier-1 = 26 | ISO | BVA | P0 |
| MAT-04 | Total updates live after dig, refine or sell | — | ISO | FULL | P0 |
| MAT-05 | Rankings button goes to Ranks; Back returns to Materials | — | ISO | UI | P1 |
| MAT-06 | No goods → score 0 (not blank, NaN or undefined) | New wallet | ISO | BVA | P1 |
| MAT-07 | Large numbers formatted; no overflow at 360 px | 45,045 and 1,000,000 | ISO | UI | P2 |
| MAT-08 | Enlarged mineral detail readable at 360 px (G10) | 360 px | ISO | UI | P1 |
| MAT-09 | Materials match server holdings after reload and in a second tab | — | ISO | RO | P0 |

### 4.11 Forge and Market (FRG, MKT, "Register")

Forge = route shell; Market = sell and buy. **G9.**

| ID | Case (steps → expected) | Data | Env | Type | Pri |
|---|---|---|---|---|---|
| FRG-01 | `?view=market` (or `?tab=mine&screen=market`) opens Market; Back and Forward restore the screen | — | ISO | UI | P1 |
| MKT-01 | Register (sell): price per ore = 45 · 5^grade credits (45 / 225 / 1,125) | Grade 0, 1, 2 | ISO | RO | P0 |
| MKT-02 | Quantity boundary: 0 → disabled; 1 → ok; owned → ok; owned + 1 → refused | Owned = 5 | ISO | BVA | P0 |
| MKT-03 | Registered items show "being sold" with time elapsed | Day 0 and day 5 | ISO | RO | P0 |
| MKT-04 | Schedule boundary: day 14 not complete; day 15 complete; day 16 stays at the 15-day total | Clock | ISO | BVA | P0 |
| MKT-05 | No cancel control on registered items. Unmark is available only before signing. | — | ISO | SEC | P0 |
| MKT-06 | Claim: disabled at 0 claimable; enabled at 1 | — | ISO | BVA | P1 |
| MKT-07 | Buy price = PAY × 3 by grade: 135 / 675 / 3,375. Grades 3+ not sold. | Grades 0, 2, 3 | ISO | BVA | P0 |
| MKT-08 | Buy with credits exactly equal to price → allowed; price − 1 → refused | Balance 135 / 134 | ISO | BVA | P0 |
| MKT-09 | Buy quantity 0, −1, 1.5, 1e6 → refused; balance unchanged | — | ISO | SEC | P0 |
| MKT-10 | Client price edited (DOM or request) → server charges the server price | Modified request | ISO | SEC | P0 |
| MKT-11 | Double-click buy → one debit | Two clicks | ISO | SEC | P0 |
| MKT-12 | Available credits update after purchase | — | ISO | FULL | P1 |

### 4.12 Refine (RFN)

| ID | Case (steps → expected) | Data | Env | Type | Pri |
|---|---|---|---|---|---|
| RFN-01 | Only owned items selectable; zero owned → no selection, explanation | 0 owned | ISO | BVA | P1 |
| RFN-02 | Selected items group at the top (G10) | 3 selected | ISO | UI | P1 |
| RFN-03 | Five of one grade → Refine enabled; four → disabled. **Verify (G11).** | 4 / 5 same grade | ISO | BVA | P0 |
| RFN-04 | Mixed grades 4 + 1 → refused. **Verify (G11).** | 4 tier-0 + 1 tier-1 | ISO | BVA | P1 |
| RFN-05 | One animation, then "Refining complete" | — | ISO | UI | P1 |
| RFN-06 | Reduced motion: no animation, final state shown | Reduced motion | ISO | UI | P2 |
| RFN-07 | Result (improve or ground down) updates the list with no duplicate items | — | ISO | FULL | P0 |
| RFN-08 | Refine disabled while a transaction is pending | — | ISO | UI | P1 |
| RFN-09 | Refine result matches server after reload | — | ISO | RO | P0 |

### 4.13 Rank, Holdings, Record (RNK, HLD, REC)

| ID | Case (steps → expected) | Data | Env | Type | Pri |
|---|---|---|---|---|---|
| RNK-01 | Podium (1st–3rd) at top, then full list (incremental load) | — | PRV | RO | P0 |
| RNK-02 | Two top tabs: Holdings and Record; switching keeps state | — | PRV | RO | P1 |
| RNK-03 | Own rank shown; zero score → "not ranked yet", no crash | New wallet | ISO | BVA | P1 |
| RNK-04 | Page boundary: 0 rows, 1 row, last page; no duplicates across pages | Page sizes | PRV | BVA | P1 |
| RNK-05 | Another wallet's address in the URL is ignored; only own private data | `?wallet=<NEW_WALLET_A>` | ISO | SEC | P0 |
| HLD-01 | Holdings board: higher score ranks above lower; ties follow the stated rule | 4 vs 0; 8 vs 8 | PRV | BVA | P0 |
| HLD-02 | Holdings score equals Materials total (MAT-03) | QA_WALLET | ISO | RO | P0 |
| HLD-03 | Podium member's minerals and assets viewable (G10) | Top-3 wallet | PRV | RO | P1 |
| REC-01 | One point per tap that reached the chain; pending taps not counted | 0 / 1 pending / 1 landed → 0 / 0 / 1 | ISO | BVA | P0 |
| REC-02 | Day boundary: a record at 23:59:59Z counts today; at 00:00:00Z counts tomorrow | Clock | ISO | BVA | P1 |
| REC-03 | Board labelled "Records", not DAU or "actions" | — | ANY | RO | P1 |
| REC-04 | Record scores and holdings scores are not multiplied or mixed | — | ANY | UNIT | P1 |

### 4.14 Rules (RUL)

| ID | Case (steps → expected) | Data | Env | Type | Pri |
|---|---|---|---|---|---|
| RUL-01 | Numbers on the Rules page equal the constants: COST 3, CAP 20, SAFETY 20, ASSET_DAYS 15, FUSE 5 | `economy.ts` | ANY | UNIT | P0 |
| RUL-02 | No claim the code does not back: no "may obtain nothing"; holdings do not count double | Text scan | ANY | UNIT | P0 |
| RUL-03 | `?screen=rules` deep link opens Rules; Back works | — | ANY | UI | P1 |
| RUL-04 | Rules readable at 360 px; keyboard can open and close each section | — | ANY | UI | P1 |

## 5. Security (cross-module)

| ID | Case (steps → expected) | Data | Env | Type | Pri |
|---|---|---|---|---|---|
| SEC-01 | Wallet-scoped APIs take identity from the session only. A wallet or address in body or query is ignored. | `/api/energy/history`, `/my-mine/run`, `/api/notifications`, quest and check-in routes | ISO | SEC | P0 |
| SEC-02 | Protected APIs without a session → 401 | — | ANY | SEC | P0 |
| SEC-03 | Cron endpoints need the bearer secret; missing, empty, `Bearer ` or wrong → 401 | Four variants | ANY | SEC | P0 |
| SEC-04 | Admin pages and `/api/admin/*` need an admin session; a wallet session is not admin | P05/P06 existing | ANY | SEC | P0 |
| SEC-05 | Admin role without permission → 403 for restricted actions | Restricted role | ISO | SEC | P0 |
| SEC-06 | State-changing POST from another origin with the cookie → refused | `Origin: https://evil.example` | ISO | SEC | P0 |
| SEC-07 | Security headers present: CSP, `frame-ancestors` / `X-Frame-Options` (clickjacking on Join), HSTS, `no-store` on session | Response headers | ANY | SEC | P0 |
| SEC-08 | Numeric parameters bounded: `page` −1, 0, 1, 1e9, `abc`, `1.0`, 2^53 → 400, never 500 | List above | ISO | BVA | P0 |
| SEC-09 | Stored/reflected XSS: `<img src=x onerror=alert(1)>`, `"><svg onload=alert(1)>` in quest names, Telegram names, admin text → escaped | Payloads | ISO | SEC | P0 |
| SEC-10 | SQL injection in email, wallet and key fields: `' OR '1'='1`, `'; DROP TABLE x--` → 400 or harmless; no 500 | Payloads | ISO | SEC | P0 |
| SEC-11 | Time-based SQL injection: `'||pg_sleep(2)--` → no delay | Payload | ISO | SEC | P1 |
| SEC-12 | Cross-context replay: a signature from preview replayed on production → refused (chain ID and domain) | PRV signature | ISO | SEC | P0 |
| SEC-13 | Logout invalidates the server session: old cookie → 401 | Saved cookie | ISO | SEC | P0 |
| SEC-14 | Errors leak no stack, SQL, env names or versions | Malformed JSON, unknown route | ANY | SEC | P0 |
| SEC-15 | Body size: exactly the limit accepted; one byte over → 413 | `MAX_BODY_BYTES` ± 1 | ISO | BVA | P1 |
| SEC-16 | Sensitive files not served: `/.env`, `/.git/config`, source maps | — | ANY | SEC | P0 |
| SEC-17 | Rate limits on every issue path hold (email, IP, wallet, check-in, permit, quest) | §3 constants | ISO | SEC | P0 |
| SEC-18 | Sponsored-gas abuse: repeated claim or check-in attempts stop at the burst gate | Loop | ISO | SEC | P0 |
| SEC-19 | Session cookie `HttpOnly`, `Secure`, `SameSite` | Cookie flags | ANY | SEC | P0 |
| SEC-20 | Telegram webhook: refuses replays older than the accepted window (**verify**) | Old timestamp | ISO | SEC | P1 |
| SEC-21 | Mixed content absent on every module page | Console and network | ANY | SEC | P1 |

## 6. Web and UI (cross-module)

| ID | Case (steps → expected) | Data | Env | Type | Pri |
|---|---|---|---|---|---|
| UI-04 | Every module screen: no horizontal scroll at 360, 390, 768 and 1440 px (`scrollWidth ≤ innerWidth`) | Four widths | ANY | UI | P0 |
| UI-05 | No uncaught errors and no hydration warnings on any module | Console | ANY | UI | P0 |
| UI-06 | Reload keeps the screen and selection (`?screen=`); Back and Forward restore them | — | ANY | UI | P1 |
| UI-07 | Second tab shares the session; logout in one tab stops actions in the other | Two tabs | ISO | UI | P1 |
| UI-08 | Account switch mid-action clears previous account data and closes confirmation modals | NEW_WALLET_B | ISO | UI | P0 |
| UI-09 | Every action reachable by keyboard; focus visible; buttons have names; status is not colour-only | Tab order | ANY | UI | P1 |
| UI-10 | Reduced motion respected on dig reveal, refine, toasts | Reduced motion | ANY | UI | P2 |
| UI-11 | API delayed 5 s → loading shown, no frozen screen; timeout gives a plain message | Delay injection | ISO | UI | P1 |
| UI-12 | Double-click every write button (Join, Send, Claim, Buy, Dig, Refine, Register, Check in) → one action | Two clicks | ISO | UI | P0 |
| UI-13 | Long and non-ASCII names truncate with an ellipsis, not overflow | "Zoë Nguyễn-Ødegård", 60+ characters | ISO | UI | P1 |
| UI-14 | No `undefined`, `NaN`, `[object Object]` or raw key names in visible text | DOM text scan | ANY | UI | P0 |
| UI-15 | Number format: thousands separators, no overflow | 1,000 · 45,045 · 1,000,000 | ANY | UI | P2 |

## 7. Boundary value index

| Boundary | Values tested | IDs |
|---|---|---|
| Email length | 254 accepted, 255 refused | T3-04 |
| OTP length | 5 refused, 6 accepted, 7 refused | T3-13 |
| OTP attempts | 1 wrong → 4 left; 4 → 1; 5 → discarded | T3-14, T3-15 |
| OTP expiry | 9:59 ok, 10:00 refused | T3-16 |
| Resend cooldown | 59 s disabled, 60 s enabled | T3-17 |
| Daily send limits | email 10 / 11; IP 30 / 31; wallet 20 / 21 | T3-18 to T3-20 |
| Token expiry | 899 s ok, 900 s refused (verify) | T2-03 |
| Permit lifetime | 3,599 s ok, 3,601 s refused | T4-09 |
| Permit cooldown and cap | 10 s; 20 per day | T4-14, T4-15 |
| Check-in day | 23:59:59 vs 00:00:00 | CHK-03 |
| Check-in grace | 23:54:59 issued, 23:55:00 refused | CHK-04 |
| Check-in attempts | 3 per 5 min; 20 per day | CHK-05, CHK-06 |
| Check-in bonus | base 0 / 10 / 20 / 25 | CHK-02 |
| Quest gap | 14 s too soon, 15 s ok; max 600 s | QST-03, QST-04 |
| Dig states | (2,0), (3,0), (12,2), (30,0), (600,18), (600,19), (600,20) | DIG-03 to DIG-07 |
| Put-backs and record runs | 20 / 21; 2 / 3; batch 100 / 101 | DIG-08 to DIG-10 |
| Refine | 4 vs 5 same grade | RFN-03 |
| Sell quantity | 0; owned; owned + 1 | MKT-02 |
| Sell schedule | day 14, day 15, day 16 | MKT-04 |
| Buy price | balance = price ok; price − 1 refused | MKT-08 |
| Score ladder | 4, 22, 132, 858, 6,006, 45,045 | MAT-03 |
| Record day | 23:59:59 vs 00:00:00 | REC-02 |
| Numeric API params | −1, 0, 1, 1e9, 2^53 | SEC-08 |
| Body size | limit ± 1 byte | SEC-15 |

## 8. Run log

Add a row for each run. Newest at the top. Existing rows stay in the acceptance sheets.

| Date | Test ID | Env | Result | Run by | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |
