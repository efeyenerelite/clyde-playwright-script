/**
 * Centralized configuration for all test parameters.
 * Update these values to match your environment.
 */
export const config = {
  // ── Authentication ──────────────────────────────────────────────────
  email: 'eyener@elite.com',
  password: 'passwordHere',

  // ── Application URLs ───────────────────────────────────────────────
  baseUrl: 'https://3e.elite.com/preview',
  loginUrl:
    'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize',
  azureRunbookUrl:
    'https://portal.azure.com/#@elite.com/resource/subscriptions/' +
    '58afaec1-7685-42aa-982e-052a84cbf6e8/resourceGroups/test-devl-eastus2/' +
    'providers/Microsoft.Automation/automationAccounts/' +
    'testAzureAutomationAccount/runbooks/test-Clyde-update/overview',

  // ── Test data ──────────────────────────────────────────────────────
  malformedDataFile: 'malformedData', // relative to resources/
  folderDescription: 'UpdatedInfo',

  // ── Timeouts & polling ─────────────────────────────────────────────
  runbookPollingIntervalMs: 3_000,
  runbookMaxWaitMs: 300_000, // 5 minutes max wait per runbook
  navigationTimeoutMs: 240_000,
  defaultTimeoutMs: 240_000,
};
