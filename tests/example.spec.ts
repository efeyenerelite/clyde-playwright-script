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
  status: string;
  rawLine: string;
}

interface ReceiptGroup {
  rcptMasterIndex: number;
  entries: MalformedEntry[];
  /** Unique invoice numbers for UI search */
  invNumbers: string[];
  /** Unique InvMasterIndex values for the Azure Runbook parameter (CORRUPTED rows only) */
  invMasterIndices: number[];
  /** Original tab-separated lines from the malformed data file */
  rawLines: string[];
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
      status: (cols[17] ?? 'CORRUPTED').trim().toUpperCase(),
      rawLine: line,
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
    invMasterIndices: [
      ...new Set(
        groupEntries
          .filter(e => e.status === 'CORRUPTED')
          .map(e => e.invMasterIndex),
      ),
    ],
    rawLines: groupEntries.map(e => e.rawLine),
  }));
}

/* ================================================================== *
 *  Helpers                                                            *
 * ================================================================== */

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function chunkArray<T>(items: T[], size: number): T[][] {
  if (size <= 0) {
    throw new Error(`Invalid batch size: ${size}. receiptBatchSize must be greater than 0.`);
  }

  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

/* ================================================================== *
 *  Popup & blacklist helpers                                          *
 * ================================================================== */

/**
 * Check for a snack-bar popup and return its message, or null if none.
 */
async function detectPopup(page: Page, timeout = 5000): Promise<string | null> {
  try {
    const snackbar = page.locator('snack-bar-container .message');
    await snackbar.waitFor({ state: 'visible', timeout });
    return ((await snackbar.textContent()) ?? '').trim() || null;
  } catch {
    return null;
  }
}

/**
 * Dismiss a visible snack-bar popup by clicking its close icon.
 */
async function dismissPopup(page: Page): Promise<void> {
  try {
    const closeButton = page.locator('snack-bar-container mat-icon.close-alert');
    if (await closeButton.isVisible()) {
      await closeButton.click();
      await delay(500);
    }
  } catch {
    // Popup may have auto-dismissed
  }
}

/**
 * Cancel the currently open process row: click Cancel, then confirm Yes.
 */
async function cancelCurrentRow(page: Page): Promise<void> {
  const cancelButton = page.locator('button[data-automation-id="CANCEL"]');
  await cancelButton.waitFor({ state: 'visible', timeout: config.navigationTimeoutMs });
  await cancelButton.click();

  const confirmYesButton = page.locator('button[data-automation-id="cancel-dialog-yes-button"]');
  await confirmYesButton.waitFor({ state: 'visible', timeout: config.navigationTimeoutMs });
  await confirmYesButton.click();
  await page.waitForLoadState('domcontentloaded');
  console.log('    \u2717 Row cancelled');
}

/**
 * Append receipt entries to the run's blacklist file in malformed-data format.
 */
function appendToBlackList(
  blackListPath: string,
  receipt: ReceiptGroup,
  popupMessage: string,
): void {
  const header = `# Receipt ${receipt.rcptMasterIndex} \u2014 ${popupMessage}\n`;
  const lines = receipt.rawLines.join('\n');
  fs.appendFileSync(blackListPath, header + lines + '\n\n', 'utf-8');
  console.log(`    \u2717 Receipt ${receipt.rcptMasterIndex} added to blacklist`);
}

/**
 * After submitting in Phase 1, poll for either:
 *  - Receipt Master Index becoming <AUTO> \u2192 success, or
 *  - A snack-bar popup while index is NOT <AUTO> \u2192 failure.
 */
async function waitForSubmitResult(
  page: Page,
  contextLabel: string,
): Promise<{ success: boolean; popupMessage?: string }> {
  const rcptIndexLocator = page
    .locator('[data-automation-id$="/attributes/RcptIndex"]')
    .first();
  const snackbarLocator = page.locator('snack-bar-container .message');
  const deadline = Date.now() + config.navigationTimeoutMs;

  while (Date.now() < deadline) {
    // Check if receipt master index is <AUTO>
    try {
      const text = ((await rcptIndexLocator.textContent({ timeout: 2000 })) ?? '')
        .replace(/\s+/g, ' ')
        .trim();
      if (text === '<AUTO>') return { success: true };
    } catch { /* element not ready */ }

    // Check for error popup
    try {
      if (await snackbarLocator.isVisible()) {
        const message = ((await snackbarLocator.textContent()) ?? '').trim();
        // One final check \u2014 index may have become <AUTO> at the same time
        try {
          const text = ((await rcptIndexLocator.textContent({ timeout: 2000 })) ?? '')
            .replace(/\s+/g, ' ')
            .trim();
          if (text === '<AUTO>') return { success: true, popupMessage: message };
        } catch { /* */ }
        return { success: false, popupMessage: message };
      }
    } catch { /* no popup */ }

    await delay(1000);
  }

  return {
    success: false,
    popupMessage: `[${contextLabel}] Timed out waiting for submit to complete`,
  };
}

/**
 * After submitting in Phase 3, wait for either
 * the form to close (success) or a snack-bar popup (failure).
 */
async function waitForPhase3SubmitResult(
  page: Page,
): Promise<{ success: boolean; popupMessage?: string }> {
  const formLocator = page.locator('e3e-form-renderer');
  const snackbarLocator = page.locator('snack-bar-container .message');
  const deadline = Date.now() + config.navigationTimeoutMs;

  while (Date.now() < deadline) {
    // Check if form closed (success)
    try {
      if (!(await formLocator.isVisible())) return { success: true };
    } catch { /* */ }

    // Check for popup (failure)
    try {
      if (await snackbarLocator.isVisible()) {
        const message = ((await snackbarLocator.textContent()) ?? '').trim();
        return { success: false, popupMessage: message };
      }
    } catch { /* */ }

    await delay(1000);
  }

  return { success: false, popupMessage: 'Timed out waiting for Phase 3 submit' };
}

/**
 * Navigate and wait for the Angular SPA to settle.
 * A full page.goto forces Angular to re-bootstrap, resetting mat-input IDs.
 */
async function navigateAndWait(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: 'networkidle', timeout: config.navigationTimeoutMs });
}

