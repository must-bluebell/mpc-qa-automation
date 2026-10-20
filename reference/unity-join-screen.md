# 03. Join

**Purpose**: Use the wallet as the account, verify community membership and email, then issue a certificate. My Mine opens after the certificate is issued.

**Entry**: Any of the three home CTAs · Selecting a stage from the menu while disconnected
**Exit**: Certificate issued → Activity board · Close (progress is preserved)

---

## Wireframe

```
┌──────────────────────────────────────────────┐
│                                        [ ✕ ] │
│                                              │
│   ● ─── ○ ─── ○ ─── ○                        │  Step indicator
│   Wallet  Community  Email  Certificate      │
│                                              │
│   ┌────────────────────────────────────┐     │
│   │                                    │     │
│   │        Current step content        │     │  Replaced for each step
│   │                                    │     │
│   │  [      Primary action       ]     │     │
│   │                                    │     │
│   └────────────────────────────────────┘     │
│                                              │
│   Non-solicitation notice (body copy)         │
│   Terms link (new tab)                        │
│                                              │
│   [ Disconnect ]                             │  Only while connected
└──────────────────────────────────────────────┘
      Bottom sheet (for mobile wallet browsers)
```

---

## Steps

| # | Step | User action | Possible failures |
|---|---|---|---|
| 1 | Connect wallet | Select wallet → Connect | No wallet, connection rejected, pending request |
| 2 | SIWE signature | Approve signature | Rejected, request already pending |
| 3 | Community | Telegram login → Verify group membership | Not a group member, binding conflict |
| 4 | Email | Enter address → Verify code | Cooldown, daily limits (email/wallet/IP), delivery failure, incorrect or expired code |
| 5 | Certificate | Request issuance | Relay failure, gas sponsorship unavailable |

🔴 **Users leave for an external app twice** (Telegram and their inbox). Progress must remain when they return —
closing the sheet also preserves progress.

---

## Core features

1. **Step progression** — Each step depends on the previous step's result.
2. **Leave and return** — Wallet connection and signature remain when the sheet closes.
3. **Disconnect** — Users must be able to end a session on a shared device. Provide a path both in the sheet and on home.
4. **Issuance success presentation** — Move to the Activity board after certificate issuance. Only then show the four-step coachmark tour
   (`checkin` → `energy` → `crew` → `mine`).

---

## States

| State | Display |
|---|---|
| Pending wallet request | “Check the request in your wallet” + a stop-waiting button. **Do not label it “Failed”** |
| Email limit | Identify which limit applies (email/wallet/IP) |
| Delivery failure | Leave a retry path. Restore the consumed quota |
| Account switch detected | Clear all previous account state and show the reason |
| Issuance complete | Celebration screen → Board |

🔴 **Do not confuse “Pending” with “Failed.”** An active request in the wallet completes as soon as it is approved.
🔴 Close any open confirmation modal when the account changes. Otherwise, it could disconnect the new account.

---

## Data sources

| Value | Source |
|---|---|
| Step determination | Internal state in `JoinFlow.tsx` + `/api/home` |
| Email OTP | `/api/register/send-code`, `/verify-code` |
| Community verification | Telegram OIDC → `telegram_bindings` → `getChatMember` |
| Certificate issuance | Relay (`relay_sends`) or direct wallet transaction |
| Funnel records | `join_step_events` (`page_open`, `sign_ok`, `telegram_auth_start`, etc.) |

---

## Differences from the current implementation

✅ Everything is implemented. **Untouched in this work.**

🔴 **Under the minimum-scope policy (2026-09-21), the join flow and gates are outside the scope of changes.**
Even if gate lookup fails, `resolveGate` falls back to `join`, avoiding a state where users cannot do anything.

📌 For the record — Entry dropout fell from 20.6% → 8.1%. The current drop-off concerns
**the distance from signup to the first action**, rather than signup itself (about 45% of 81 weekly registrations had no activity on D1–D7).

---

## Handoff to design

- Step indicator format (dots, bars, numbers).
- Guidance on returning from an external app.
- Length of the certificate issuance celebration — Longer celebrations delay the first action.
- Whether to retain the four-step coachmark tour or replace it with performing the first action.
