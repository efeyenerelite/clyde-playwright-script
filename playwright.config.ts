import { defineConfig } from '@playwright/test';

/**
 * Playwright configuration.
 *
 * We use a single Chromium project and generous timeouts because
 * the tests drive a long-running UI workflow (receipts → Azure Runbook).
 * The persistent browser context is created inside the test itself
 * (see example.spec.ts), so we don't configure `storageState` here.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: false, // sequential — the workflow is stateful
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: 'html',
  timeout: 600_000, // 10 min per test (long receipt-processing workflow)
  expect: { timeout: 30_000 },
  use: {
    trace: 'on-first-retry',
    actionTimeout: 240_000,
    navigationTimeout: 240_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { channel: 'chrome' },
    },
  ],
});
