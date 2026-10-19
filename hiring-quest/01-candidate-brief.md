# 🛡️ Vault Gate — 5-Day Quest

**Role:** AI-Native Quality Engineer · Zero-Touch Release · Security First

> Welcome! This quest replaces a classic "write some test cases" exercise. You get a small, realistic product with a real release problem. We want to see how you think, what you automate, what you break, and whether you would let it ship. There is no single correct answer.

---

## ⏱️ At a glance

| | |
|---|---|
| **Duration** | 5 calendar days (Day 1 → Day 5) |
| **Expected effort** | About 2–3 hours per day, **15 hours maximum in total** |
| **Preferred stack** | TypeScript + Playwright. Any language or framework is fine if you explain why |
| **AI tools** | Allowed and encouraged. Log how you used them (see the AI policy) |
| **Deliverable** | A private GitHub repo shared with the reviewers, plus a 20-minute live demo and Q&A on Day 5 |
| **Environment** | Runs fully on your laptop with Docker. No cloud account or paid API needed |

---

## 📖 The story

**Vault Gate** is a team treasury wallet. A company keeps funds in a shared *vault*. Moving money needs approvals from **2 of 3 approvers**, the same idea used by multi-signature and MPC wallets.

The product team just shipped a new feature: the **AI Transaction Explainer**. It writes a plain-English summary and risk level for every pending transaction, so approvers can decide faster.

Leadership has set a bold goal:

> **"Zero-touch release."** When the quality gate is green, a build goes to production automatically. No human QA sign-off.

You are the QA engineer who decides **what "green" means**. If your gate is weak, a bad build reaches real money. If it is noisy or flaky, the team will stop trusting it and switch it off.

---

## 📦 What you get

| Item | Details |
|---|---|
| **Starter app** | `docker compose up` starts everything |
| **Web UI** | http://localhost:3000. Includes a built-in **Dev Wallet** picker, so no browser extension is needed |
| **REST API** | http://localhost:4000 |
| **API docs** | http://localhost:4000/docs (OpenAPI) |
| **Test users** | `seed/users.json`. Five local-only test accounts with private keys |
| **Signing helper** | `npx vg-sign --user alice --message "<text>"` prints a valid signature |
| **Reset** | `POST /api/test/reset` restores seed data (local only) |
| **Template repo** | Folder structure and an empty CI workflow to start from |

### Test users

| User | Role | Vault |
|---|---|---|
| `alice` | Approver | Vault **A** |
| `bob` | Approver | Vault **A** |
| `carol` | Approver | Vault **A** |
| `dave` | Requester (can create, cannot approve) | Vault **A** |
| `mallory` | Approver | Vault **B** (a different company) |

> ⚠️ All keys are throwaway test keys for localhost only. Never use them anywhere else, and never put real keys in your repo.

---

## 📋 Product requirements

These are the official rules of Vault Gate. Use the IDs in your tests and bug reports.

| ID | Requirement |
|---|---|
| **VG-AUTH-01** | Sign-in uses a wallet signature over a server nonce (SIWE-style). Each nonce is **single-use** and expires after **5 minutes**. |
| **VG-AUTH-02** | A session belongs to exactly one wallet address. Logging out ends the session immediately. |
| **VG-ACC-01** | Users can only see and act on transactions in **their own vault**. |
| **VG-APR-01** | A transaction needs approvals from **2 distinct approvers** of its vault before it can be executed. |
| **VG-APR-02** | Only current vault approvers can approve. Requesters and outsiders cannot. |
| **VG-EXE-01** | An approved transaction executes **exactly once**, even under concurrent requests. |
| **VG-EXP-01** | A transaction expires **24 hours** after creation. Expired transactions cannot be approved or executed. |
| **VG-CAN-01** | Only the creator can cancel, and only before execution. |
| **VG-VAL-01** | Amount must be greater than 0, have at most 6 decimals, and be a plain decimal number. |
| **VG-VAL-02** | Recipient must be a valid EVM address (EIP-55 checksum when mixed case). |
| **VG-LIM-01** | A vault can move at most **10,000 USDC per rolling 24 hours** (total across all transactions). |
| **VG-AI-01** | The AI Explainer must describe the **real** transaction data (amount, asset, recipient). It treats the memo as untrusted user text and **never** declares a transaction "safe" or "verified". |
| **VG-SEC-01** | Secrets (API keys, private keys, session tokens) never appear in API responses, UI or logs. |
| **VG-UX-01** | Errors shown to users are human-readable. No stack traces or raw provider error codes. |

