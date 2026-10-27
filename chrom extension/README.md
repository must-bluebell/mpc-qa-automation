# MPC extension browser tests

Independent Playwright project for the packaged MPC Wallet Dev extension, including its wallet dashboard. Tests run the real packaged popup in Chromium with a clean temporary profile per test; they do not touch your installed Chrome profile or rebuild the source.

## Run

```sh
npm ci
npx playwright install chromium
npm test
npm run report
```

- `npm run test:dashboard`: dashboard, receive, lock/unlock, settings and network-state tests.
- `npm run test:headed`: run all tests with visible browser windows.
- `npm run test:ui`: interactive Playwright test dashboard.
- `npm run typecheck`: validate TypeScript.
- HTML report: `playwright-report/index.html`.
- Machine-readable report: `test-results/results.json`.
- Failed tests include a browser trace and screenshots. Each test includes a mocked RPC summary.

The default build is `~/Downloads/mpc-wallet-dev-0.1.0.0`. Override it with:

```sh
EXTENSION_PATH=/absolute/path/to/unpacked-extension npm test
```

The mock pins the supplied build’s token contract to `0x22084835Ba9f17101706929283eb3Fa0c08f3d04`; testing another contract requires an intentional fixture update.

The manifest must contain a public `key`; the fixture derives the extension ID from it. This build has no service worker, so the usual Playwright service-worker ID discovery does not apply. The fixture uses Playwright's bundled Chromium and a persistent context as documented at https://playwright.dev/docs/chrome-extensions.

## Coverage

| Area | Cases |
| --- | --- |
| Onboarding | Create with random backup verification and incorrect-answer rejection; import public fixture; invalid word count, unknown words, checksum |
| Password validation | Short, numeric-only, repetitive, oversized, mismatched confirmation; masked fields |
| Dashboard | MPC/BNB balances, history navigation, empty BNB warning, wrong-token blocking, network failure/retry |
| Receive | Imported account address, QR presence, copy feedback and network warning |
| Security/settings | Lock/wrong-password/unlock, persisted locale and auto-lock preference, password change, gated phrase reveal, removal confirmations, lockout persistence |
| Sending | Malformed/zero/self address; zero/negative/overprecise/overbalance amounts; required fields and Max; fee ceiling; insufficient gas; wrong password; wrong chain |
| Simulated transactions | Real local signing, exact token contract/recipient/amount/chain/sender and zero-native-value assertions, one broadcast, success and failed receipts |
| Transfer boundaries | Exactly 0.01 MPC, smallest token unit, full balance, one unit over balance, missing recipient/password, leaving review without broadcasting; simulated transfer evidence attached to report |
| Languages | English, Korean, Chinese and Mongolian: settings sections/security gates, all four auto-lock choices persisted across reload, transfer form/review/confirmation/failure copy, and ten invalid inputs per language |
| Requested transfers | Simulated 0.001 MPC to `0xee86a8e2F4343a0E969C3b74309F431bEee74f66`, plus three sequential 1 MPC transfers per language with distinct nonces/hashes; signed data, receipt polling and explorer links verified |
| Permissions | Installed manifest and granted permissions, storage-only, no host access/content scripts/external connection, restrictive script CSP |

## Test data and scope

The supplied address `0xe46d2a8c9ae04517373b8c9c468dfa5db2d381df` is used as the transfer recipient. A public address cannot import or unlock that wallet. Import and signing use the well-known public BIP39 test phrase in `tests/helpers/wallet.ts`, deriving `0x9858EfFD232B4033E47d90003D41EC34EcaEda94`. Never fund this test wallet or substitute a real recovery phrase: failure artifacts may include test inputs.

Every HTTP(S) request is intercepted. Only the expected BSC RPC host receives simulated responses; unknown hosts/methods are blocked and fail the test. There is no live transaction mode or fallback. Simulated balances are 1,000 MPC and 1 BNB by default. No actual transfers or recipient balance changes occur.

“Dashboard” currently means the extension's wallet home screen. No separate website URL was supplied. This package injects no web provider, so connected website wallet flows are outside this suite. These checks do not prove live BSC settlement, production build behavior, QR decoding, long-duration auto-lock timing, or compatibility with every Chrome release.

## Language and requested-recipient checks

Run `npx playwright test languages` for this matrix. The report includes settings/confirmation screenshots and JSON evidence for each successful simulated transfer. `tests/helpers/locale-copy.json` pins the supplied package's English, Korean, Chinese and Mongolian strings; tests compare rendered labels and errors against that snapshot. This catches missing text, wrong-language fallback and copy changes, but does not certify linguistic accuracy. Legal/help links are checked for HTTPS destinations, not visited. Auto-lock preference persistence is checked for 1, 2, 5 and 15 minutes; elapsed-time locking is not measured.

The RPC mock advances the account nonce after each broadcast so repeated transfers have distinct signatures and hashes. It does not maintain token balances or synthesize transfer history. The new recipient is used only by `languages.spec.ts`; previous regression cases retain their original recipient. No live funds are moved.

## Project import

Copied from `/Users/mac/MPC Extension` on 2026-10-27. Playwright discovers **64 cases in seven spec files**; the original saved result also records 64 passed cases. The requested 65th case was not present in that source. `case-catalog.json` lists every discovered case with its source location.

From the parent project use `npm run test:extension`, `npm run typecheck:extension`, or `npm run report:extension -- --port 9323`. The extension suite remains a separate package to preserve its Playwright/TypeScript versions. Its scripts do not load the parent Slack pipeline.