/**
 * Click the primary Submit action (Release) using stable selectors.
 * Falls back to role/text-based submit if needed.
 */
async function clickSubmitAction(page: Page): Promise<void> {
  const candidates = [
    page.locator('button[data-automation-id="RELEASE"]:visible').first(),
    page.locator('particle-button-dropdown[pendo-id="RELEASE"] button:visible').first(),
    page.getByRole('button', { name: /^\s*Submit\s*$/ }).first(),
  ];

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      if ((await candidate.count()) === 0) {
        continue;
      }

      await candidate.waitFor({ state: 'visible', timeout: 5000 });
      await candidate.scrollIntoViewIfNeeded();
      await expect(candidate).toBeEnabled({ timeout: 5000 });
      await candidate.click({ timeout: 5000 });
      return;
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`Unable to click Submit/Release button: ${String(lastError ?? 'no matching selector found')}`);
}

async function waitForReceiptMasterIndexAuto(page: Page, contextLabel: string): Promise<void> {
  const receiptMasterIndexValue = page
    .locator('[data-automation-id$="/attributes/RcptIndex"]')
    .first();

  await receiptMasterIndexValue.waitFor({ state: 'visible', timeout: config.navigationTimeoutMs });
  await expect
    .poll(
      async () => ((await receiptMasterIndexValue.textContent()) ?? '').replace(/\s+/g, ' ').trim(),
      {
        timeout: config.navigationTimeoutMs,
        message: `[${contextLabel}] Waiting for Receipt Master Index to become <AUTO>`,
      },
    )
    .toBe('<AUTO>');
}

/**
 * Perform the Microsoft login flow (email → password → "Stay signed in?").
 */