---

## 🔌 API summary

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/auth/nonce?address=` | Get a sign-in nonce |
| `POST` | `/api/auth/verify` | Send `{ message, signature }`, receive a session token |
| `POST` | `/api/auth/logout` | End the session |
| `GET` | `/api/vaults/:vaultId` | Vault details, members and daily usage |
| `POST` | `/api/vaults/:vaultId/transactions` | Create a transaction `{ to, amount, asset, memo }` |
| `GET` | `/api/transactions/:txId` | Transaction details and approval state |
| `POST` | `/api/transactions/:txId/approve` | Approve (signed) |
| `POST` | `/api/transactions/:txId/reject` | Reject |
| `POST` | `/api/transactions/:txId/execute` | Execute once approvals are met |
| `POST` | `/api/transactions/:txId/cancel` | Cancel (creator only) |
| `GET` | `/api/transactions/:txId/explain` | AI Explainer summary and risk level |
| `GET` | `/api/health` · `/api/version` | Health and build version |
| `POST` | `/api/test/reset` | Reset seed data (local test helper) |

Full request and response schemas are in the OpenAPI docs.

---

## 📜 Quest rules

1. **Stay on localhost.** Test only the Vault Gate stack running on your machine.
2. **Commit every day.** We read your git history, and small honest commits beat one giant final commit.
3. **Write a short daily update.** At the end of each day, add 3–5 lines to `DAILY.md`: what you did, what you learned, and what is next.
4. **Choose depth over breadth.** Ten meaningful, stable tests are worth more than a hundred shallow ones. Prioritise.
5. **Keep the time box.** If you hit 15 hours, stop and write down what you would do next. Knowing when to stop is part of the job.
6. **Ask if you're blocked.** Questions to the hiring contact are welcome and do not count against you.

## 🤖 AI policy

We are hiring an **AI-native** engineer, so we *expect* you to use AI assistants (Claude, ChatGPT, Copilot, Cursor and so on).

- Keep an `AI_LOG.md` with short entries: **task → tool → what it produced → what you changed or rejected, and why**.
- We value **judgment over volume**. Showing where AI was wrong and how you caught it is a strong signal.
- **Security first applies to AI too.** Never paste private keys, session tokens or secrets into an external AI tool. Redact first.
- You must be able to explain every line you submit during the Day 5 defense.

---

## 🗓️ Day-by-day plan

### Day 1 — Recon & Risk 🔍

**Goal:** Understand the product and decide what matters most before writing any test.

**Tasks**
- Run the app. Explore the UI and API as each user. Take notes.
- Write a **risk-based test strategy** (one page): what you will test, what you won't, why, and in what order.
- Write a lightweight **threat model** for two areas:
  1. The approval flow (sign-in → create → approve → execute)
  2. The AI Explainer
  Use STRIDE or any simple format: *asset → threat → impact → how I'll test it*.
- Build a **risk matrix**: list the top 10 risks with likelihood × impact.

**Deliverables:** `STRATEGY.md`, `THREAT_MODEL.md`, `DAILY.md` (Day 1)

**Done when:** a reviewer could read your strategy and know exactly what you'll test first, and why.

> 💡 Tip: Testers who map the money flow and the trust boundaries first usually find the serious bugs fastest.

---

### Day 2 — Automation Core ⚙️

**Goal:** Build a stable, readable automation foundation for the critical paths.

**Tasks**
- Set up the test project (Playwright + TypeScript recommended).
- Automate **API tests** for the happy path: sign-in → create tx → 2 approvals → execute → final state.
- Automate **1–3 UI end-to-end tests** for the most important user journey, using the Dev Wallet.
- Build the basics properly:
  - Programmatic sign-in helper (sign the nonce with the test key, no UI clicking)
  - Test data isolation: each test creates its own data or resets cleanly
  - Clear structure (page objects, API clients or whatever pattern you prefer, explained)
- Tests must pass **3 times in a row** with no flakes.

**Deliverables:** `tests/` with a working suite, a README section on how to run it, `DAILY.md` (Day 2)

**Done when:** `npm test` (or your equivalent) runs green locally from a fresh clone, three times in a row.

> 💡 Stretch: add a contract test that checks API responses against the OpenAPI schema.

---

### Day 3 — Security First: Break It 🔓

**Goal:** Think like an attacker. Find the defects that would lose money or trust.

**Tasks**
- Write negative and abuse tests against the requirements. Ideas to explore (not a complete list):
  - **Access control:** can one user see or act on another vault's data?
  - **Authentication:** can sign-in messages, nonces or sessions be reused or abused?
  - **Approval logic:** can the 2-of-3 rule be bypassed?
  - **Concurrency:** what happens when requests arrive at the same time?
  - **Business limits:** can the daily limit be avoided?
  - **Input validation:** amounts, addresses, memo content
  - **AI Explainer:** can user-controlled text change what the AI says? (prompt injection)
  - **Information leaks:** errors, logs and responses
- For each confirmed defect, write a **bug report** using the template below.
- Every confirmed bug should have an **automated regression test** that fails today and would pass once it's fixed. Mark these as expected failures, for example `test.fail()`, so the suite stays meaningful.

**Deliverables:** `BUGS.md` (or a `bugs/` folder), security tests in `tests/security/`, `DAILY.md` (Day 3)

**Done when:** every bug has a clear reproduction, a severity, a requirement ID and an automated test.

> 💡 Tip: Severity should reflect *business impact* (money, data, trust), not how hard the bug was to find.

---

### Day 4 — Zero-Touch Release 🚀

**Goal:** Turn your tests into a release gate the team can trust without a human in the loop.

**Morning surprise:** At the start of Day 4 we send you a **release candidate**, `vaultgate:1.1.0`, with its changelog. Your gate must decide whether it can ship.

**Tasks**
- Build a CI pipeline (GitHub Actions preferred) that:
  1. Starts the Vault Gate stack
  2. Runs your API, UI and security suites
  3. Runs a **dependency vulnerability scan** and a **secret scan** on your repo
  4. Produces a clear **PASS / FAIL release decision** with a reason
- Define your **gate policy** in `RELEASE_POLICY.md`:
  - What blocks a release? (for example, any critical or high security failure)
  - What only warns?
  - How do you handle **flaky tests**? Retry? Quarantine? Who owns them?
  - How do you stop known bugs (Day 3) from blocking forever without hiding new ones?
- Run your gate against **1.0.0** (baseline) and **1.1.0** (release candidate). Compare the results.
- Write `RELEASE_DECISION.md`: **ship or block 1.1.0, and why?**

**Deliverables:** `.github/workflows/quality-gate.yml`, `RELEASE_POLICY.md`, `RELEASE_DECISION.md`, `DAILY.md` (Day 4)

**Done when:** a single CI run gives an unambiguous verdict that a non-QA person can understand in 30 seconds.

> 💡 Stretch: add a post-deploy **smoke check** (`/health`, `/version`, one read-only journey) and describe an automatic rollback rule.

---

### Day 5 — AI Triage & Release Defense 🧠

**Goal:** Use AI to reduce triage time, then defend your release decision.

**Tasks (morning)**
- Build a small **AI-assisted triage step** that:
  - Reads your test results (JUnit, JSON or similar)
  - Groups failures by likely root cause
  - Drafts a short release summary and bug report drafts (Slack-style message or Markdown)
- Requirements for the triage step:
  - **Redact secrets** (keys, tokens, signatures) *before* anything goes to a model
  - Clearly separate **confirmed facts** (test results) from **AI suggestions** (likely causes)
  - Work without an API key: a rule-based fallback or a mocked model response is fine

**Tasks (afternoon): 20-minute live session with reviewers**
1. **5 min:** walk through your strategy and the top risks you chose
2. **5 min:** live run of your gate against 1.1.0
3. **10 min:** Q&A, including **"Would you ship 1.1.0 to production today? Defend it."**

**Deliverables:** `triage/` (script or tool), a sample output, `AI_LOG.md` complete, final `DAILY.md`

---

## 🐞 Bug report template

```markdown
### BUG-XX: <short, specific title>

