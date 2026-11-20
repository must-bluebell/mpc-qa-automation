# Conversational Slack QA Implementation Plan

**Goal:** Extend the existing Slack app with evidence-based questions and authorized, confirmed, durable reruns.
**Spec:** docs/superpowers/specs/2026-10-23-slack-agent-design.md
**Architecture:** Separate Socket Mode service, deterministic routing, optional read-only model, private file inbox consumed by scheduler. Existing test and notification pipeline remains authoritative.
**Tech stack:** Node ESM, Slack Bolt, node:test.

## Global constraints
Preserve QA_EXTERNAL_REPOSITORIES=0 and existing changes. No production writes/load, arbitrary commands, raw evidence publication, token logging, pushes or Slack configuration changes. Local application stack is unavailable and must not be rebuilt from the sibling checkout.

## Review focus
- Redelivered events, duplicate clicks and crash between scheduler persistence and inbox acknowledgment must not duplicate tests.
- Revoked permissions, cross-user/channel confirmations and expired requests must fail closed.
- Concurrent scheduled work must retain one pipeline worker and queued Slack jobs across restarts.
- Malicious questions, test data and model output must not leak secrets or trigger tools.
- Slack network ambiguity must not cause blind reply resends.

## Tasks
1. Policy and durable inbox: write failing tests for validation, confirmation binding/expiry, cancellation, deduplication, restart/revocation and scheduler consumption. Implement settings/store/queue and scheduler integration. Verify node --test tests/reporting/slack-agent*.test.mjs tests/reporting/scheduler.test.mjs.
2. Evidence answers and controller: failing tests for sanitized source-linked answers, missing runs, deterministic routing, authorized reruns, duplicates and completion replies. Implement answers/controller and optional bounded read-only model explanations. Verify the same tests.
3. Socket Mode and operations: failing lifecycle tests; implement listener entry point, manifest, dependency, npm command, opt-in container supervision and documentation. Verify typecheck, reporting, dashboard, Python plans, copy checks and diff checks. Do not run broken-stack browser suites as if they could pass.
4. Independent final code review; fix important findings and rerun affected/full checks. Leave live activation explicitly pending absent Slack app token and installation changes.

## Progress
- Planning complete. User delegated remaining implementation choices.
- Existing branch chore/ollama-ai-review and preexisting AI brief changes preserved; work remains reviewable in the shared IDE workspace. Native execution selected to avoid relocating active files and private runtime paths.

- Task 1 complete: identity/target policy, private atomic inbox, confirmation/cancellation, crash-safe scheduler handoff, queued-job reconciliation.
- Task 2 complete: deterministic source-linked answers, suite-scoped counts, optional tool-less model explanations, durable replies/completion polling.
- Task 3 complete: Socket Mode lifecycle, opt-in container supervision, manifest, npm commands, both dependency lockfiles and setup guide.
- Independent review completed. Important findings reproduced with failing tests and fixed: stale proposals exhausting limits, invalid saved timestamps bypassing expiry, unrelated suite failures in combined-run answers, and revocation after queue consumption. Removed inaccurate queue-order promise. Added dispatch exclusion on unreadable inbox and one-model-explanation concurrency bound.
- Dependency audit initially found an existing DOMPurify advisory in the report tool dependency tree; updated the transitive dependency within its supported range. npm audit now reports zero vulnerabilities.
- Live activation remains pending: private SLACK_APP_TOKEN and QA_SLACK_TEAM_ID are unset; feature stays disabled. Slack application configuration was not remotely changed. Existing local stack remains unavailable and repository restriction stays enabled.
- Final verification: Node 22 reporting tests 211 passed / 2 Linux-only skipped / 0 failed; dashboard 10 passed; Python plans 6 passed; TypeScript passed; npm audit 0 vulnerabilities; git diff --check passed. New Slack network/lifecycle tests use fakes; no live Slack events or application reruns were exercised. Existing scheduler remains running on its previously loaded code and must be restarted during activation.

## Follow-up: multiple channels and direct messages
- User authorized mentions across joined channels and separate one-to-one direct conversations. Added backward-compatible channel allowlist/wildcard plus independent DM toggle; enabled both in private local .env while retaining scheduled reporting destination and repository restriction.
- Added message.im subscription, im:history scope and writable App Home Messages tab in the manifest. Slack-side settings must be applied in the developer portal; local manifest changes do not apply them remotely. Live bot token already reports im:history granted.
- Confirmations, rate-limit retries and completion remain bound to their source conversation. DM jobs are marked private at inbox consumption and scheduler completion bypasses channel broadcasts. DM-only listener configuration requires no report channel.
- Independent review found legacy pending replies bypassing a newly narrowed conversational channel list. Added a failing regression and fixed the retry guard.
- Verification: Node 22 reporting 218 passed, 2 Linux-only skipped; dashboard 10 passed; TypeScript and git diff --check passed. Tests cover channel/DM routing, ignored group DMs and channel chatter, cross-conversation confirmation rejection, private DM completion and legacy retry revocation. No live user messages were sent for testing.
- Restarted listener and scheduler with new code after confirming no active application run.
