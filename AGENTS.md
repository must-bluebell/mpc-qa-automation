# Test execution workflow

The user requires application test suites (API, browser regression, UAT, extension,
load, smoke, and full runs) to be triggered through the deployed Render dashboard:
https://qa-automation-bq3y.onrender.com

- Use the deployed dashboard's authenticated run API or its UI. Verify the returned
  run ID and retrieve results from that deployment before reporting an execution.
- Do not substitute a local pipeline or direct Playwright run. Local application
  suite execution requires an explicit user exception to this requirement.
- If dashboard authentication or the requested environment is unavailable, report
  the blocker. Do not weaken authentication or production write protections.
- Keep access tokens private. Read credentials from local configuration; never put
  them in source, command arguments, reports, or chat.
- Distinguish a Render-triggered run from a local run, and discovery from execution.
- Unit checks of tooling changes are separate from application suite execution;
  they do not establish that the deployed version was tested.

The user has authorized pushing the fixes for API skips, lost run results, and
dashboard recovery. Keep unrelated existing workspace changes out of those commits.