async function login(page: Page): Promise<void> {
  await page.goto(config.loginUrl, { waitUntil: 'networkidle', timeout: config.navigationTimeoutMs });
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
 *  Phase 1 – Open each receipt and perform reverse action             *
 * ================================================================== */

async function processReceipt(page: Page, receipt: ReceiptGroup, blackListPath: string): Promise<boolean> {
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
    await unitFilterInput.fill(nxUnit);

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
  await clickSubmitAction(page);
  await page.waitForLoadState('domcontentloaded');

  // Wait for submit to succeed (<AUTO>) or fail (popup)
  const submitResult = await waitForSubmitResult(page, `Phase 1 receipt ${receipt.rcptMasterIndex}`);
  if (!submitResult.success) {
    const msg = submitResult.popupMessage ?? '';
    const isMatterBlocked = msg.includes('Matter does not allow payment activity. Receipt cannot be reversed.');

    if (isMatterBlocked) {
      // Fatal error — blacklist the receipt and cancel the row
      console.log(`    \u26a0 Blocked receipt detected: ${msg}`);
      await dismissPopup(page);
      appendToBlackList(blackListPath, receipt, msg);
      await cancelCurrentRow(page);
      await navigateAndWait(page, `${config.baseUrl}/dashboard`);
      return false;
    }

    // Non-fatal popup (e.g. informational message about a successful reversal) — dismiss and continue
    console.log(`    \u2139 Informational popup (not an error): ${msg}`);
    await dismissPopup(page);
  }

  await navigateAndWait(page, `${config.baseUrl}/dashboard`);
  return true;
}

async function updateReceiptInvoices(page: Page, receipt: ReceiptGroup): Promise<void> {
  await waitForReceiptMasterIndexAuto(page, `Phase 3 pre-invoice-update receipt ${receipt.rcptMasterIndex}`);

  const invoicesTab = page
    .locator('.mat-tab-label')
    .filter({ has: page.locator('div[pendo-id="/objects/RcptMaster/rows/childObjects/RcptInvoice"]') })
    .first();
  await invoicesTab.waitFor({ state: 'visible', timeout: config.navigationTimeoutMs });
  await invoicesTab.click();

  // Remove existing invoices, then add each invoice for this receipt.
  const removeActionsContainer = page
    .locator('div[pendo-id="/objects/RcptMaster/rows/childObjects/RcptInvoice/actions/Remove"]')
    .first();
  await expect(removeActionsContainer).toBeVisible({ timeout: config.navigationTimeoutMs });

  const removeDropdownButtons = removeActionsContainer
    .locator('button[data-automation-id$="/childObjects/RcptInvoice/actions/Remove-dropdown"]:visible');

  async function getActiveRemoveDropdownButton() {
    const count = await removeDropdownButtons.count();
    if (count === 0) {
      throw new Error('Remove dropdown button was not found in Remove actions container');
    }
    return removeDropdownButtons.nth(count - 1);
  }

  async function openRemoveMenuAndClickRemoveAll(): Promise<void> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const removeDropdownButton = await getActiveRemoveDropdownButton();
        await expect(removeDropdownButton).toBeVisible({ timeout: config.navigationTimeoutMs });
        await expect(removeDropdownButton).toBeEnabled({ timeout: config.navigationTimeoutMs });

        if ((await removeDropdownButton.getAttribute('aria-expanded')) === 'true') {
          await page.keyboard.press('Escape');
          await expect(removeDropdownButton).toHaveAttribute('aria-expanded', 'false', { timeout: 2000 });
        }

        await removeDropdownButton.scrollIntoViewIfNeeded();
        await delay(500);
        await removeDropdownButton.click();

        if ((await removeDropdownButton.getAttribute('aria-expanded')) !== 'true') {
          await delay(300);
          await removeDropdownButton.click({ force: true });
        }

        await expect(removeDropdownButton).toHaveAttribute('aria-expanded', 'true', { timeout: 4000 });

        const menuId = await removeDropdownButton.getAttribute('aria-controls');
        if (!menuId) {
          throw new Error('Remove dropdown did not expose aria-controls after opening menu');
        }

        const activeMenuPanel = page.locator(`#${menuId}`);
        await expect(activeMenuPanel).toBeVisible({ timeout: 4000 });

        const removeAllMenuItem = activeMenuPanel
          .locator('button[data-automation-id$="/childObjects/RcptInvoice/actions/btnRemoveAll"]')
          .first();
        await expect(removeAllMenuItem).toBeVisible({ timeout: 3000 });
        await removeAllMenuItem.click({ timeout: 3000 });

        await expect(removeDropdownButton).toHaveAttribute('aria-expanded', 'false', { timeout: 4000 });
        return;
      } catch (error) {
        lastError = error;
        await page.keyboard.press('Escape');
        await delay(400);
      }
    }

    throw lastError;
  }

  await openRemoveMenuAndClickRemoveAll();

  async function openInvoiceSearchDialogFromOptionsMenu(): Promise<void> {
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
  }

  async function openInvoiceSearchDialogFromDirectAddButton(): Promise<void> {
    const directAddButton = page
      .locator('button[data-automation-id$="/childObjects/RcptInvoice/actions/AddByQuery"]:visible')
      .first();
    await directAddButton.waitFor({ state: 'visible', timeout: config.navigationTimeoutMs });
    await directAddButton.click();
  }

  async function searchAndSelectInvoice(invNumber: string): Promise<void> {
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

  for (const [invoiceIndex, invNumber] of receipt.invNumbers.entries()) {
    console.log(`    ▹ Adding invoice ${invNumber}`);

    if (invoiceIndex === 0) {
      await openInvoiceSearchDialogFromOptionsMenu();
    } else {
      await openInvoiceSearchDialogFromDirectAddButton();
    }

    await searchAndSelectInvoice(invNumber);
  }

  await waitForReceiptMasterIndexAuto(page, `Phase 3 post-invoice-update receipt ${receipt.rcptMasterIndex}`);
}

