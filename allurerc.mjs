/**
 * Allure 3 report config. The pipeline (pipeline/lib/allure.mjs) sets QA_ALLURE_HISTORY so every run's
 * report shows pass/fail trends across earlier runs; ad-hoc `npx allure generate` keeps history beside the report.
 */
export default {
  name: 'MPC QA',
  historyPath: process.env.QA_ALLURE_HISTORY || './allure-history.jsonl',
}
