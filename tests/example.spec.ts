import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { config } from './config';

/* ================================================================== *
 *  Types                                                              *
 * ================================================================== */

interface MalformedEntry {
  armIndex: number;
  invMasterIndex: number;
  invNumber: string;
  rcptMasterIndex: number;
  difference: number;
}

interface ReceiptGroup {
  rcptMasterIndex: number;
  entries: MalformedEntry[];
  /** Unique invoice numbers for UI search */
  invNumbers: string[];
  /** Unique InvMasterIndex values for the Azure Runbook parameter */
  invMasterIndices: number[];
}

/* ================================================================== *
 *  Malformed-data parser                                              *
 *  Mirrors the C# GetMalformedData() logic:                          *
 *    Tab-separated columns — we extract the five fields we need.      *
 * ================================================================== */

function parseMalformedData(): MalformedEntry[] {
  const filePath = path.resolve(__dirname, '..', 'resources', config.malformedDataFile);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Malformed data file not found: ${filePath}`);
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split(/\r?\n/).filter(line => line.trim().length > 0);

  return lines.map(line => {
    // Tab-separated columns:
    // 0:ARMIndex  1:InvMaster  2:InvNumber  3:Matter  4:RcptMaster
    // 5:GLDate  6:Currency  7:ARAmt  8:ARFee  9:ARList  10:IsReversed
    // 11:ArchetypeCode  12:ARMaster  13:Currency  14:RcptAmt  15:CollAmt
    // 16:Difference
    const cols = line.split('\t');
    return {
      armIndex: parseInt(cols[0].trim(), 10),
      invMasterIndex: parseInt(cols[1].trim(), 10),
      invNumber: cols[2].trim(),
      rcptMasterIndex: parseInt(cols[4].trim(), 10),
      difference: parseFloat(cols[16].trim()),
    };
  });
}

/**
 * Group flat malformed entries by RcptMasterIndex.
 * Each group carries both the unique invoice numbers (for the 3E UI)
 * and the unique InvMasterIndex values (for the Azure Runbook).
 */
function groupByReceipt(entries: MalformedEntry[]): ReceiptGroup[] {
  const map = new Map<number, MalformedEntry[]>();
  for (const entry of entries) {
    if (!map.has(entry.rcptMasterIndex)) {
      map.set(entry.rcptMasterIndex, []);
    }
    map.get(entry.rcptMasterIndex)!.push(entry);
  }

  return Array.from(map.entries()).map(([rcptMasterIndex, groupEntries]) => ({
    rcptMasterIndex,
    entries: groupEntries,
    invNumbers: [...new Set(groupEntries.map(e => e.invNumber))],
    invMasterIndices: [...new Set(groupEntries.map(e => e.invMasterIndex))],
  }));
}

/* ================================================================== *
 *  Helpers                                                            *
 * ================================================================== */

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Navigate and wait for the Angular SPA to settle.
 * A full page.goto forces Angular to re-bootstrap, resetting mat-input IDs.
 */
async function navigateAndWait(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: 'networkidle', timeout: config.navigationTimeoutMs });
}

/**
 * Perform the Microsoft login flow (email → password → "Stay signed in?").
 */
async function login(page: Page): Promise<void> {
  await page.goto(config.baseUrl, { waitUntil: 'networkidle', timeout: config.navigationTimeoutMs });
  await page.getByRole('textbox', { name: 'Enter your email or phone' }).click();
  await page.getByRole('textbox', { name: 'Enter your email or phone' }).fill(config.email);
  await page.getByRole('textbox', { name: 'Enter your email or phone' }).press('Enter');
  await page.locator('#i0118').fill(config.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('button', { name: 'Yes' }).click();
  await page.waitForLoadState('domcontentloaded');
  console.log('  Login successful');
}

/* ================================================================== *
 *  Phase 1 – Open each receipt, update Folder info, add invoices      *
 * ================================================================== */

async function processReceipt(page: Page, receipt: ReceiptGroup): Promise<void> {
  console.log(`  ▸ Processing receipt ${receipt.rcptMasterIndex} (${receipt.invNumbers.length} invoice(s))`);

  // Navigate to receipt process page (full reload resets Angular state)
  await navigateAndWait(page, `${config.baseUrl}/process/RcptMaster#RcptMaster`);

  // Wait for the Angular form to fully render
  await page.waitForSelector('input[id^="mat-input-"]', { state: 'visible', timeout: config.navigationTimeoutMs });

  // Search by RcptMasterIndex in the Quick Find dialog
  const searchInput = page.locator('[pendo-id="e3e-quick-find-search-field"]');
  await searchInput.waitFor({ state: 'visible', timeout: config.navigationTimeoutMs });
  await searchInput.click();
  await page.keyboard.type(receipt.rcptMasterIndex.toString());

  // Click the SEARCH button — the app auto-selects the matching receipt and opens it
  await page.getByRole('button', { name: 'SEARCH' }).click();
  await page.locator('e3e-form-renderer').waitFor({ state: 'visible', timeout: config.navigationTimeoutMs });
  console.log(`    ✓ Receipt ${receipt.rcptMasterIndex} opened`);

  // Extract receipt metadata
  const rcptType = (await page
    .locator('[data-automation-id$="attributes/ReceiptType"]')
    .textContent()) ?? '';
  const rcptDate = (await page
    .locator('[data-automation-id$="attributes/RcptDate"]')
    .textContent()) ?? '';

  // Derive the unit code from the receipt type (e.g. "9200-Something" → "9200")
  const nxUnit = rcptType.split('-')[0].trim();

  // Open the Folder dialog via the toolbar overflow menu
  await page
    .locator('e3e-process-toolbar')
    .getByRole('button')
    .filter({ hasText: 'more_vert' })
    .click();
  await page.getByRole('menuitem', { name: 'Folder' }).click();

  // Select unit — skip only the unit dropdown when 9100
  if (nxUnit !== '9100') {
    const unitDropdownBtn = page
      .locator('#process-folder-unit')
      .getByRole('button')
      .filter({ hasText: 'arrow_drop_down' });
    await unitDropdownBtn.click();

    // Wait for the dropdown panel to be visible before typing
    await page.locator('.mat-autocomplete-panel, mat-option').first()
      .waitFor({ state: 'visible', timeout: config.navigationTimeoutMs });

    const unitFilterInput = page.locator('#process-folder-unit').locator('input');
    await unitFilterInput.fill("Firm");

    // Give Angular time to filter the dropdown options after typing
    await delay(1000);

    // Wait for the filtered option to appear, then click it
    const firstOption = page.locator('mat-option').first();
    await firstOption.waitFor({ state: 'visible', timeout: config.navigationTimeoutMs });
    await firstOption.click();
  }

  // Check the Reversal checkbox first, then Reallocate (using stable pendo-id attributes)
  const reversalCheckbox = page
    .locator('[pendo-id="/objects/RcptMaster/rows/attributes/IsReversed"] .mat-checkbox-inner-container');
  await reversalCheckbox.waitFor({ state: 'visible', timeout: config.navigationTimeoutMs });
  await reversalCheckbox.click();

  // Wait for Angular to enable the Reallocate checkbox after Reversal is checked
  await delay(1000);

  const reallocateCheckbox = page
    .locator('[pendo-id="/objects/RcptMaster/rows/attributes/IsReverseAndReallocate"] .mat-checkbox-inner-container');
  await reallocateCheckbox.waitFor({ state: 'visible', timeout: config.navigationTimeoutMs });
  await reallocateCheckbox.click();

  // Fill Reverse Date & Reversal Reason using stable field attributes.
  const reverseDateInput = page.locator(
    'div[pendo-id="/objects/RcptMaster/rows/attributes/ReverseDate"] input.mat-input-element',
  );
  const reverseReasonInput = page.locator(
    'input[pendo-id="/objects/RcptMaster/rows/attributes/ReverseReason"]',
  );

  await reverseDateInput.waitFor({ state: 'visible', timeout: config.navigationTimeoutMs });
  await reverseDateInput.click();
  await reverseDateInput.fill(rcptDate);

  await reverseReasonInput.waitFor({ state: 'visible', timeout: config.navigationTimeoutMs });
  await reverseReasonInput.click();
  await reverseReasonInput.fill(config.folderDescription);

  // Submit the folder update
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await page.waitForLoadState('domcontentloaded'); //TODO wait for rcptMasterIndex to be auto
  
  const invoicesTab = page
    .locator('.mat-tab-label')
    .filter({ has: page.locator('div[pendo-id="/objects/RcptMaster/rows/childObjects/RcptInvoice"]') })
    .first();
  await invoicesTab.waitFor({ state: 'visible', timeout: config.navigationTimeoutMs });
  await invoicesTab.click();

  // Remove existing invoices, then add each invoice for this receipt
  const removeDropdownButton = page
    .locator('button[data-automation-id*="/childObjects/RcptInvoice/actions/Remove-dropdown"]')
    .first();
  await removeDropdownButton.waitFor({ state: 'visible', timeout: config.navigationTimeoutMs });
  await removeDropdownButton.click();

  // Opened menu is rendered in an overlay panel; target only the active visible panel.
  let removeAllMenuItem = page
    .locator('.cdk-overlay-pane .mat-menu-panel:not(.mat-menu-panel-hidden) button[data-automation-id*="/childObjects/RcptInvoice/actions/btnRemoveAll"]')
    .first();

  try {
    await removeAllMenuItem.waitFor({ state: 'visible', timeout: 4000 });
  } catch {
    // Retry once in case the first dropdown click did not materialize the menu.
    await removeDropdownButton.click();
    removeAllMenuItem = page
      .locator('.cdk-overlay-pane .mat-menu-panel:not(.mat-menu-panel-hidden) button[data-automation-id*="/childObjects/RcptInvoice/actions/btnRemoveAll"]')
      .first();
    await removeAllMenuItem.waitFor({ state: 'visible', timeout: config.navigationTimeoutMs });
  }

  await removeAllMenuItem.click();

  for (const invNumber of receipt.invNumbers) {
    console.log(`    ▹ Adding invoice ${invNumber}`);

    // Open options menu -> Invoices -> Add (overlay submenu) to launch the invoice search dialog.
    const childFormOptionsButton = page
      .locator('button.child-form-tabs-btn.options-menu')
      .first();
    await childFormOptionsButton.waitFor({ state: 'visible', timeout: config.navigationTimeoutMs });
    await childFormOptionsButton.click();

    const invoicesMenuItem = page
      .locator('.cdk-overlay-pane .mat-menu-panel:not(.mat-menu-panel-hidden) button[mat-menu-item]')
      .filter({ hasText: 'Invoices' })
      .first();
    await invoicesMenuItem.waitFor({ state: 'visible', timeout: config.navigationTimeoutMs });
    await invoicesMenuItem.hover();

    const overlayAddMenuItem = page
      .locator('.cdk-overlay-pane .mat-menu-panel:not(.mat-menu-panel-hidden) button[mat-menu-item]')
      .filter({ hasText: /^\s*Add\s*$/ })
      .first();
    await overlayAddMenuItem.waitFor({ state: 'visible', timeout: config.navigationTimeoutMs });
    await overlayAddMenuItem.click();

    const addDialogInput = page.locator('input[pendo-id="e3e-quick-find-search-field"]:visible').last();
    await addDialogInput.waitFor({ state: 'visible', timeout: config.navigationTimeoutMs });
    await addDialogInput.click();
    await addDialogInput.fill(invNumber);

    const searchButton = page.locator('button[pendo-id="e3e-query-dialog-search-button"]');
    await searchButton.waitFor({ state: 'visible', timeout: config.navigationTimeoutMs });
    await searchButton.click();

    const firstResultCheckbox = page
      .locator('.ag-center-cols-container .ag-row[row-index="0"] input[type="checkbox"]')
      .first();
    await firstResultCheckbox.waitFor({ state: 'visible', timeout: config.navigationTimeoutMs });
    await firstResultCheckbox.check();

    const selectButton = page.locator('button[pendo-id="e3e-query-dialog-select-button"]');
    await selectButton.waitFor({ state: 'visible', timeout: config.navigationTimeoutMs });
    await selectButton.click();
    await page.waitForLoadState('domcontentloaded');
  }
}

