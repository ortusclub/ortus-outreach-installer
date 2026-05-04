/**
 * Google Sheets writer.
 *
 * Writes tracking data back to ANY Google Sheet via the central Apps Script.
 * The Apps Script is deployed once from the Ortus master sheet but can
 * update any sheet the deploying Google account has edit access to.
 *
 * The sheetId is extracted from whatever Google Sheet URL the campaign uses.
 */

import { extractSheetId } from './utils.js';

const getWebAppUrl = () => process.env.SHEETS_WEBAPP_URL || '';

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
    // Apps Script returns 302 on POST. Node fetch converts POST→GET on
    // redirect, hitting doGet() instead of doPost(). Handle manually.
    // P-05 fix (2.8.18): 15s timeout on both legs of the redirect chain.
    // Without it, an Apps Script hang stalls the campaign loop indefinitely.
    const body = JSON.stringify(payload);
    const signal = AbortSignal.timeout(15000);
    const initial = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      redirect: 'manual',
      signal,
    });

    let res;
    if (initial.status >= 300 && initial.status < 400) {
      const location = initial.headers.get('location');
      res = await fetch(location, { signal: AbortSignal.timeout(15000) });
    } else {
      res = initial;
    }

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
export async function updateSheetRow(sheetUrl, linkedinUrl, tracking, linkedinColumn) {
  if (!getWebAppUrl()) {
    console.log('[sheets-writer] No SHEETS_WEBAPP_URL configured — skipping');
    return false;
  }

  const sheetId = extractSheetId(sheetUrl);

  const result = await postToWebApp({
    action: 'updateRow',
    sheetId,
    linkedinUrl,
    urlColumnName: linkedinColumn || '',
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
 * Phase 11.3 — reads the Reply tracking columns for a single row.
 * Used by check-dms.js's non-destructive writeback: if the row already has
 * Reply="yes" we skip re-writing (preserves manual operator edits).
 *
 * Returns { Reply, ReplyAt, ReplyPreview } on hit, null if row not found or
 * webapp not configured. The Apps Script's `getRowStatus` action must return
 * { success: true, row: { Reply, ReplyAt, ReplyPreview }, ... } for a match.
 *
 * @param {string} sheetUrl - The Google Sheet URL
 * @param {string} linkedinUrl - LinkedIn profile URL
 * @param {string} linkedinColumn - name of the URL column
 * @returns {Promise<{Reply?: string, ReplyAt?: string, ReplyPreview?: string} | null>}
 */
export async function getSheetRowStatus(sheetUrl, linkedinUrl, linkedinColumn) {
  if (!getWebAppUrl()) return null;

  const sheetId = extractSheetId(sheetUrl);

  const result = await postToWebApp({
    action: 'getRowStatus',
    sheetId,
    linkedinUrl,
    urlColumnName: linkedinColumn || '',
  });

  if (result?.success && result?.row) {
    return {
      Reply: result.row.Reply || result.row.reply || '',
      ReplyAt: result.row['Reply At'] || result.row.replyAt || '',
      ReplyPreview: result.row['Reply Preview'] || result.row.replyPreview || '',
    };
  }

  // Row not found or error → treat as "no status" so caller can write freely.
  return null;
}

/**
 * 2.9.4: Append one message to the Replies tab. Bridge dedupes on
 * (leadUrl, timestamp) so re-polls are idempotent. Direction is 'in'
 * (inbound — the lead replied) or 'out' (outbound — we sent it).
 *
 * @param {string} sheetUrl
 * @param {object} reply { leadUrl, timestamp, direction, sender, body }
 * @returns {Promise<boolean>}
 */
export async function appendReplyRow(sheetUrl, reply) {
  if (!getWebAppUrl()) {
    console.log('[sheets-writer] No SHEETS_WEBAPP_URL — skipping Replies append');
    return false;
  }
  if (!reply?.leadUrl || !reply?.timestamp) {
    console.warn('[sheets-writer] appendReplyRow: leadUrl + timestamp required');
    return false;
  }
  const sheetId = extractSheetId(sheetUrl);
  const result = await postToWebApp({
    action: 'appendReply',
    sheetId,
    leadUrl: reply.leadUrl,
    timestamp: reply.timestamp,
    direction: reply.direction || '',
    sender: reply.sender || '',
    body: reply.body || '',
  });
  if (result?.success) {
    if (result.deduped) {
      console.log(`[sheets-writer] Replies row already exists (deduped) for ${reply.leadUrl}`);
    } else {
      console.log(`[sheets-writer] ✓ Appended Replies row ${result.row} for ${reply.leadUrl}`);
    }
    return true;
  }
  if (result?.error) {
    console.warn(`[sheets-writer] appendReply failed: ${result.error}`);
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