/* ================================================================== *
 *  Phase 2 – Trigger Azure Automation Runbook for each receipt        *
 * ================================================================== */

async function triggerRunbook(azurePage: Page, invoiceIds: string, label: string): Promise<void> {
  console.log(`  ▸ Triggering runbook for ${label} — invoices: ${invoiceIds}`);

  await azurePage.bringToFront();
  await navigateAndWait(azurePage, config.azureRunbookUrl);

  await azurePage.getByRole('button', { name: 'Start' }).click();

  const startFrame = azurePage
    .locator('iframe[name="StartRunbook.ReactView"]')
    .contentFrame();
  await startFrame.getByRole('textbox', { name: 'Enter a value' }).click();
  await startFrame.getByRole('textbox', { name: 'Enter a value' }).fill(invoiceIds);
  await startFrame.getByRole('button', { name: 'Start' }).click();

  // Poll the Job Dashboard by clicking Refresh until status becomes "Completed"
  const jobFrame = azurePage
    .locator('iframe[name="JobDashboard.ReactView"]')
    .contentFrame();

  const deadline = Date.now() + config.runbookMaxWaitMs;
  while (Date.now() < deadline) {
    // Click Refresh first, then check for status
    await jobFrame.getByRole('menuitem', { name: 'Refresh' }).click();
    await delay(config.runbookPollingIntervalMs);

    const statusText = await jobFrame
      .locator('[aria-label="Status Completed"]')
      .textContent()
      .catch(() => null);

    if (statusText?.includes('Completed')) {
      console.log(`    ✓ Runbook completed for ${label}`);
      return;
    }
  }

  throw new Error(
    `Runbook for ${label} did not complete within ${config.runbookMaxWaitMs / 1000}s`,
  );
}

/* ================================================================== *
 *  Phase 3 – Submit opened receipts from Dashboard (oldest first)     *
 *                                                                     *
 *  The "My Action List" panel shows opened processes.                 *
 *  The oldest entry is at the bottom of the list.                     *
 *  For each one: open → remove/add invoices → submit → repeat.        *
 * ================================================================== */

