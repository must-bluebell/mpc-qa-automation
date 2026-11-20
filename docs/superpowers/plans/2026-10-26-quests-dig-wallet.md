# Verify Quests, Digging Process, Wallet Transaction, and UI Content

Implement the supplied 17-step case in the existing Playwright Chromium suite, with desktop and mobile read-only checks and one explicitly enabled state-changing journey. Reuse the configured wallet and existing sign bridge. Do not alter unrelated working changes.

- [x] Add a focused page helper for quest/API reconciliation, counters, progress, content, and saved run reads using the application's protocol headers.
- [x] Add desktop/mobile checks for both quest lists, expandable content, dig state, session identity, and refresh persistence.
- [x] Add a no-retry journey that consumes available digs, rejects signing, injects one definitive relay refusal, then approves exactly one validated cart signature and checks the actual receipt and persisted record.
- [x] Register the spec and npm command; document configuration, coverage, and limitations.
- [x] Typecheck, list the new cases, run live read-only tests, and report state-changing coverage separately.

The cart is a gasless opBNB RecordFor signature relayed on-chain. The test must not pretend there is an extension confirmation window or an eth_sendTransaction request. Quest requirements becoming satisfied may enable Claim; Completed means reward claimed. Quest claims are outside this cart-only authorization. UI assertions must distinguish eligibility from claimed rewards.

The write journey uses QA_RUN_QUEST_DIG_CART=1 and retries=0 because it consumes real Crew and a daily cart allowance. Exact signing requires an empty starting cart with no outstanding Crew use; the cumulative energy target is the independently read spent balance plus fresh digging cost; other starting states are explicitly blocked. A cart that fills before all digs are exhausted is reported as a precondition block: this case requests one final cart transaction. Injecting a definitive relay refusal tests client recovery, not a mined revert. Screenshots and text evidence support editorial review; automated baseline and layout checks cannot establish arbitrary prose is grammatically correct.

Validation: TypeScript and test discovery passed. Live desktop/mobile checks passed (2); the cart journey was skipped because its opt-in flag was unset. An additional account-menu inspection encountered the external Telegram membership gate. The real write path has received static review but has not been executed.
