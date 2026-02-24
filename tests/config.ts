/**
 * Centralized configuration for all test parameters.
 * Update these values to match your environment.
 */
export const config = {
  // ── Authentication ──────────────────────────────────────────────────
  email: 'testuser@avengersaadcustomer.onmicrosoft.com',
  password: 'Psw#Avengers-2',

  // ── Application URLs ───────────────────────────────────────────────
  baseUrl: 'https://3e.nonprod.elite.com/dev',
  loginUrl:
    'https://3e.nonprod.elite.com/dev?3eInstanceId=ebm7ewj88k6qqse70zhqwg',
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
  navigationTimeoutMs: 60_000,
  defaultTimeoutMs: 60_000,
};
