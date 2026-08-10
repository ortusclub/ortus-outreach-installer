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

// A transient write error is a network/timeout/5xx-class failure that a retry
// can plausibly fix — as opposed to a permanent one (auth, row-not-found, bad
// request) where retrying just wastes time. The Apps Script write actions are
// idempotent (they set fixed cell values), so retrying a transient failure is
// safe — at worst it re-stamps the same value (and may add a duplicate Audit
// Log row, which is harmless).
const _TRANSIENT_WRITE_RE =
  /timeout|abort|ECONN|EAI_AGAIN|socket|network|fetch failed|terminated|\b(429|500|502|503|504)\b/i;

export function isTransientWriteError(msg) {
  return _TRANSIENT_WRITE_RE.test(String(msg || ''));
}

/**
 * Retry an idempotent write attempt across transient failures.
 *
 * `attemptFn(attempt)` returns the bridge result object. A result with no
 * `.error` (including `null`, meaning no webapp configured) is success and is
 * returned immediately. A result whose `.error` is permanent (auth, not-found)
 * is also returned immediately — retrying won't help. Only transient errors
 * are retried, up to `maxAttempts`, with linear backoff (baseDelayMs × attempt).
 * `sleep` is injectable so tests don't actually wait.
 */
export async function withWriteRetry(attemptFn, {
  maxAttempts = 3,
  baseDelayMs = 1000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = () => {},
} = {}) {
  let result;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    result = await attemptFn(attempt);
    if (!result || !result.error) return result;        // success (or no-op)
    if (!isTransientWriteError(result.error)) return result; // permanent — don't retry
    if (attempt < maxAttempts) {
      log(`transient write error (attempt ${attempt}/${maxAttempts}): ${result.error} — retrying`);
      await sleep(baseDelayMs * attempt);
    }
  }
  return result; // exhausted retries — return last (transient) error
}

// One POST attempt to the Apps Script web app. Returns the parsed result or
// an { error } object; never throws. Wrapped by postToWebApp's retry loop.
async function _postOnce(url, body) {
  try {
    // Apps Script returns 302 on POST. Node fetch converts POST→GET on
    // redirect, hitting doGet() instead of doPost(). Handle manually.
    // P-05 fix (2.8.18): 15s timeout on both legs of the redirect chain.
    // Without it, an Apps Script hang stalls the campaign loop indefinitely.
    const initial = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
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
    return { error: err.message };
  }
}

/**
 * POST to the Apps Script web app, retrying transient (timeout/network)
 * failures so a one-off Google-side latency spike doesn't permanently drop a
 * row's write (the bug behind "Kyra's row never got written").
 */
