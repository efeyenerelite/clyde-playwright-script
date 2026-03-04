import { test, expect, Page, Locator } from '@playwright/test';
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

/* ================================================================== *
 *  Debug log — mirrors every console.log to a per-run .txt file       *
 * ================================================================== */

/** File path for the current run's debug log. Set once in the main test. */
let debugLogFilePath: string | null = null;

/**
 * Initialise the debug log file for this run.
 * Call once at the start of the test, after generating the run timestamp.
 */
function initDebugLog(runTimestamp: string): void {
  debugLogFilePath = path.resolve(
    __dirname,
    '..',
    'resources',
    `debugLog_${runTimestamp}.txt`,
  );
  fs.writeFileSync(
    debugLogFilePath,
    `# Debug log — run started ${runTimestamp}\n\n`,
    'utf-8',
  );
}

/**
 * Log a message to both the console and the per-run debug log file.
 * Accepts the same arguments as console.log.
 */
function debugLog(...args: unknown[]): void {
  // Write to Playwright's console output as usual.
  console.log(...args);

  // Append to the debug log file (with ISO timestamp prefix per line).
  if (debugLogFilePath) {
    const timestamp = new Date().toISOString();
    const message = args
      .map(a => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ');
    fs.appendFileSync(debugLogFilePath, `[${timestamp}] ${message}\n`, 'utf-8');
  }
}

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
      await stableClick(closeButton, 'Snackbar close button', { retries: 2 });
      await delay(500);
    }
  } catch {
    // Popup may have auto-dismissed
  }
}

/**
 * Extract validation-error messages from the 3E form error panel.
 *
 * The UI shows a small warning icon thumbnail (`.error-thumbnail-background`)
 * that, when clicked, switches to the errors tab.  Each error is rendered as
 * a `mat-card` whose `mat-card-title` holds context (e.g. "1. Receipt") and
 * whose `e3e-navigation-link .message` holds the actual message.
 *
 * Returns an array of human-readable error strings, or an empty array if
 * no error panel / messages are found.
 */
async function extractValidationErrors(page: Page, timeoutMs?: number): Promise<string[]> {
  const timeout = timeoutMs ?? 5000;
  const errors: string[] = [];

  try {
    // 1. Click the warning icon thumbnail to reveal the errors tab.
    //    Use waitFor (which accepts a timeout) instead of isVisible (which does not).
    const errorThumbnail = page.locator('div.error-thumbnail-background').first();
    const thumbnailVisible = await errorThumbnail
      .waitFor({ state: 'visible', timeout: 3000 })
      .then(() => true)
      .catch(() => false);

    if (thumbnailVisible) {
      // Use dispatchEvent to avoid Playwright scrolling the page for this
      // indicator icon — we only need Angular to switch tabs, not a pointer hit.
      await errorThumbnail.dispatchEvent('click');
      await delay(600); // Let the tab transition animation finish.
    }

    // 2. Locate the active tab body that contains the error cards.
    const activeTabBody = page.locator('mat-tab-body.mat-tab-body-active');
    const tabVisible = await activeTabBody
      .waitFor({ state: 'visible', timeout })
      .then(() => true)
      .catch(() => false);

    if (!tabVisible) return errors;

    // 3. Each error is a mat-card with a title and a message.
    const errorCards = activeTabBody.locator('mat-card');
    const cardCount = await errorCards.count();

    for (let i = 0; i < cardCount; i++) {
      const card = errorCards.nth(i);

      const title = ((await card.locator('mat-card-title').textContent().catch(() => null)) ?? '')
        .replace(/\s+/g, ' ')
        .trim();
      const message = ((await card.locator('e3e-navigation-link .message').textContent().catch(() => null)) ?? '')
        .replace(/\s+/g, ' ')
        .trim();

      if (message.length > 0) {
        const entry = title.length > 0 ? `[${title}] ${message}` : message;
        errors.push(entry);
      }
    }
  } catch {
    // Error panel may not exist or may have closed — return whatever we collected.
  }

  return errors;
}

/**
 * Lightweight failure diagnostics: capture a screenshot and log visible UI state.
 * Call this in any failure path before blacklisting so issues are diagnosable
 * from the artifacts alone.
 */
async function captureFailureDiagnostics(
  page: Page,
  contextLabel: string,
): Promise<void> {
  try {
    const screenshotName = `failure-${contextLabel}-${Date.now()}`.replace(/[^a-zA-Z0-9_-]/g, '_');
    await page.screenshot({
      path: `test-results/${screenshotName}.png`,
      fullPage: false,
      timeout: 10_000,
    });
    debugLog(`    📸 Screenshot saved: test-results/${screenshotName}.png`);
  } catch {
    debugLog('    ⚠ Could not capture failure screenshot');
  }

  // Log the visible toolbar actions and any error indicators for debugging.
  try {
    const toolbarButtons = page.locator('e3e-process-toolbar button:visible');
    const btnCount = await toolbarButtons.count().catch(() => 0);
    if (btnCount > 0) {
      const labels: string[] = [];
      for (let i = 0; i < Math.min(btnCount, 8); i++) {
        const txt = ((await toolbarButtons.nth(i).textContent().catch(() => null)) ?? '').trim();
        if (txt) labels.push(txt);
      }
      debugLog(`    🔍 Visible toolbar buttons: ${labels.join(', ')}`);
    }

    const hasErrorThumbnail = await page
      .locator('div.error-thumbnail-background')
      .first()
      .isVisible()
      .catch(() => false);
    if (hasErrorThumbnail) {
      debugLog('    🔍 Error warning thumbnail is visible on the form');
    }
  } catch {
    // Non-critical — diagnostics should never block the flow.
  }
}

