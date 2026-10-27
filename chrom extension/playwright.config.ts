import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests', timeout: 60_000, expect: { timeout: 12_000 },
  fullyParallel: true, workers: 2, retries: 0,
  reporter: [['list'], ['html', { open: 'never' }], ['json', { outputFile: 'test-results/results.json' }]],
  use: { headless: true },
  projects: [{ name: 'packaged-extension' }],
});