- **Requirement:** VG-XXX-00
- **Severity:** Critical / High / Medium / Low
- **Build:** 1.0.0 (from /api/version)
- **Found by:** manual exploration / automated test / AI-assisted
- **Automated test:** tests/security/<file>.spec.ts › "<test name>"

**Steps to reproduce**
1. …
2. …

**Expected:** …
**Actual:** …

**Impact:** who is affected and what can go wrong (money, data, trust)
**Evidence:** request/response (redacted), screenshot, trace or log line
**Notes / suspected cause:** optional
```

### Severity guide

| Severity | Meaning |
|---|---|
| **Critical** | Funds can move without proper authorisation, or authentication can be bypassed |
| **High** | Another customer's data or actions are exposed, a business control is bypassed, or the AI misleads approvers |
| **Medium** | Wrong validation, data leaks with limited impact, broken rules with workarounds |
| **Low** | UX, copy, accessibility or cosmetic issues |

---

## 📁 Expected final repo structure

```
vault-gate-qa-<your-name>/
├── README.md              # how to run everything, in under 5 commands
├── STRATEGY.md            # Day 1
├── THREAT_MODEL.md        # Day 1
├── BUGS.md                # Day 3
├── RELEASE_POLICY.md      # Day 4
├── RELEASE_DECISION.md    # Day 4
├── AI_LOG.md              # all days
├── DAILY.md               # all days
├── tests/
│   ├── api/
│   ├── ui/
│   └── security/
├── triage/                # Day 5
└── .github/workflows/
    └── quality-gate.yml   # Day 4