/**
 * Cancel the currently open process row: click Cancel, then confirm Yes.
 */
async function cancelCurrentRow(page: Page): Promise<void> {
  const cancelButton = page.locator('button[data-automation-id="CANCEL"]');
  await cancelButton.waitFor({ state: 'visible', timeout: config.navigationTimeoutMs });
  await stableClick(cancelButton, 'Cancel button');

  const confirmYesButton = page.locator('button[data-automation-id="cancel-dialog-yes-button"]');
  await confirmYesButton.waitFor({ state: 'visible', timeout: config.navigationTimeoutMs });
  await stableClick(confirmYesButton, 'Cancel confirmation Yes button');
  await page.waitForLoadState('domcontentloaded');
  debugLog('    \u2717 Row cancelled');
}

/**
 * Append receipt entries to the run's blacklist file in malformed-data format.
 */
function appendToBlackList(
  blackListPath: string,
  receipt: ReceiptGroup,
  popupMessage: string,
  relatedReversedReceiptIndex?: string | null,
): void {
  const header = `# Receipt ${receipt.rcptMasterIndex} \u2014 ${popupMessage}\n`;
  const reversedReceiptLine = relatedReversedReceiptIndex
    ? `# Related reversed receipt index: ${relatedReversedReceiptIndex}\n`
    : '';
  const lines = receipt.rawLines.join('\n');
  fs.appendFileSync(blackListPath, header + reversedReceiptLine + lines + '\n\n', 'utf-8');
  debugLog(`    \u2717 Receipt ${receipt.rcptMasterIndex} added to blacklist`);
}

async function getCurrentReceiptIndex(page: Page): Promise<string | null> {
  const rcptIndexLocator = page
    .locator('[data-automation-id$="/attributes/RcptIndex"]')
    .first();

  try {
    await rcptIndexLocator.waitFor({ state: 'visible', timeout: config.defaultTimeoutMs });
    const text = ((await rcptIndexLocator.textContent()) ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

/**
 * Parse the processId (GUID) from a 3E process URL.
 * Example input:  https://…/process/f840306f-4bed-45d9-a40d-5e76bbd55d8e#RcptMaster
 * Example output: f840306f-4bed-45d9-a40d-5e76bbd55d8e
 */
function parseProcessIdFromUrl(url: string): string | null {
  const match = url.match(
    /\/process\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
  );
  return match ? match[1] : null;
}

  /**
   * Append all remaining dashboard action-list items to the blacklist file.
   * Used in final verification when some items could not be submitted.
   */
  async function appendRemainingActionListItemsToBlackList(
    actionListItems: Locator,
    blackListPath: string,
  ): Promise<void> {
    const remainingCount = await actionListItems.count();
    if (remainingCount === 0) {
      return;
    }

    const sections: string[] = [];
    for (let index = 0; index < remainingCount; index++) {
      const item = actionListItems.nth(index);
      const itemText = ((await item.textContent()) ?? '')
        .replace(/\s+/g, ' ')
        .trim();

      const header = `# Remaining action-list item ${index + 1}/${remainingCount} — final-step auto-blacklist`;
      const details = itemText.length > 0 ? itemText : '[No row text captured]';
      sections.push(`${header}\n${details}`);
    }

    fs.appendFileSync(blackListPath, sections.join('\n\n') + '\n\n', 'utf-8');
    debugLog(`    ✗ Added ${remainingCount} remaining action-list item(s) to blacklist`);
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

    await delay(500);
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

    await delay(500);
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

async function stableClick(
  target: Locator,
  label: string,
  options?: {
    timeoutMs?: number;
    retries?: number;
    forceOnLastRetry?: boolean;
  },
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? config.defaultTimeoutMs;
  const retries = options?.retries ?? 3;
  const forceOnLastRetry = options?.forceOnLastRetry ?? true;

  await target.waitFor({ state: 'visible', timeout: timeoutMs });
  await expect(target).toBeEnabled({ timeout: timeoutMs });

  // NOTE: Do NOT call scrollIntoViewIfNeeded() here.  Playwright's click()
  // already scrolls the element into view using the correct scroll-chain.
  // An explicit JS-level scroll can scroll the *page* when the target lives
  // inside a cdk-overlay-pane (position:fixed), which repositions or hides
  // the Angular Material overlay and causes the subsequent click to miss.

  // Hover warm-up: move the mouse to the element and let Angular process the
  // mouseenter event (ripple, focus ring, change-detection) BEFORE clicking.
  // Without this, click()'s internal hover + click fires so fast that Angular
  // components like particle-button-dropdown are still mid-transition when the
  // mousedown lands, causing the click to register as just a hover.
  try {
    await target.hover({ timeout: timeoutMs });
    await delay(100);
  } catch {
    // hover failed (e.g. element moved) — proceed to the click loop which
    // has its own retries and fallbacks.
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await target.click({ timeout: timeoutMs });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await delay(250 * attempt);
      }
    }
  }

  // Fallback 1: force click — bypasses actionability checks (useful when an
  // invisible overlay intercepts pointer events).
  if (forceOnLastRetry) {
    try {
      await target.click({ timeout: timeoutMs, force: true });
      return;
    } catch (forceError) {
      lastError = forceError;
    }
  }

  // Fallback 2: synthetic DOM click — reaches the handler even when
  // Playwright's pointer-based click cannot land.
  try {
    await target.dispatchEvent('click');
    return;
  } catch (dispatchError) {
    lastError = dispatchError;
  }

  throw new Error(`Stable click failed for ${label}: ${String(lastError ?? 'unknown error')}`);
}

/**
 * Hover over `target` and poll until `revealedLocator` becomes visible.
 * Retries the full hover if the expected element does not appear, which
 * handles cases where the pointer drifts off the element mid-animation
 * and the Angular Material submenu collapses before we can act on it.
 */
async function stableHover(
  target: Locator,
  revealedLocator: Locator,
  label: string,
  options?: {
    timeoutMs?: number;
    retries?: number;
    postHoverDelayMs?: number;
  },
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? config.defaultTimeoutMs;
  const retries = options?.retries ?? 4;
  const postHoverDelayMs = options?.postHoverDelayMs ?? 150;

  await target.waitFor({ state: 'visible', timeout: timeoutMs });
  // Do NOT scrollIntoViewIfNeeded — Playwright's hover() handles scroll and
  // a JS-level scroll can reposition cdk-overlay panels that host menu items.

  let lastError: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await target.hover({ timeout: timeoutMs, force: false });
      // Allow CSS transition / Angular animation to complete.
      await delay(postHoverDelayMs);

      // Confirm the downstream element has appeared before returning.
      await revealedLocator.waitFor({ state: 'visible', timeout: 3000 });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        // Move mouse away briefly to reset any hover state, then retry.
        await target.page().mouse.move(0, 0);
        await delay(300 * attempt);
      }
    }
  }

  throw new Error(`Stable hover failed for ${label}: ${String(lastError ?? 'unknown error')}`);
}