async function submitOpenedReceipts(
  page: Page,
  receiptGroups: ReceiptGroup[],
  blackListPath: string,
): Promise<void> {
  await page.bringToFront();
  await navigateAndWait(page, `${config.baseUrl}/dashboard`);

  const actionListItems = page.locator('e3e-dashboard-action-list-panel ul.action-list-items li');
  console.log(`  ▸ Draining all opened processes from action list`);

  // Queue of receipt groups whose invoices still need updating.
  // Items beyond the queue (leftover from previous runs) are submitted as-is.
  const receiptQueue = [...receiptGroups];
  let submitted = 0;
  // Safety limit: expect at most the batch size + a generous margin for leftovers
  const maxIterations = receiptGroups.length + 20;
  let lastActionListCount = Infinity;
  let consecutiveStalls = 0;
  const maxConsecutiveStalls = 3;

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    // On subsequent iterations, navigate to dashboard for a fresh action list
    if (iteration > 0) {
      await page.bringToFront();
      await navigateAndWait(page, `${config.baseUrl}/dashboard`);
    }

    // Allow the action list to fully render
    await delay(2000);

    const count = await actionListItems.count();
    if (count === 0) {
      console.log('    \u2713 Action list is empty \u2014 all processes submitted');
      break;
    }

    // Stall detection: if the count doesn't decrease, we may be stuck on failing items
    if (count >= lastActionListCount) {
      consecutiveStalls++;
      if (consecutiveStalls >= maxConsecutiveStalls) {
        console.log(
          `    \u26a0 Action list stuck at ${count} item(s) after ${consecutiveStalls} consecutive stalls \u2014 ` +
          `remaining items likely need manual intervention`,
        );
        break;
      }
    } else {
      consecutiveStalls = 0;
    }
    lastActionListCount = count;

    console.log(`    Action list has ${count} item(s) remaining`);
    await expect(actionListItems.first()).toBeVisible({ timeout: config.navigationTimeoutMs });

    // Open the oldest item (last in the list)
    const oldestItemContent = actionListItems.last().locator('.action-list-item-content').first();
    await oldestItemContent.scrollIntoViewIfNeeded();
    await expect(oldestItemContent).toBeVisible({ timeout: config.navigationTimeoutMs });
    await oldestItemContent.click();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('e3e-form-renderer')).toBeVisible({ timeout: config.navigationTimeoutMs });

    // Update invoices if we still have a matching receipt group in the queue
    let currentReceipt: ReceiptGroup | null = null;
    if (receiptQueue.length > 0) {
      currentReceipt = receiptQueue.shift()!;
      console.log(`    \u25b9 Updating invoices for receipt ${currentReceipt.rcptMasterIndex}`);
      await updateReceiptInvoices(page, currentReceipt);
    } else {
      console.log(`    \u25b9 Extra action list item (no matching receipt group) \u2014 submitting without invoice changes`);
    }

    // Submit the receipt
    await clickSubmitAction(page);

    // Wait for form to close (success) or popup (failure)
    const phase3Result = await waitForPhase3SubmitResult(page);
    if (!phase3Result.success) {
      const msg = phase3Result.popupMessage ?? '';
      const isMatterBlocked = msg.includes('Matter does not allow payment activity. Receipt cannot be reversed.');

      console.log(`    \u26a0 Popup detected after Phase 3 submit: ${msg}`);
      await dismissPopup(page);

      // Only blacklist if the error is the specific matter-blocked message
      if (isMatterBlocked) {
        if (currentReceipt) {
          appendToBlackList(blackListPath, currentReceipt, msg);
        } else {
          fs.appendFileSync(blackListPath, `# Unknown receipt \u2014 ${msg}\n\n`, 'utf-8');
          console.log('    \u2717 Unknown receipt added to blacklist');
        }
      } else {
        console.log(`    \u2139 Non-blacklist popup — skipping blacklist for this item`);
      }

      // Do NOT cancel in Phase 3 — go to dashboard and continue
      await navigateAndWait(page, `${config.baseUrl}/dashboard`);
      continue;
    }

    await page.waitForLoadState('networkidle', { timeout: config.navigationTimeoutMs });

    submitted++;
    console.log(`    \u2713 Submit completed (${submitted} total)`);
  }

  // Final verification: navigate to dashboard and check the action list
  await navigateAndWait(page, `${config.baseUrl}/dashboard`);
  await delay(2000);
  const remainingCount = await actionListItems.count();
  if (remainingCount > 0) {
    console.log(
      `  \u26a0 Action list still has ${remainingCount} item(s) after ${submitted} submission(s). ` +
      `These may be blacklisted receipts requiring manual intervention.`,
    );
  } else {
    console.log(`  \u2713 Verified: action list is empty after submitting ${submitted} process(es)`);
  }
}

