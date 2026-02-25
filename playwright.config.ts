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
  timeout: 2_700_000, // 45 min per test (customer-environment safe)
  expect: { timeout: 60_000 },
  use: {
    headless: false,
    trace: 'on-first-retry',
    actionTimeout: 300_000,
    navigationTimeout: 300_000,
    viewport: null,       // disable fixed viewport — use full window size
    launchOptions: {
      args: ['--start-maximized'],
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { channel: 'chrome' },
    },
  ],
});
