/**
 * Centralized configuration for all test parameters.
 * Update these values to match your environment.
 */
export const config = {
  // ── Authentication ──────────────────────────────────────────────────
  email: 'eyener@elite.com',
  password: 'passHere',

  // ── Application URLs ───────────────────────────────────────────────
  baseUrl: 'https://3e.elite.com/preview',
  loginUrl:
    'https://3e.elite.com/preview',
  azureRunbookUrl:
    'https://portal.azure.com/#@elite.com/resource/subscriptions/' +
    '5b88baaf-89a1-40b3-8cc5-44ccb35a3481/resourceGroups/cloudops-db-maintenance/' +
    'providers/Microsoft.Automation/automationAccounts/' +
    'db-automation-pprd/runbooks/Clyde-Stage-rmkdfcsyzeyamk8gx9xkdg-Report/overview',

  // ── Test data ──────────────────────────────────────────────────────
  malformedDataFile: 'malformedData', // relative to resources/
  folderDescription: 'UpdatedInfo',
  receiptBatchSize: 20,

  // ── Timeouts & polling ─────────────────────────────────────────────
  runbookPollingIntervalMs: 3_000,
  runbookMaxWaitMs: 3_000_000, // 50 minutes max wait per runbook
  navigationTimeoutMs: 600_000,
  defaultTimeoutMs: 600_000,
};
