import { defineConfig, devices } from '@playwright/test'
import dotenv from 'dotenv'
import { target } from './config/target'

dotenv.config()

const t = target()
// Set by the pipeline orchestrator so each run keeps its own report instead of overwriting playwright-report/.
const reportDir = process.env.QA_REPORT_DIR
// Set by the orchestrator to one directory per run, so all Playwright steps feed a single Allure report.
const allureResults = process.env.QA_ALLURE_RESULTS_DIR

export default defineConfig({
  testDir: './tests',
  // All tests use one configured account and must not race its session.
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  // A remote target over the public internet is slower than a local server; the wallet probe alone
  // is allowed a second, and SIWE adds two server round trips.
  timeout: 120_000,
  expect: { timeout: 30_000 },

  reporter: [
    ['list'],
    ['html', { open: 'never', ...(reportDir ? { outputFolder: `${reportDir}/html` } : {}) }],
    ...(reportDir ? [['json', { outputFile: `${reportDir}/results.json` }] as const] : []),
    ['./utils/regression-reporter.ts'],
    ...(allureResults ? [['allure-playwright', { resultsDir: allureResults }] as const] : []),
  ],
  ...(reportDir ? { outputDir: `${reportDir}/test-results` } : {}),

  use: {
    baseURL: t.baseUrl,
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    /**
     * Headless is the default, which is right for CI and for the 20-second local run — but it means
     * a first-time reader sees no browser and reasonably wonders whether anything happened.
     * `npm run test:watch` sets this and drops to one worker so the flow is followable; parallel
     * headed workers just throw five windows on the screen at once.
     */
    launchOptions: {
      slowMo: process.env.QA_SLOW_MO ? Number(process.env.QA_SLOW_MO) : undefined,
    },
  },

  projects: [
    {
      name: 'health',
      testDir: './tests/health',
      testMatch: '*.spec.ts',
      timeout: 30_000,
    },
    {
      name: 'qa-automation',
      testDir: './tests/qa',
      testMatch: '*.spec.ts',
      timeout: 150_000,
    },
    {
      name: 'uat',
      testDir: './tests/uat',
      testMatch: '*.spec.ts',
      timeout: 60_000,
      use: { baseURL: t.baseUrl },
    },
    {
      name: 'chromium',
      testDir: './tests/wallet',
      testMatch: ['wallet-flow.spec.ts', 'wallet-errors.spec.ts', 'web-regression.spec.ts'],
      use: { ...devices['Desktop Chrome'] },
    },
    {
      // Browserless HTTP contract tests. Write checks skip unless QA_ALLOW_WRITES=1 (isolated stack).
      name: 'api',
      testDir: './tests/api',
      testMatch: '*.spec.ts',
      timeout: 60_000,
      use: { baseURL: t.baseUrl },
    },
  ],
})