/* ================================================================== *
 *  Main test                                                          *
 * ================================================================== */

test('process malformed receipts – end to end', async ({ page, context }) => {
  // ── Parse malformed data and group by receipt ──────────────────────
  const entries = parseMalformedData();
  const receiptGroups = groupByReceipt(entries);
  const batches = chunkArray(receiptGroups, config.receiptBatchSize);
  console.log(
    `Parsed ${entries.length} entries across ${receiptGroups.length} receipt(s); ` +
    `processing in ${batches.length} batch(es) of up to ${config.receiptBatchSize}\n`,
  );

  // ── Login via Microsoft (same flow as the original codegen script) ─
  await login(page);

  const azurePage: Page = await context.newPage();
  await page.bringToFront();

  // Generate a unique blacklist file path for this run
  const runTimestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const blackListFilePath = path.resolve(__dirname, '..', 'resources', `blackList_${runTimestamp}`);

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex];
    console.log(
      `\n═══ Batch ${batchIndex + 1}/${batches.length} ` +
      `(${batch.length} receipt(s)) ═══`,
    );

    // ── Phase 1: Open each receipt and perform reverse action ────────
    console.log('═══ Phase 1: Process receipts ═══');
    const successfulReceipts: ReceiptGroup[] = [];
    for (const receipt of batch) {
      const success = await processReceipt(page, receipt, blackListFilePath);
      if (success) {
        successfulReceipts.push(receipt);
      }
    }
    console.log(
      `  Phase 1 complete: ${successfulReceipts.length}/${batch.length} receipt(s) succeeded`,
    );

    // ── Phase 2: Trigger Azure Runbook with invoices from successful receipts ─
    console.log('\n═══ Phase 2: Trigger Azure Runbook ═══');
    const batchInvMasterIndices = [...new Set(successfulReceipts.flatMap(r => r.invMasterIndices))];
    const batchInvoiceIds = batchInvMasterIndices.join(',');
    console.log(
      `  Collected ${batchInvMasterIndices.length} distinct CORRUPTED invoice(s) from ` +
      `${successfulReceipts.length} successful receipt(s) in current batch`,
    );
    if (batchInvMasterIndices.length > 0) {
      await triggerRunbook(
        azurePage,
        batchInvoiceIds,
        `batch ${batchIndex + 1} (${successfulReceipts.length} receipt(s))`,
      );
    } else {
      console.log('  No CORRUPTED invoices in this batch; skipping runbook trigger');
    }

    // ── Phase 3: Submit opened receipts from dashboard (oldest first) ─
    console.log('\n═══ Phase 3: Submit opened receipts from dashboard ═══');
    await submitOpenedReceipts(page, successfulReceipts, blackListFilePath);
  }

  await azurePage.close();

  // Report blacklist summary
  if (fs.existsSync(blackListFilePath)) {
    console.log(`\n\u26a0 Some receipts were blacklisted \u2014 see ${blackListFilePath}`);
  }
  console.log('\n\u2713 All receipts processed');
});