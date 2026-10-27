import { existsSync, readFileSync } from 'node:fs'
import dotenv from 'dotenv'

// Service credentials are owned by the orchestrator, never the browser worker tree.
const TEST_KEYS = [
  'BASE_URL', 'QA_CHAIN_ID', 'QA_CHAIN_NAME', 'QA_SEED_PHRASE',
  'WALLET_ADDRESS', 'WALLET_ADDRESS_INDEX', 'QA_ENVIRONMENT', 'QA_VERSION',
  'QA_OWNER', 'QA_RUN_LABEL', 'QA_ALLOW_WRITES', 'QA_APP_ORIGIN', 'QA_NAVIGATION',
  'QA_WEB_FIXTURE_CONTAINER', 'QA_WEB_ACTIVITY_REFRESH_ID', 'QA_WEB_ACTIVITY_DISMISS_ID',
  'QA_RUN_QUEST_DIG_CART', 'QA_CHECKIN_EVIDENCE', 'QA_SLOW_MO', 'QA_REPORT_DIR', 'QA_ALLURE_RESULTS_DIR',
]

export function loadTestEnv(file = '.env', env: NodeJS.ProcessEnv = process.env): void {
  if (!existsSync(file)) return
  const values = dotenv.parse(readFileSync(file))
  for (const key of TEST_KEYS) if (env[key] === undefined && values[key] !== undefined) env[key] = values[key]
}
