# MPC QA automation

GitHub Actions runs wallet regression after application PR merges, API checks every four hours, and a daily controlled load test. Results are sent to Slack with threaded details. Tests run against an isolated Docker stack on the GitHub runner.

See [GitHub and Slack setup](docs/github/README.md) for repository secrets, variables and the application merge trigger. See [local scheduler documentation](docs/slack-scheduler.md) for local operation and reporting behavior.

Requires Node.js 22.18 or newer. Install with `npm ci`; verify with `npm run typecheck` and `npm run test:reporting`.

Credentials, dependencies, generated reports, run history, local reference notes and the legacy preview workflow are excluded from this repository import.
