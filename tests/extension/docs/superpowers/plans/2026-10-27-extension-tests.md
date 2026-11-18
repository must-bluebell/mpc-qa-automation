# Extension Playwright Implementation Plan

Goal: Exercise the packaged MPC extension and its wallet dashboard with reproducible browser tests and an HTML report.
Architecture: Install the existing unpacked build in a disposable Chromium profile per test. Drive real UI and cryptography; intercept all HTTP(S), simulate BSC JSON-RPC, and reject unknown network calls. Use a public BIP39 test wallet and the supplied address only as a recipient.
Tech stack: TypeScript, Playwright Test, viem for ABI responses and transaction verification.

- [x] Create isolated browser fixture, package/config, RPC mock, and onboarding helpers.
- [x] Add creation/import and password validation tests, including invalid phrases and backup verification.
- [x] Add dashboard, receive, lock/unlock, settings persistence and permission assertions.
- [x] Add invalid send cases and mocked signed transfers, asserting recipient, amount, chain and receipt outcome.
- [x] Run tests, investigate failures, type-check, and publish local HTML/JSON results.

Constraints: Do not use the user's Chrome profile or wallet secrets. No live RPC fallback. Source/package remain unchanged. Dashboard means extension home unless a separate URL is supplied. This suite does not prove live testnet settlement or website integration (the extension has no injected provider).

Review: Added independent checks of the signed token contract and zero native value; RPC rejects unexpected contract destinations. Reload persistence test reopens Settings because the popup uses in-memory navigation. Final suite results are stored in test-results/results.json.
