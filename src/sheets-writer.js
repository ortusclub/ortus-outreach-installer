/**
 * Google Sheets writer.
 *
 * Writes tracking data back to ANY Google Sheet via the central Apps Script.
 * The Apps Script is deployed once from the Ortus master sheet but can
 * update any sheet the deploying Google account has edit access to.
 *
 * The sheetId is extracted from whatever Google Sheet URL the campaign uses.
 */

import { extractSheetId, extractSheetGid } from './utils.js';
import { SHEETS_WEBAPP_URL } from './sheets-webapp-url.js';

// v2.52.0: hard-coded constant from sheets-webapp-url.js wins over .env.
// Function form preserved so the existing call sites don't have to change.
const getWebAppUrl = () => SHEETS_WEBAPP_URL;

// v2.58.x: per-operator timezone. Set once at campaign start by campaign.js
// (reads the launcher's stored preference). Empty string means "no preference"
// and Apps Script falls back to Session.getScriptTimeZone() as before.
let _operatorTz = '';

export function setOperatorTz(tz) {
  _operatorTz = typeof tz === 'string' ? tz : '';
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
    // Apps Script returns 302 on POST. Node fetch converts POST→GET on
    // redirect, hitting doGet() instead of doPost(). Handle manually.
    // P-05 fix (2.8.18): 15s timeout on both legs of the redirect chain.
    // Without it, an Apps Script hang stalls the campaign loop indefinitely.
    // v2.58.x: attach tz so GAS can stamp dateLastAction in the launcher's
    // local time. GAS uses `data.tz || Session.getScriptTimeZone()` so older
    // GAS deployments (pre-paste) silently ignore this field.
    const enriched = _operatorTz ? { ...payload, tz: _operatorTz } : payload;
    const body = JSON.stringify(enriched);
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
export async function ensureTrackingColumns(sheetUrl, mode) {
  if (!getWebAppUrl()) return false;

  const sheetId = extractSheetId(sheetUrl);
  const gid = extractSheetGid(sheetUrl);
  console.log(`[sheets-writer] Ensuring tracking columns on sheet ${sheetId}${mode ? ` (mode: ${mode})` : ''}…`);

  const result = await postToWebApp({
    action: 'ensureColumns',
    sheetId,
    gid: gid || '',
    mode: mode || '',
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
 * v2 schema: provision per-mode columns and hide non-relevant mode columns.
 * Called once at campaign start (replaces ensureTrackingColumns for v2 sheets).
 *
 * @param {string} sheetUrl - any Google Sheet URL
 * @param {string} mode - one of connect_only | check_status | message_only |
 *                        introduce_back | open_profile_only | inmail_only
 * @returns {Promise<{ ok: boolean, added: string[], hidden: string[], shown: string[] }>}
 *          ok=true when the bridge confirmed the prepareSheet call.
 *          Returns { ok: false } silently if SHEETS_WEBAPP_URL isn't set so
 *          local-dev runs without bridge config continue to work.
 */
export async function prepareSheet(sheetUrl, mode) {
  if (!getWebAppUrl()) {
    console.log('[sheets-writer] No SHEETS_WEBAPP_URL configured — prepareSheet skipped');
    return { ok: false, added: [], hidden: [], shown: [] };
  }

  const sheetId = extractSheetId(sheetUrl);
  const gid = extractSheetGid(sheetUrl);
  console.log(`[sheets-writer] prepareSheet(${mode}) on sheet ${sheetId}…`);

  const result = await postToWebApp({
    action: 'prepareSheet',
    sheetId,
    gid: gid || '',
    mode: mode || ''
  });

  if (result?.success) {
    if (result.added?.length) {
      console.log(`[sheets-writer] ✓ prepareSheet added: ${result.added.join(', ')}`);
    }
    if (result.hidden?.length) {
      console.log(`[sheets-writer] ✓ prepareSheet hidden: ${result.hidden.join(', ')}`);
    }
    return { ok: true, added: result.added || [], hidden: result.hidden || [], shown: result.shown || [] };
  }

  if (result?.error) {
    console.warn(`[sheets-writer] prepareSheet failed: ${result.error}`);
  }
  return { ok: false, added: [], hidden: [], shown: [] };
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
  const gid = extractSheetGid(sheetUrl);

  const result = await postToWebApp({
    action: 'updateRow',
    sheetId,
    gid: gid || '',
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
  const gid = extractSheetGid(sheetUrl);

  const result = await postToWebApp({
    action: 'getRowStatus',
    sheetId,
    gid: gid || '',
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
 * 2.9.7: Append one inbound message to the Replies tab. Bridge dedupes on
 * (leadUrl, timestamp) so re-polls are idempotent. Schema columns are
 * First Name | Last Name | Body (Lead URL + Timestamp hidden for dedup).
 *
 * @param {string} sheetUrl
 * @param {object} reply { leadUrl, timestamp, firstName, lastName, body }
 * @returns {Promise<boolean>}
 */
export async function appendReplyRow(sheetUrl, reply) {
  if (!getWebAppUrl()) {
    console.log('[sheets-writer] No SHEETS_WEBAPP_URL — skipping Replies append');
    return false;
  }
  // 2.9.7: dedup is now (leadUrl, body), not (leadUrl, timestamp).
  // Timestamp can be empty when LinkedIn's DOM doesn't expose a <time>
  // element for that message — that's fine, body is the dedup key.
  if (!reply?.leadUrl || !reply?.body) {
    console.warn('[sheets-writer] appendReplyRow: leadUrl + body required');
    return false;
  }
  const sheetId = extractSheetId(sheetUrl);
  const gid = extractSheetGid(sheetUrl);
  const result = await postToWebApp({
    action: 'appendReply',
    sheetId,
    gid: gid || '',
    leadUrl: reply.leadUrl,
    timestamp: reply.timestamp,
    firstName: reply.firstName || '',
    lastName: reply.lastName || '',
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
/**
 * Dump the bulk-check's fetched connections into a sidecar tab on the same
 * sheet for transparency / manual matching. One tab per sender so multi-
 * account sweeps don't overwrite each other.
 *
 * v2.62: `activeSenders` scopes the tab to just the senders of the current
 * campaign. The Apps Script filters out rows whose Account isn't in the
 * list, so the tab acts as a per-campaign Bible — only connections from
 * accounts assigned in the sheet's Sender column survive a refresh.
 * Omit (legacy callers) → no filtering, current behavior preserved.
 */
export async function writeRecentConnectionsTab(sheetUrl, sender, connections, activeSenders) {
  if (!getWebAppUrl()) return null;
  const sheetId = extractSheetId(sheetUrl);
  try {
    const result = await postToWebApp({
      action: 'writeRecentConnections',
      sheetId,
      sender: sender || '',
      connections: connections || [],
      activeSenders: Array.isArray(activeSenders) ? activeSenders : [],
    });
    if (result?.ok) {
      console.log(`[sheets-writer] ✓ Wrote ${result.rows} row(s) to "${result.tab}" (accumulated: ${Array.isArray(result.accumulated) ? result.accumulated.length : 0})`);
      return Array.isArray(result.accumulated) ? result.accumulated : [];
    }
    if (result?.error) console.warn(`[sheets-writer] writeRecentConnections failed: ${result.error}`);
    return null;
  } catch (err) {
    console.warn(`[sheets-writer] writeRecentConnections threw: ${err.message}`);
    return null;
  }
}

/**
 * Wipe the "Recent Connections" tab clean (keeps the header row). Called once
 * at campaign start so the tab is a fresh per-campaign record. Best-effort —
 * returns false on any failure; a stale tab is non-fatal (active-sender
 * scoping still prevents foreign-account false positives).
 */
export async function clearRecentConnectionsTab(sheetUrl) {
  if (!getWebAppUrl()) return false;
  const sheetId = extractSheetId(sheetUrl);
  try {
    const result = await postToWebApp({ action: 'clearRecentConnections', sheetId });
    if (result?.ok) {
      console.log('[sheets-writer] ✓ Cleared "Recent Connections" tab');
      return true;
    }
    if (result?.error) console.warn(`[sheets-writer] clearRecentConnections failed: ${result.error}`);
    return false;
  } catch (err) {
    console.warn(`[sheets-writer] clearRecentConnections threw: ${err.message}`);
    return false;
  }
}

export async function batchUpdateSheet(sheetUrl, updates) {
  if (!getWebAppUrl() || !updates.length) return false;

  const sheetId = extractSheetId(sheetUrl);
  const gid = extractSheetGid(sheetUrl);

  const result = await postToWebApp({
    action: 'batchUpdate',
    sheetId,
    gid: gid || '',
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