/* ================================================================== *
 *  Phase 2 – Trigger Azure Automation Runbook for each receipt        *
 * ================================================================== */

async function triggerRunbook(azurePage: Page, receipt: ReceiptGroup): Promise<void> {
  const invoiceIds = receipt.invMasterIndices.join(',');
  console.log(`  ▸ Triggering runbook for receipt ${receipt.rcptMasterIndex} — invoices: ${invoiceIds}`);

  await navigateAndWait(azurePage, config.azureRunbookUrl);

  await azurePage.getByRole('button', { name: 'Start' }).click();

  const startFrame = azurePage
    .locator('iframe[name="StartRunbook.ReactView"]')
    .contentFrame();
  await startFrame.getByRole('textbox', { name: 'Enter a value' }).click();
  await startFrame.getByRole('textbox', { name: 'Enter a value' }).fill(invoiceIds);
  await startFrame.getByRole('button', { name: 'Start' }).click();

  // Poll the Job Dashboard until "Completed" (refresh every N seconds)
  const jobFrame = azurePage
    .locator('iframe[name="JobDashboard.ReactView"]')
    .contentFrame();

  const deadline = Date.now() + config.runbookMaxWaitMs;
  while (Date.now() < deadline) {
    const statusText = await jobFrame
      .getByLabel('Completed')
      .textContent()
      .catch(() => null);

    if (statusText?.includes('Completed')) {
      console.log(`    ✓ Runbook completed for receipt ${receipt.rcptMasterIndex}`);
      return;
    }

    await delay(config.runbookPollingIntervalMs);
    await jobFrame.getByRole('menuitem', { name: 'Refresh' }).click();
  }

  throw new Error(
    `Runbook for receipt ${receipt.rcptMasterIndex} did not complete within ${config.runbookMaxWaitMs / 1000}s`,
  );
}

