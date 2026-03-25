/**
 * Google Sheets writer.
 *
 * Writes tracking data back to ANY Google Sheet via the central Apps Script.
 * The Apps Script is deployed once from the Ortus master sheet but can
 * update any sheet the deploying Google account has edit access to.
 *
 * The sheetId is extracted from whatever Google Sheet URL the campaign uses.
 */

const getWebAppUrl = () => process.env.SHEETS_WEBAPP_URL || '';

/**
 * Extract Google Sheet ID from a URL.
 */
function extractSheetId(url) {
  const match = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  if (/^[a-zA-Z0-9_-]+$/.test(url.trim())) return url.trim();
  throw new Error(`Cannot extract Sheet ID from: ${url}`);
}

/**
 * POST to the Apps Script web app.
 */
async function postToWebApp(payload) {
  const url = getWebAppUrl();
  if (!url) {
    console.log('[sheets-writer] No SHEETS_WEBAPP_URL configured — skipping');
    return null;
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      redirect: 'follow', // Apps Script redirects on POST
    });

    // Apps Script returns a redirect to the actual response
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      // Sometimes the response is HTML (Google login page) — means auth issue
      if (text.includes('accounts.google.com') || text.includes('Sign in')) {
        console.warn('[sheets-writer] Apps Script returned login page — redeployment may be needed');
        return { error: 'Authentication error — redeploy the Apps Script' };
      }
      return { raw: text };
    }
  } catch (err) {
    console.warn(`[sheets-writer] POST failed: ${err.message}`);
    return { error: err.message };
  }
}

/**
 * Ensures tracking columns exist in the target sheet.
 * Call once at campaign start.
 *
 * @param {string} sheetUrl - Any Google Sheet URL
 */
export async function ensureTrackingColumns(sheetUrl) {
  if (!getWebAppUrl()) return false;

  const sheetId = extractSheetId(sheetUrl);
  console.log(`[sheets-writer] Ensuring tracking columns on sheet ${sheetId}…`);

  const result = await postToWebApp({
    action: 'ensureColumns',
    sheetId,
  });

  if (result?.success) {
    console.log(`[sheets-writer] ✓ Columns ready. ${result.added?.length ? 'Added: ' + result.added.join(', ') : 'All existed.'}`);
    return true;
  }

  if (result?.error) {
    console.warn(`[sheets-writer] ensureColumns failed: ${result.error}`);
  }
  return false;
}

/**
 * Updates a single row's tracking data in the target sheet.
 *
 * @param {string} sheetUrl - The Google Sheet URL (any sheet)
 * @param {string} linkedinUrl - LinkedIn profile URL (used to find the row)
 * @param {object} tracking - Fields to update
 */
export async function updateSheetRow(sheetUrl, linkedinUrl, tracking) {
  if (!getWebAppUrl()) {
    console.log('[sheets-writer] No SHEETS_WEBAPP_URL configured — skipping');
    return false;
  }

  const sheetId = extractSheetId(sheetUrl);

  const result = await postToWebApp({
    action: 'updateRow',
    sheetId,
    linkedinUrl,
    ...tracking,
  });

  if (result?.success) {
    console.log(`[sheets-writer] ✓ Updated row ${result.row} in sheet ${sheetId}`);
    return true;
  }

  if (result?.error) {
    console.warn(`[sheets-writer] Update failed for ${linkedinUrl}: ${result.error}`);
  }
  return false;
}

/**
 * Batch update multiple rows at once (more efficient for large campaigns).
 *
 * @param {string} sheetUrl - The Google Sheet URL
 * @param {Array<{linkedinUrl: string, [key: string]: string}>} updates
 */
export async function batchUpdateSheet(sheetUrl, updates) {
  if (!getWebAppUrl() || !updates.length) return false;

  const sheetId = extractSheetId(sheetUrl);

  const result = await postToWebApp({
    action: 'batchUpdate',
    sheetId,
    updates,
  });

  if (result?.success) {
    console.log(`[sheets-writer] ✓ Batch updated ${result.processed} rows in sheet ${sheetId}`);
    return true;
  }

  if (result?.error) {
    console.warn(`[sheets-writer] Batch update failed: ${result.error}`);
  }
  return false;
}
