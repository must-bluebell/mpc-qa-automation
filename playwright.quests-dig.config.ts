import { defineConfig, devices } from '@playwright/test'
import base from './playwright.config'

// This authorization is intentionally not loaded from .env by loadTestEnv.
if (process.env.QA_RUN_QUEST_DIG_CART !== '1'
  || process.env.QA_ALLOW_WRITES !== '1'
  || process.env.QA_AUTHORIZE_PRODUCTION_QUEST_DIG_CART !== '1') {
  throw new Error('Cart journey requires explicit production-write authorization: QA_RUN_QUEST_DIG_CART=1 QA_ALLOW_WRITES=1 QA_AUTHORIZE_PRODUCTION_QUEST_DIG_CART=1')
}

export default defineConfig({
  ...base,
  grep: /@production-cart/,
  grepInvert: /$^/,
  retries: 0,
  workers: 1,
  projects: [{
    name: 'quests-dig-cart',
    testDir: './tests/wallet',
    testMatch: 'quests-dig-wallet.spec.ts',
    use: { ...devices['Desktop Chrome'] },
  }],
})
