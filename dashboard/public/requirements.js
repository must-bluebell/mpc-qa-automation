export const testingRequirements = [
  { suite: 'api', name: 'API Testing', schedule: 'Every 30 minutes (Smoke), Nightly (Regression), On PR deployment', requirements: 'Authentication, authorization, API endpoints, business logic, error handling, duplicate requests, balance and reward validation', expected: 'All critical APIs working correctly; detect failures and regressions', slack: 'Failure alerts, recovery updates, nightly reports, PR results' },
  { suite: 'uat', name: 'Web UAT Testing', schedule: 'Every 30 minutes (Smoke), Nightly (Full UAT), On PR deployment', requirements: 'Wallet connection, dig, cart submission, transaction confirmation, rejection handling, error recovery', expected: 'Critical user journeys pass with correct UI and backend behavior', slack: 'Failed journey alerts, screenshots, browser traces, test summaries' },
  { suite: 'regression', name: 'Web Regression Testing', schedule: 'Nightly, On PR deployment', requirements: 'Existing web functionality, critical user flows, refresh, reconnect, duplicate submissions, transaction states', expected: 'Detect broken functionality after application changes', slack: 'Regression results, failed scenarios, screenshots, PR status' },
  { suite: 'load', name: 'Load / Performance Testing', schedule: 'Weekly', requirements: 'Response times, concurrent users, throughput, error rates, performance baselines', expected: 'Performance meets approved thresholds; regressions detected', slack: 'Weekly performance reports, threshold breach alerts' },
  { name: 'QA Scheduler, PR Checks & Slack Reporting', schedule: 'Every 30 minutes, Daily, Nightly, Weekly, Before PR merge', requirements: 'Schedule test execution, monitor runs, generate reports, detect missed runs, enforce PR quality checks, support Slack QA queries and authorized reruns', expected: 'Reliable automation, accurate reports, required PR checks passed before merging', slack: 'Daily QA summary, pass/fail notifications, recovery alerts, PR merge status, test evidence links' },
]

export const securityRequirements = [
  ['Authentication and session handling', 'Authentication cannot be bypassed; tokens, sessions, and logout behavior are secure.'],
  ['Authorization (BOLA/IDOR)', 'Users cannot access or modify records belonging to other users without permission.'],
  ['SQL injection', 'Database queries use parameterized statements; untrusted input cannot alter query logic.'],
  ['Unauthorized record/status changes', 'Only authorized roles can change records, approval states, or verification statuses.'],
  ['Sensitive data exposure', 'APIs, logs, responses, and errors do not expose passwords, tokens, PII, or confidential data.'],
  ['Invalid or hostile input', 'Inputs are validated server-side and safely handled, including malformed, oversized, and malicious payloads.'],
  ['Auditability and data integrity', 'Critical actions are logged appropriately, and important data changes preserve integrity.'],
  ['Concurrency and inconsistent updates', 'Simultaneous requests cannot cause duplicate operations, inconsistent states, or unauthorized transitions.'],
]
export const dashboardSuites = [...testingRequirements.filter(item => item.suite),
  { suite: 'qa-automation', name: 'QA Automation' }, { suite: 'health', name: 'System Health' }]
export const suiteLabel = name => dashboardSuites.find(item => item.suite === name)?.name
  ?? ({ full: 'Required tests', security: 'API Testing', 'security-validation': 'API & System Health Verification', smoke: 'API & Web Smoke', 'api-smoke': 'API Smoke', 'uat-smoke': 'Web UAT Smoke', 'critical-smoke': 'API & Web UAT Smoke', 'nightly-regression': 'Nightly Regression', 'daily-health': 'Daily System Health' })[name] ?? name

// Use the executed step's suite so security checks remain in API and wallet cases in regression.
export function suiteTestGroups(run) {
  const steps = new Map(run.steps.map(step => [step.name, step.fromSuite]))
  const groups = new Map()
  for (const test of run.tests) {
    const suite = steps.get(test.step) || run.suite
    if (!groups.has(suite)) groups.set(suite, { suite, label: suiteLabel(suite), tests: [] })
    groups.get(suite).tests.push(test)
  }
  return [...groups.values()]
}