/**
 * Open the oldest action-list item without triggering Playwright's auto-scroll loop.
 * Uses DOM click first (no auto-scroll), then a force-click fallback.
 */
async function openOldestActionListItem(page: Page, actionListItems: Locator): Promise<void> {
  const oldestRow = actionListItems.last();
  const oldestRowContent = oldestRow.locator('.action-list-item-content').first();
  const formRenderer = page.locator('e3e-form-renderer');

  await expect(oldestRow).toBeVisible({ timeout: config.navigationTimeoutMs });

  const clickTargets: Locator[] = [oldestRowContent, oldestRow];
  for (const target of clickTargets) {
    try {
      if (!(await target.isVisible())) {
        continue;
      }

      await target.evaluate((element) => {
        const htmlElement = element as HTMLElement;
        htmlElement.click();
      });

      await expect(formRenderer).toBeVisible({ timeout: config.defaultTimeoutMs });
      return;
    } catch {
      // Try the next target/fallback path
    }
  }

  await oldestRow.click({ force: true, timeout: config.defaultTimeoutMs });
  await expect(formRenderer).toBeVisible({ timeout: config.navigationTimeoutMs });
}

/**
 * Click the primary Submit action (Release) using stable selectors.
 * Falls back to role/text-based submit if needed.
 *
 * Angular Material toolbar buttons are rendered asynchronously; the button
 * may briefly exist in the DOM but be disabled or obscured by a loading
 * overlay.  An outer retry loop re-scans all candidates so a transient
 * failure on one selector does not mask another that becomes ready later.
 */