/* ================================================================== *
 *  Phase 3 – Submit opened receipts from Dashboard (oldest first)     *
 *                                                                     *
 *  The "My Action List" panel shows opened processes.                 *
 *  The oldest entry is at the bottom of the list.                     *
 *  For each one: open → verify → submit → trigger runbook → repeat.  *
 * ================================================================== */

async function submitOpenedReceipts(
  page: Page,
  azurePage: Page,
  receiptGroups: ReceiptGroup[],
): Promise<void> {
  await navigateAndWait(page, `${config.baseUrl}/dashboard`);

  const actionItems = page.locator('e3e-dashboard-action-list-panel li');
  let remainingCount = await actionItems.count();
  console.log(`  ▸ ${remainingCount} opened receipt(s) to submit from dashboard`);

  let receiptIdx = 0;
  while (remainingCount > 0) {
    // Refresh the dashboard to get the current list
    await navigateAndWait(page, `${config.baseUrl}/dashboard`);
    const items = page.locator('e3e-dashboard-action-list-panel li');
    const count = await items.count();
    if (count === 0) break;

    // Click the last (oldest) item to open it
    await items.last().locator('.action-list-item-content').click();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('e3e-form-renderer')).toBeVisible({ timeout: config.navigationTimeoutMs });

    // Verify the updated folder description is present
    await expect(page.locator('e3e-form-renderer')).toContainText(config.folderDescription);

    // Submit the receipt
    await page.getByRole('button', { name: 'Submit', exact: true }).click();
    await page.waitForLoadState('domcontentloaded');

    // Trigger the Azure Runbook for this receipt
    if (receiptIdx < receiptGroups.length) {
      await triggerRunbook(azurePage, receiptGroups[receiptIdx]);
      receiptIdx++;
    }

    remainingCount--;
  }
}

