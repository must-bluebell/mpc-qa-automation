# Conversational MPC QA agent

Extend the existing MPC QA Slack application using Socket Mode. The user selected the recommended transport and authorized implementation; this change covers the conversational agent only, not PR previews or infrastructure recovery.

The listener is a separate Node service. It accepts app mentions in the configured workspace/channel, answers status, latest runs, last passes, failures, evidence and schedules from sanitized stored results, and can explain unfamiliar questions using a bounded, tool-less advisory model. Model output cannot select or execute actions. Every factual answer identifies its source or states that evidence is missing.

Reruns accept configured suites and isolated environments only. Authorized users receive Confirm/Cancel buttons; confirmations expire in five minutes and are bound to user, workspace, channel and original thread. Duplicate events and confirmations must never create duplicate jobs. A private durable inbox records request identity, authorization, confirmation and execution IDs. The scheduler consumes the inbox under a short shared state lock, saves its own durable job before acknowledging consumption, and preserves queued Slack jobs during schedule reconciliation. Existing pipeline locking, scope restrictions, AI review and Slack reports remain authoritative. Completion replies return to the original thread. Ambiguous reply delivery is recorded and never blindly resent.

Approaches considered: Socket Mode (selected: no public ingress), HTTP events (requires an HTTPS endpoint), and slash commands alone (does not support the requested conversational mentions).

Defaults chosen by implementer: read access for members mentioning the app in the configured channel; rerun access limited to explicit user IDs or the existing owner; no DMs, arbitrary shell commands, arbitrary targets, raw evidence uploads or automatic infrastructure repair. AI explanations are optional; deterministic questions and commands work without a provider. Single active listener via a process lock. Agent disabled by default in container supervision until credentials/permissions are configured.

Live activation requires Slack app-level connections:write token, app_mentions:read, app_mention subscription, interactivity, workspace/channel IDs and app reauthorization. Preserve all existing volumes and QA_EXTERNAL_REPOSITORIES=0. Do not expose private tokens in output or reports.

## Follow-up: multiple channels and direct use

User authorized expanding channel access and using the agent separately via direct messages. This supersedes the initial single-channel/no-DM default for their installation. Add explicit channel allowlist (or * for invited channels) and a separate DM switch, preserving backward-compatible defaults for other installations. Reporting-channel configuration remains independent. Subscribe to message.im with im:history and enable writable App Home Messages. Replies, retries, confirmations and completion remain bound to the originating conversation. DM-initiated test jobs must not broadcast results into the reporting channel. Rerun user/target/workspace restrictions remain in force.