async function postToWebApp(payload) {
  const url = getWebAppUrl();
  if (!url) {
    console.log('[sheets-writer] No SHEETS_WEBAPP_URL configured — skipping');
    return null;
  }

  // v2.58.x: attach tz so GAS can stamp dateLastAction in the launcher's
  // local time. GAS uses `data.tz || Session.getScriptTimeZone()` so older
  // GAS deployments (pre-paste) silently ignore this field.
  const enriched = _operatorTz ? { ...payload, tz: _operatorTz } : payload;
  const body = JSON.stringify(enriched);

  const result = await withWriteRetry(() => _postOnce(url, body), {
    maxAttempts: 3,
    baseDelayMs: 1000,
    log: (m) => console.warn(`[sheets-writer] ${m}`),
  });

  if (result && result.error) {
    console.warn(`[sheets-writer] POST failed: ${result.error}`);
  }
  return result;
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

// One updateRows POST carries at most this many rows. The POST aborts at 15s
// (_postOnce) and the Apps Script rescans the URL column per row, so a single
// 700-row request would time out and lose the whole batch.
// ponytail: fixed size, no adaptive tuning — raise it if real batches finish fast.
const UPDATE_ROWS_CHUNK = 100;

/**
 * Batched sibling of updateSheetRow: stamps many rows through ONE Apps Script
 * call per chunk (`action:'updateRows'` → handleUpdateRows), instead of one
 * lock-holding POST per row. handleUpdateRows replies
 * `{ success, results:[ {ok:true,row,…} | {error} ] }` index-aligned with the
 * rows sent, so one missing lead never fails the rest of the batch.
 *
 * @param {string} sheetUrl - The Google Sheet URL (any sheet)
 * @param {Array<{linkedinUrl:string}>} rows - one entry per row: the URL plus its tracking fields
 * @param {string} linkedinColumn - name of the URL column ('' → auto-detect)
 * @returns {Promise<{ok:number, total:number, failures:Array<{linkedinUrl:string,error:string}>}>}
 *          `failures` keeps per-row visibility: which rows did not stamp, and why.
 */
export async function updateSheetRows(sheetUrl, rows, linkedinColumn) {
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && r.linkedinUrl);
  const failures = [];
  if (!list.length) return { ok: 0, total: 0, failures };

  if (!getWebAppUrl()) {
    console.log('[sheets-writer] No SHEETS_WEBAPP_URL configured — skipping');
    return { ok: 0, total: list.length, failures: list.map((r) => ({ linkedinUrl: r.linkedinUrl, error: 'no SHEETS_WEBAPP_URL configured' })) };
  }

  const sheetId = extractSheetId(sheetUrl);
  const gid = extractSheetGid(sheetUrl);
  let ok = 0;

  for (let i = 0; i < list.length; i += UPDATE_ROWS_CHUNK) {
    const chunk = list.slice(i, i + UPDATE_ROWS_CHUNK);
    const result = await postToWebApp({
      action: 'updateRows',
      sheetId,
      gid: gid || '',
      urlColumnName: linkedinColumn || '',
      rows: chunk,
    });
    const results = (result && Array.isArray(result.results)) ? result.results : null;
    if (!results) {
      // Whole-chunk failure (network, auth, no URL column) — every row in it is unstamped.
      const error = (result && result.error) || 'no results returned by the sheets bridge';
      console.warn(`[sheets-writer] updateRows failed for ${chunk.length} row(s): ${error}`);
      for (const r of chunk) failures.push({ linkedinUrl: r.linkedinUrl, error });
      continue;
    }
    chunk.forEach((r, j) => {
      const res = results[j];
      if (res && res.ok) ok += 1;
      else failures.push({ linkedinUrl: r.linkedinUrl, error: (res && res.error) || 'no result returned for this row' });
    });
  }

  console.log(`[sheets-writer] updateRows stamped ${ok}/${list.length} row(s) in sheet ${sheetId}`);
  return { ok, total: list.length, failures };
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

/**
 * v2.72: Dump inbound replies (1:1 threads only, last message only) into a
 * shared "Recent Messages" sidecar tab — the reply-check counterpart of
 * writeRecentConnectionsTab. Each call refreshes only THIS account's rows so
 * the latest last-message wins. `messages` items: { account, name,
 * lastMessage, receivedAt, matched }. Requires the Apps Script's
 * `writeRecentMessages` handler (redeploy needed). Best-effort.
 */
export async function writeRecentMessagesTab(sheetUrl, sender, messages, activeSenders) {
  if (!getWebAppUrl()) return null;
  const sheetId = extractSheetId(sheetUrl);
  try {
    const result = await postToWebApp({
      action: 'writeRecentMessages',
      sheetId,
      sender: sender || '',
      messages: messages || [],
      activeSenders: Array.isArray(activeSenders) ? activeSenders : [],
    });
    if (result?.ok) {
      console.log(`[sheets-writer] ✓ Wrote ${result.rows} row(s) to "${result.tab}"`);
      return true;
    }
    if (result?.error) console.warn(`[sheets-writer] writeRecentMessages failed: ${result.error}`);
    return null;
  } catch (err) {
    console.warn(`[sheets-writer] writeRecentMessages threw: ${err.message}`);
    return null;
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