/* ================================================================== *
 *  Main test                                                          *
 * ================================================================== */

test('process malformed receipts – end to end', async ({ page, context }) => {
  // ── Parse malformed data and group by receipt ──────────────────────
  const entries = parseMalformedData();
  const receiptGroups = groupByReceipt(entries);
  console.log(`Parsed ${entries.length} entries across ${receiptGroups.length} receipt(s)\n`);

  // ── Login via Microsoft (same flow as the original codegen script) ─
  await login(page);

  // ── Phase 1: Open each receipt, update folder, add invoices ──────
  console.log('═══ Phase 1: Process receipts ═══');
  for (const receipt of receiptGroups) {
    await processReceipt(page, receipt);
  }

  // ── Phase 2: Trigger Azure Runbook per receipt ───────────────────
  console.log('\n═══ Phase 2: Trigger Azure Runbooks ═══');
  const azurePage: Page = await context.newPage();

  for (const receipt of receiptGroups) {
    await triggerRunbook(azurePage, receipt);
  }

  // ── Phase 3: Submit opened receipts from dashboard (oldest first) ─
  console.log('\n═══ Phase 3: Submit opened receipts from dashboard ═══');
  await submitOpenedReceipts(page, azurePage, receiptGroups);

  await azurePage.close();
  console.log('\n✓ All receipts processed successfully');
});