async function clickSubmitAction(page: Page): Promise<void> {
  // Let Angular finish any in-flight change-detection cycle before we look
  // for the button.  domcontentloaded is fast and avoids races that happen
  // when the toolbar rerenders after a prior async operation.
  await page.waitForLoadState('domcontentloaded');

  const candidateSelectors = [
    'button[data-automation-id="RELEASE"]',
    'particle-button-dropdown[pendo-id="RELEASE"] button',
  ] as const;

  const maxAttempts = 4;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // 1. Try strongly-typed automation-ID / pendo-ID selectors first.
    for (const selector of candidateSelectors) {
      const candidate = page.locator(selector).first();
      try {
        if (!(await candidate.isVisible())) continue;

        // Extra settle: wait for the button to be enabled (Angular may
        // disable toolbar actions while processing a previous operation).
        await expect(candidate).toBeEnabled({ timeout: config.defaultTimeoutMs });

        await stableClick(candidate, 'Submit/Release button', { retries: 2 });
        return;
      } catch (error) {
        lastError = error;
      }
    }

    // 2. Role-based fallback (catches apps that render plain <button>Submit</button>).
    const roleCandidate = page.getByRole('button', { name: /^\s*Submit\s*$/ }).first();
    try {
      if (await roleCandidate.isVisible()) {
        await expect(roleCandidate).toBeEnabled({ timeout: config.defaultTimeoutMs });
        await stableClick(roleCandidate, 'Submit button (role fallback)', { retries: 2 });
        return;
      }
    } catch (error) {
      lastError = error;
    }

    if (attempt < maxAttempts) {
      // Brief back-off before rescanning — Angular may still be rendering.
      await delay(400 * attempt);
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
  await stableClick(page.getByRole('textbox', { name: 'Enter your email or phone' }), 'Login email input');
  await page.getByRole('textbox', { name: 'Enter your email or phone' }).fill(config.email);
  await page.getByRole('textbox', { name: 'Enter your email or phone' }).press('Enter');
  await page.locator('#i0118').fill(config.password);
  await stableClick(page.getByRole('button', { name: 'Sign in' }), 'Login Sign in button');
  await stableClick(page.getByRole('button', { name: 'Yes' }), 'Stay signed in Yes button');
  await page.waitForLoadState('domcontentloaded');
  debugLog('  Login successful');
}

/* ================================================================== *
 *  Phase 1 – Open each receipt and perform reverse action             *
 * ================================================================== */

async function processReceipt(
  page: Page,
  receipt: ReceiptGroup,
  blackListPath: string,
): Promise<{ success: boolean; processId: string | null }> {
  debugLog(`  ▸ Processing receipt ${receipt.rcptMasterIndex} (${receipt.invNumbers.length} invoice(s))`);

  // Navigate to receipt process page (full reload resets Angular state)
  await navigateAndWait(page, `${config.baseUrl}/process/RcptMaster#RcptMaster`);

  // Wait for the Angular form to fully render
  await page.waitForSelector('input[id^="mat-input-"]', { state: 'visible', timeout: config.navigationTimeoutMs });

  // Search by RcptMasterIndex in the Quick Find dialog
  const searchInput = page.locator('[pendo-id="e3e-quick-find-search-field"]');
  await searchInput.waitFor({ state: 'visible', timeout: config.navigationTimeoutMs });
  await stableClick(searchInput, 'Receipt quick-find input');
  await page.keyboard.type(receipt.rcptMasterIndex.toString());

  // Click the SEARCH button — the app auto-selects the matching receipt and opens it
  await stableClick(page.getByRole('button', { name: 'SEARCH' }), 'Receipt SEARCH button');
  await page.locator('e3e-form-renderer').waitFor({ state: 'visible', timeout: config.navigationTimeoutMs });
  debugLog(`    ✓ Receipt ${receipt.rcptMasterIndex} opened`);

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
  await stableClick(
    page
      .locator('e3e-process-toolbar')
      .getByRole('button')
      .filter({ hasText: 'more_vert' })
      .first(),
    'Process toolbar overflow menu',
  );
  await stableClick(page.getByRole('menuitem', { name: 'Folder' }), 'Folder menu item');

  // Select unit — skip only the unit dropdown when 9100
  if (nxUnit !== '9100') {
    const unitDropdownBtn = page
      .locator('#process-folder-unit')
      .getByRole('button')
      .filter({ hasText: 'arrow_drop_down' });
    await stableClick(unitDropdownBtn, 'Unit dropdown button');

    // Wait for the dropdown panel to be visible before typing
    await page.locator('.mat-autocomplete-panel, mat-option').first()
      .waitFor({ state: 'visible', timeout: config.navigationTimeoutMs });

    const unitFilterInput = page.locator('#process-folder-unit').locator('input');
    await unitFilterInput.fill(nxUnit);

    // Give Angular time to filter the dropdown options after typing
    await delay(500);

    // Wait for the filtered option to appear, then click it
    const firstOption = page.locator('mat-option').first();
    await firstOption.waitFor({ state: 'visible', timeout: config.navigationTimeoutMs });
    await stableClick(firstOption, 'Unit first option');
  }

  // Check the Reversal checkbox first, then Reallocate (using stable pendo-id attributes)
  const reversalCheckbox = page
    .locator('[pendo-id="/objects/RcptMaster/rows/attributes/IsReversed"] .mat-checkbox-inner-container');
  await reversalCheckbox.waitFor({ state: 'visible', timeout: config.navigationTimeoutMs });
  await stableClick(reversalCheckbox, 'Reversal checkbox');

  // Wait for Angular to enable the Reallocate checkbox after Reversal is checked
  await delay(500);

  const reallocateCheckbox = page
    .locator('[pendo-id="/objects/RcptMaster/rows/attributes/IsReverseAndReallocate"] .mat-checkbox-inner-container');
  await reallocateCheckbox.waitFor({ state: 'visible', timeout: config.navigationTimeoutMs });
  await stableClick(reallocateCheckbox, 'Reallocate checkbox');

  // Fill Reverse Date & Reversal Reason using stable field attributes.
  const reverseDateInput = page.locator(
    'div[pendo-id="/objects/RcptMaster/rows/attributes/ReverseDate"] input.mat-input-element',
  );
  const reverseReasonInput = page.locator(
    'input[pendo-id="/objects/RcptMaster/rows/attributes/ReverseReason"]',
  );

  await reverseDateInput.waitFor({ state: 'visible', timeout: config.navigationTimeoutMs });
  await stableClick(reverseDateInput, 'Reverse date input');
  await reverseDateInput.fill(rcptDate);

  await reverseReasonInput.waitFor({ state: 'visible', timeout: config.navigationTimeoutMs });
  await stableClick(reverseReasonInput, 'Reverse reason input');
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
      debugLog(`    \u26a0 Blocked receipt detected: ${msg}`);
      await dismissPopup(page);

      // Capture screenshot + UI state for offline debugging.
      await captureFailureDiagnostics(page, `phase1-receipt-${receipt.rcptMasterIndex}`);

      // Capture detailed validation errors from the error panel before blacklisting.
      const validationErrors = await extractValidationErrors(page);
      if (validationErrors.length > 0) {
        debugLog(`    ▸ Validation errors (${validationErrors.length}):`);
        for (const ve of validationErrors) {
          debugLog(`      • ${ve}`);
        }
      }

      const validationSummary =
        validationErrors.length > 0
          ? validationErrors.map((e, i) => `  ${i + 1}. ${e}`).join('\n')
          : null;

      const failureReason = validationSummary
        ? `${msg}\n# Validation errors:\n${validationSummary}`
        : msg;

      appendToBlackList(blackListPath, receipt, failureReason);
      await cancelCurrentRow(page);
      await navigateAndWait(page, `${config.baseUrl}/dashboard`);
      return { success: false, processId: null };
    }

    // Non-fatal popup (e.g. informational message about a successful reversal) — dismiss and continue
    debugLog(`    \u2139 Informational popup (not an error): ${msg}`);
    await dismissPopup(page);
  }

  // Navigate to dashboard, then open the top (newest) action list item to capture the processId
  await navigateAndWait(page, `${config.baseUrl}/dashboard`);

  let processId: string | null = null;
  try {
    const actionListItems = page.locator('e3e-dashboard-action-list-panel ul.action-list-items li');
    await actionListItems.first().waitFor({ state: 'visible', timeout: config.navigationTimeoutMs });

    // The newest/top item is the reversed receipt just created — click it to get its URL
    const newestRow = actionListItems.first();
    const newestRowContent = newestRow.locator('.action-list-item-content').first();
    await newestRowContent.evaluate((el) => (el as HTMLElement).click());
    await page.locator('e3e-form-renderer').waitFor({ state: 'visible', timeout: config.defaultTimeoutMs });

    processId = parseProcessIdFromUrl(page.url());
    if (processId) {
      debugLog(`    \u2713 Captured process ID from top action list item: ${processId}`);
    } else {
      debugLog(`    \u26a0 Could not parse process ID from URL: ${page.url()}`);
    }

    // Navigate back to dashboard without submitting anything
    await navigateAndWait(page, `${config.baseUrl}/dashboard`);
  } catch {
    debugLog(`    \u26a0 Could not capture process ID from action list`);
  }

  return { success: true, processId };
}