```

---

## ✅ Submission checklist

- [ ] Repo is private and shared with the reviewer accounts
- [ ] Fresh clone → README steps → suite runs
- [ ] All Markdown deliverables are present
- [ ] Every bug has a requirement ID, severity and automated test
- [ ] CI gate gives PASS/FAIL with a reason for both 1.0.0 and 1.1.0
- [ ] `AI_LOG.md` is honest and complete
- [ ] No real secrets anywhere in the repo or its history
- [ ] Final commit pushed before the Day 5 session

---

## 📊 How you'll be evaluated

| Area | Weight |
|---|---|
| Risk thinking, strategy and threat model | 15% |
| Automation quality: structure, stability, readability | 20% |
| Defects found and bug report quality | 25% |
| Release gate design and release decision | 20% |
| AI usage and AI triage | 10% |
| Communication and live defense | 10% |

We care most about **judgment**: choosing the right things to test, explaining trade-offs, and making a clear release call.

---

## ❓ FAQ

**Do I need to know MPC or blockchain?**
No. Vault Gate borrows the *idea* of multi-party approval. Everything you need is in this brief and the API docs. The signing helper handles the cryptography.

**Can I use a different stack than Playwright?**
Yes. Briefly explain your choice in the README.

**Can I modify the Vault Gate app?**
No. Treat it as a black box from another team. You may read the API docs and logs (`docker compose logs`).

**What if I can't finish everything?**
That's normal. Write down what you skipped and why. Good prioritisation scores well.

**Is there a list of hidden bugs?**
Yes, we planted some. We also value real issues we didn't plant, and well-reasoned "not a bug" decisions.

Good luck, and have fun breaking things. 🚀
