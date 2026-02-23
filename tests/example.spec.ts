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
  await page.waitForLoadState('networkidle');
  console.log('  Login successful');
}

/* ================================================================== *
 *  Phase 1 – Open each receipt, update Folder info, add invoices      *
 * ================================================================== */

async function processReceipt(page: Page, receipt: ReceiptGroup): Promise<void> {
  console.log(`  ▸ Processing receipt ${receipt.rcptMasterIndex} (${receipt.invNumbers.length} invoice(s))`);

  // Navigate to receipt process page (full reload resets Angular state)
  await navigateAndWait(page, `${config.baseUrl}/process/RcptMaster#RcptMasterd`);

  // Search by RcptMasterIndex (first visible mat-input is the search field)
  const searchInput = page.locator('input[id^="mat-input-"]').first();
  await searchInput.waitFor({ state: 'visible' });
  await searchInput.click();
  await searchInput.fill(receipt.rcptMasterIndex.toString());
  await page.getByRole('button', { name: 'SEARCH' }).click();
  await page.waitForLoadState('networkidle');
  await expect(page.locator('e3e-form-renderer')).toBeVisible();

  // Extract receipt metadata
  const rcptType = await page
    .locator('[data-automation-id$="attributes/ReceiptType"]')
    .innerText();
  const rcptDate = await page
    .locator('[data-automation-id$="Attributes/RcptDate"]')
    .innerText();

  // Open the Folder dialog via the toolbar overflow menu
  await page
    .locator('e3e-process-toolbar')
    .getByRole('button')
    .filter({ hasText: 'more_vert' })
    .click();
  await page.getByRole('menuitem', { name: 'Folder' }).click();

  // Select unit — type receipt type, then pick the first matching dropdown option
  await page
    .locator('#process-folder-unit')
    .getByRole('button')
    .filter({ hasText: 'arrow_drop_down' })
    .click();
  const unitFilterInput = page.locator('#process-folder-unit').locator('input');
  await unitFilterInput.fill(rcptType);
  await page.locator('mat-option').first().click();

  // Check the required checkboxes
  await page
    .locator('#mat-checkbox-4 > .mat-checkbox-layout > .mat-checkbox-inner-container')
    .click();
  await page
    .locator('#mat-checkbox-6 > .mat-checkbox-layout > .mat-checkbox-inner-container')
    .click();

  // Fill folder date & description.
  // After the unit dropdown and checkboxes, the last two visible mat-inputs
  // are the date field and the description field.
  const visibleInputs = page.locator('input[id^="mat-input-"]:visible');
  const inputCount = await visibleInputs.count();
  const dateInput = visibleInputs.nth(inputCount - 2);
  const descInput = visibleInputs.nth(inputCount - 1);

  await dateInput.click();
  await dateInput.fill(rcptDate);
  await descInput.click();
  await descInput.fill(config.folderDescription);

  // Click on the main content area to commit pending field changes
  await page.locator('#main-content mat-sidenav-content').click();

  // Submit the folder update
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await page.waitForLoadState('networkidle');

  // Remove existing invoices, then add each invoice for this receipt
  await page
    .locator('e3e-form-renderer')
    .getByRole('button', { name: 'Remove' })
    .click();

  for (const invNumber of receipt.invNumbers) {
    console.log(`    ▹ Adding invoice ${invNumber}`);
    await page.getByRole('button', { name: 'Add' }).nth(1).click();

    // The Add dialog creates a new input — grab the last visible mat-input
    const addDialogInput = page.locator('input[id^="mat-input-"]:visible').last();
    await addDialogInput.waitFor({ state: 'visible' });
    await addDialogInput.click();
    await addDialogInput.fill(invNumber);

    await page.getByRole('button', { name: 'SEARCH' }).click();
    await page.waitForLoadState('networkidle');

    await page.getByRole('checkbox', { name: 'Press Space to toggle row' }).check();
    await page.getByRole('button', { name: 'SELECT', exact: true }).click();
    await page.waitForLoadState('networkidle');
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
    await page.waitForLoadState('networkidle');
    await expect(page.locator('e3e-form-renderer')).toBeVisible();

    // Verify the updated folder description is present
    await expect(page.locator('e3e-form-renderer')).toContainText(config.folderDescription);

    // Submit the receipt
    await page.getByRole('button', { name: 'Submit', exact: true }).click();
    await page.waitForLoadState('networkidle');

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