async function updateReceiptInvoices(page: Page, receipt: ReceiptGroup): Promise<void> {
  await waitForReceiptMasterIndexAuto(page, `Phase 3 pre-invoice-update receipt ${receipt.rcptMasterIndex}`);

  const invoicesTab = page
    .locator('.mat-tab-label')
    .filter({ has: page.locator('div[pendo-id="/objects/RcptMaster/rows/childObjects/RcptInvoice"]') })
    .first();
  await invoicesTab.waitFor({ state: 'visible', timeout: config.navigationTimeoutMs });
  await stableClick(invoicesTab, 'Invoices tab');

  // Remove existing invoices, then add each invoice for this receipt.
  const removeActionsContainer = page
    .locator('div[pendo-id="/objects/RcptMaster/rows/childObjects/RcptInvoice/actions/Remove"]')
    .first();
  await expect(removeActionsContainer).toBeVisible({ timeout: config.navigationTimeoutMs });

  async function openRemoveMenuAndClickRemoveAll(): Promise<void> {
    // The Remove dropdown is an Angular Material mat-menu-trigger.  Its click
    // handler toggles a cdk-overlay menu.  Playwright's pointer-based click()
    // sometimes fires during Angular's mouseenter change-detection cycle and
    // registers as a hover instead of a click.
    //
    // Strategy: use evaluate(el => el.click()) to dispatch a synchronous DOM
    // click event that bypasses pointer-event timing entirely.  Then locate
    // the "Remove All" menu item directly in the overlay (no aria-controls
    // indirection needed — the overlay is page-global).

    const maxAttempts = 4;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        // Re-query the button each attempt (Angular may re-render the row GUID).
        const removeDropdownButton = page
          .locator('button[data-automation-id$="/childObjects/RcptInvoice/actions/Remove-dropdown"]')
          .first();

        await removeDropdownButton.waitFor({ state: 'visible', timeout: config.navigationTimeoutMs });
        await expect(removeDropdownButton).toBeEnabled({ timeout: config.defaultTimeoutMs });

        // If the menu is already open from a prior failed attempt, close it first.
        if ((await removeDropdownButton.getAttribute('aria-expanded')) === 'true') {
          await page.keyboard.press('Escape');
          await delay(300);
        }

        // Synchronous DOM click — most reliable for mat-menu-trigger.
        await removeDropdownButton.evaluate((el) => (el as HTMLElement).click());

        // Wait for the menu overlay to appear.  Locate "Remove All" directly
        // — it's the definitive signal the menu opened successfully.
        const removeAllMenuItem = page
          .locator('button[data-automation-id$="/childObjects/RcptInvoice/actions/btnRemoveAll"]')
          .first();

        const menuOpened = await removeAllMenuItem
          .waitFor({ state: 'visible', timeout: 4000 })
          .then(() => true)
          .catch(() => false);

        if (!menuOpened) {
          // DOM click didn't open the menu — try Playwright force-click as a 2nd path.
          await removeDropdownButton.click({ force: true, timeout: 5000 });
          await removeAllMenuItem.waitFor({ state: 'visible', timeout: 4000 });
        }

        // Let mat-menu's enter animation finish before interacting with items.
        // The menu uses @transformMenu with a 120ms cubic-bezier transition;
        // clicking during the animation can miss because the overlay is still
        // fading in / repositioning.
        await delay(200);

        // Click "Remove All" via Playwright's click() — unlike the dropdown
        // trigger, menu items don't have the mouseenter timing issue.
        // Playwright's click is preferred here because Angular's
        // e3e-delay-CollectionAction directive requires a full mousedown →
        // mouseup → click sequence fired within Angular's zone, which a bare
        // evaluate(el.click()) doesn't provide.
        await removeAllMenuItem.click({ timeout: 5000 });

        // Confirm the menu closed (Angular processes the action).
        await removeAllMenuItem.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
        return;
      } catch (error) {
        lastError = error;
        // Dismiss any stale overlay before retrying.
        await page.keyboard.press('Escape');
        await delay(400 * attempt);
        debugLog(`    ⟳ Remove dropdown attempt ${attempt}/${maxAttempts} failed — retrying`);
      }
    }

    throw new Error(
      `openRemoveMenuAndClickRemoveAll failed after ${maxAttempts} attempts: ` +
      String(lastError ?? 'unknown error'),
    );
  }

  await openRemoveMenuAndClickRemoveAll();

  async function openInvoiceSearchDialogFromOptionsMenu(): Promise<void> {
    const childFormOptionsButton = page
      .locator('button.child-form-tabs-btn.options-menu')
      .first();

    const invoicesMenuItem = page
      .locator('.cdk-overlay-pane .mat-menu-panel:not(.mat-menu-panel-hidden) button[mat-menu-item]')
      .filter({ hasText: 'Invoices' })
      .first();

    // The "Add" submenu item only appears after hovering over "Invoices".
    const overlayAddMenuItem = page
      .locator('.cdk-overlay-pane .mat-menu-panel:not(.mat-menu-panel-hidden) button[mat-menu-item]')
      .filter({ hasText: /^\s*Add\s*$/ })
      .first();

    // Retry the full open-menu → hover → click sequence because Angular Material
    // menus collapse when the pointer drifts off the panel mid-animation, leaving
    // the Add item invisible before stableClick can reach it.
    const maxMenuRetries = 3;
    let lastMenuError: unknown;
    for (let menuAttempt = 1; menuAttempt <= maxMenuRetries; menuAttempt++) {
      try {
        await childFormOptionsButton.waitFor({ state: 'visible', timeout: config.navigationTimeoutMs });
        await stableClick(childFormOptionsButton, 'Child form options button');

        await invoicesMenuItem.waitFor({ state: 'visible', timeout: config.navigationTimeoutMs });

        // stableHover retries the hover and polls for the Add submenu item to
        // become visible, catching cases where the pointer leaves the panel too
        // quickly and the submenu collapses before we can click.
        await stableHover(invoicesMenuItem, overlayAddMenuItem, 'Invoices submenu item', {
          timeoutMs: config.navigationTimeoutMs,
          retries: 4,
          postHoverDelayMs: 200,
        });

        await stableClick(overlayAddMenuItem, 'Invoices Add menu item');
        return;
      } catch (error) {
        lastMenuError = error;
        if (menuAttempt < maxMenuRetries) {
          // Dismiss any stale overlay before re-opening the menu.
          await page.keyboard.press('Escape');
          await delay(500 * menuAttempt);
        }
      }
    }

    throw new Error(
      `openInvoiceSearchDialogFromOptionsMenu failed after ${maxMenuRetries} attempts: ` +
      String(lastMenuError ?? 'unknown error'),
    );
  }

  async function openInvoiceSearchDialogFromDirectAddButton(): Promise<void> {
    const directAddButton = page
      .locator('button[data-automation-id$="/childObjects/RcptInvoice/actions/AddByQuery"]:visible')
      .first();
    await directAddButton.waitFor({ state: 'visible', timeout: config.navigationTimeoutMs });
    await stableClick(directAddButton, 'Direct Add invoice button');
  }

  async function searchAndSelectInvoice(invNumber: string): Promise<void> {
    // The query dialog may already be open from the previous step (options menu
    // or direct-add button).  Locate the search input inside the dialog.
    const addDialogInput = page.locator('input[pendo-id="e3e-quick-find-search-field"]:visible').last();
    await addDialogInput.waitFor({ state: 'visible', timeout: config.navigationTimeoutMs });
    await addDialogInput.click({ timeout: config.defaultTimeoutMs });
    await addDialogInput.fill(invNumber);

    const searchButton = page.locator('button[pendo-id="e3e-query-dialog-search-button"]');
    await searchButton.waitFor({ state: 'visible', timeout: config.navigationTimeoutMs });
    await stableClick(searchButton, 'Invoice dialog Search button');

    // Wait for the ag-grid to finish loading results.  The grid adds an
    // overlay wrapper while loading; wait for it to disappear, then wait for
    // the first result row to render.
    const gridLoadingOverlay = page.locator('.ag-overlay-loading-wrapper');
    await gridLoadingOverlay.waitFor({ state: 'hidden', timeout: config.defaultTimeoutMs }).catch(() => {});

    const firstResultCheckbox = page
      .locator('.ag-center-cols-container .ag-row[row-index="0"] input[type="checkbox"]')
      .first();
    await firstResultCheckbox.waitFor({ state: 'visible', timeout: config.navigationTimeoutMs });
    await firstResultCheckbox.check({ timeout: config.defaultTimeoutMs });

    const selectButton = page.locator('button[pendo-id="e3e-query-dialog-select-button"]');
    await selectButton.waitFor({ state: 'visible', timeout: config.navigationTimeoutMs });
    await stableClick(selectButton, 'Invoice dialog Select button');

    // Wait for the query dialog to close — this is the real sync point.
    // domcontentloaded resolves instantly in a SPA and provides no
    // synchronisation.  Waiting for the dialog/Select button to disappear
    // ensures Angular has finished processing the selection.
    await selectButton.waitFor({ state: 'hidden', timeout: config.navigationTimeoutMs }).catch(() => {});
    await delay(300);
  }

  for (const [invoiceIndex, invNumber] of receipt.invNumbers.entries()) {
    debugLog(`    ▹ Adding invoice ${invNumber}`);

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
  debugLog(`  ▸ Triggering runbook for ${label} — invoices: ${invoiceIds}`);

  await azurePage.bringToFront();
  await navigateAndWait(azurePage, config.azureRunbookUrl);

  await stableClick(azurePage.getByRole('button', { name: 'Start' }), 'Azure runbook Start button');

  const startFrame = azurePage
    .locator('iframe[name="StartRunbook.ReactView"]')
    .contentFrame();
  await stableClick(startFrame.getByRole('textbox', { name: 'Enter a value' }), 'Azure runbook parameter input');
  await startFrame.getByRole('textbox', { name: 'Enter a value' }).fill(invoiceIds);
  await stableClick(startFrame.getByRole('button', { name: 'Start' }), 'Azure runbook confirm Start button');

  // Poll the Job Dashboard by clicking Refresh until status becomes "Completed"
  const jobFrame = azurePage
    .locator('iframe[name="JobDashboard.ReactView"]')
    .contentFrame();

  const deadline = Date.now() + config.runbookMaxWaitMs;
  while (Date.now() < deadline) {
    // Click Refresh first, then check for status
    await stableClick(jobFrame.getByRole('menuitem', { name: 'Refresh' }), 'Azure job Refresh menu item');
    await delay(config.runbookPollingIntervalMs);

    const statusText = await jobFrame
      .locator('[aria-label="Status Completed"]')
      .textContent()
      .catch(() => null);

    if (statusText?.includes('Completed')) {
      debugLog(`    ✓ Runbook completed for ${label}`);
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
  processIdMap: Map<string, ReceiptGroup>,
  blackListPath: string,
): Promise<void> {
  await page.bringToFront();
  await navigateAndWait(page, `${config.baseUrl}/dashboard`);

  const actionListItems = page.locator('e3e-dashboard-action-list-panel ul.action-list-items li');
  debugLog(`  ▸ Draining all opened processes from action list`);

  // Safety limit: at most one iteration per mapped receipt plus a margin for leftovers.
  const maxIterations = processIdMap.size + 20;
  let submitted = 0;
  // Track process IDs we have already written to the blacklist to prevent duplicate entries
  // when the same failing item is encountered on successive loop iterations.
  const blacklistedProcessIds = new Set<string>();
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
    await delay(500);

    const count = await actionListItems.count();
    if (count === 0) {
      debugLog('    \u2713 Action list is empty \u2014 all processes submitted');
      break;
    }

    // Stall detection: if the count doesn't decrease, we may be stuck on failing items
    if (count >= lastActionListCount) {
      consecutiveStalls++;
      if (consecutiveStalls >= maxConsecutiveStalls) {
        debugLog(
          `    \u26a0 Action list stuck at ${count} item(s) after ${consecutiveStalls} consecutive stalls \u2014 ` +
          `remaining items likely need manual intervention`,
        );
        break;
      }
    } else {
      consecutiveStalls = 0;
    }
    lastActionListCount = count;

    debugLog(`    Action list has ${count} item(s) remaining`);
    await expect(actionListItems.first()).toBeVisible({ timeout: config.navigationTimeoutMs });

    // Open the oldest item (last in the list)
    await openOldestActionListItem(page, actionListItems);

    // Match the opened process to a receipt group via URL processId lookup
    const currentUrl = page.url();
    const currentProcessId = parseProcessIdFromUrl(currentUrl);
    let currentReceipt: ReceiptGroup | null = null;

    if (currentProcessId && processIdMap.has(currentProcessId)) {
      currentReceipt = processIdMap.get(currentProcessId)!;
      debugLog(`    \u25b9 Matched process ${currentProcessId} \u2192 receipt ${currentReceipt.rcptMasterIndex}`);
      await updateReceiptInvoices(page, currentReceipt);
    } else {
      debugLog(
        `    \u25b9 No matching receipt found for process ${currentProcessId ?? '(no GUID in URL)'} \u2014 submitting without invoice changes`,
      );
    }

    const openedReversedReceiptIndex = await getCurrentReceiptIndex(page);

    // Submit the receipt
    await clickSubmitAction(page);

    // Wait for form to close (success) or popup (failure)
    const phase3Result = await waitForPhase3SubmitResult(page);
    if (!phase3Result.success) {
      const msg = phase3Result.popupMessage ?? '';
      const relatedReversedReceiptIndex =
        (await getCurrentReceiptIndex(page)) ?? openedReversedReceiptIndex;

      debugLog(`    \u26a0 Popup detected after Phase 3 submit: ${msg}`);
      await dismissPopup(page);

      // Capture screenshot + UI state for offline debugging.
      const receiptLabel = currentReceipt
        ? `receipt-${currentReceipt.rcptMasterIndex}`
        : `process-${currentProcessId ?? 'unknown'}`;
      await captureFailureDiagnostics(page, `phase3-${receiptLabel}`);

      // Attempt to read detailed validation errors from the error panel.
      const validationErrors = await extractValidationErrors(page);
      const validationSummary =
        validationErrors.length > 0
          ? validationErrors.map((e, i) => `  ${i + 1}. ${e}`).join('\n')
          : null;

      if (validationErrors.length > 0) {
        debugLog(`    ▸ Validation errors (${validationErrors.length}):`);
        for (const ve of validationErrors) {
          debugLog(`      • ${ve}`);
        }
      }

      const alreadyBlacklisted = !!currentProcessId && blacklistedProcessIds.has(currentProcessId);

      if (alreadyBlacklisted) {
        debugLog(`    ↷ Process ${currentProcessId} already blacklisted — skipping duplicate entry`);
      } else {
        if (currentProcessId) blacklistedProcessIds.add(currentProcessId);

        // Build the failure reason string that will be written to the blacklist.
        const failureReason = validationSummary
          ? `Phase 3 submit failure \u2014 ${msg}\n# Validation errors:\n${validationSummary}`
          : `Phase 3 submit failure \u2014 ${msg}`;

        if (currentReceipt) {
          appendToBlackList(
            blackListPath,
            currentReceipt,
            failureReason,
            relatedReversedReceiptIndex,
          );
        } else {
          const reversedReceiptLine = relatedReversedReceiptIndex
            ? `# Related reversed receipt index: ${relatedReversedReceiptIndex}\n`
            : '';
          fs.appendFileSync(
            blackListPath,
            `# Unknown receipt \u2014 ${failureReason}\n${reversedReceiptLine}\n`,
            'utf-8',
          );
          debugLog('    \u2717 Unknown receipt added to blacklist');
        }
      }

      // Do NOT cancel in Phase 3 — go to dashboard and continue
      await navigateAndWait(page, `${config.baseUrl}/dashboard`);
      continue;
    }

    await page.waitForLoadState('networkidle', { timeout: config.navigationTimeoutMs });

    submitted++;
    debugLog(`    \u2713 Submit completed (${submitted} total)`);
  }

  // Final verification: navigate to dashboard and check the action list
  await navigateAndWait(page, `${config.baseUrl}/dashboard`);
  await delay(500);
  const remainingCount = await actionListItems.count();
  if (remainingCount > 0) {
    debugLog(
      `  \u26a0 Action list still has ${remainingCount} item(s) after ${submitted} submission(s). ` +
      `These may be blacklisted receipts requiring manual intervention.`,
    );
      await appendRemainingActionListItemsToBlackList(actionListItems, blackListPath);
  } else {
    debugLog(`  \u2713 Verified: action list is empty after submitting ${submitted} process(es)`);
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
  debugLog(
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
  initDebugLog(runTimestamp);

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex];
    debugLog(
      `\n═══ Batch ${batchIndex + 1}/${batches.length} ` +
      `(${batch.length} receipt(s)) ═══`,
    );

    // ── Phase 1: Open each receipt and perform reverse action ────────
    debugLog('═══ Phase 1: Process receipts ═══');
    const successfulReceipts: ReceiptGroup[] = [];
    const processIdMap = new Map<string, ReceiptGroup>();
    for (const receipt of batch) {
      const result = await processReceipt(page, receipt, blackListFilePath);
      if (result.success) {
        successfulReceipts.push(receipt);
        if (result.processId) {
          processIdMap.set(result.processId, receipt);
          debugLog(`  ↳ Mapped process ${result.processId} → receipt ${receipt.rcptMasterIndex}`);
        } else {
          debugLog(`  ⚠ Receipt ${receipt.rcptMasterIndex} succeeded but no process ID captured — will not be matched in Phase 3`);
        }
      }
    }
    debugLog(
      `  Phase 1 complete: ${successfulReceipts.length}/${batch.length} receipt(s) succeeded`,
    );

    // ── Phase 2: Trigger Azure Runbook with invoices from successful receipts ─
    debugLog('\n═══ Phase 2: Trigger Azure Runbook ═══');
    const batchInvMasterIndices = [...new Set(successfulReceipts.flatMap(r => r.invMasterIndices))];
    const batchInvoiceIds = batchInvMasterIndices.join(',');
    debugLog(
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
      debugLog('  No CORRUPTED invoices in this batch; skipping runbook trigger');
    }

    // ── Phase 3: Submit opened receipts from dashboard (oldest first) ─
    debugLog('\n═══ Phase 3: Submit opened receipts from dashboard ═══');
    await submitOpenedReceipts(page, processIdMap, blackListFilePath);
  }

  await azurePage.close();

  // Report blacklist summary
  if (fs.existsSync(blackListFilePath)) {
    debugLog(`\n\u26a0 Some receipts were blacklisted \u2014 see ${blackListFilePath}`);
  }
  debugLog('\n\u2713 All receipts processed');
  debugLog(`\n📝 Debug log saved to ${debugLogFilePath}`);
});