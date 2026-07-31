/**
 * Shared helper for fetching State of Operations data from the Apps Script
 * web app. Used by both the /api/soo-status endpoint and the signup allowlist
 * path in auth.js so they share timeout, error-shape, and redirect handling.
 *
 * Throws errors with `.code` set to one of:
 *   NOT_CONFIGURED · TIMEOUT · NETWORK · UPSTREAM
 * so callers can branch on the kind of failure without parsing messages.
 */

import { SHEETS_WEBAPP_URL, SOO_SHEET_ID, SOO_SHEET_GID } from './sheets-webapp-url.js';

// Measured against the live sheet 2026-07-31 (1011 rows, ~1.0 MB): the happy
// path is 3-5s, but successful fetches were seen at 12.6s and slow failures at
// 15-20s. The old 10s budget therefore killed responses that were merely slow —
// and it was ONE signal shared across both hops (the POST and the redirect
// follow), so a slow first hop ate the second hop's time. Now per-attempt.
export const SOO_TIMEOUT_MS = 25_000;

// The Apps Script is shared by every operator (one central deployment), so
// contention is normal and some failures return an ERROR BODY rather than
// hanging — no timeout can help those, only trying again. Observed 2 failures
// in 5, and separately 4 in a row.
export const SOO_ATTEMPTS = 3;
const SOO_RETRY_BACKOFF_MS = [800, 2_000];

function makeError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch the SoO, retrying transient failures.
 *
 * When this throws, the launcher's sooData is EMPTY — every account renders
 * "no first name", the FREE/in-use states are wrong, and the Construction
 * filter can't run. That is why it retries rather than surfacing the first
 * failure: the operator's workaround was hammering Refresh until it worked.
 *
 * The typed `.code` survives the loop — callers branch on it.
 */
export async function fetchSoOData({ attempts = SOO_ATTEMPTS, sleep = _sleep } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fetchSoOOnce();
    } catch (err) {
      lastErr = err;
      if (attempt >= attempts) break;
      await sleep(SOO_RETRY_BACKOFF_MS[Math.min(attempt - 1, SOO_RETRY_BACKOFF_MS.length - 1)]);
    }
  }
  throw lastErr;
}

async function fetchSoOOnce() {
  // v2.52.0: SOO_SHEET_ID, SOO_SHEET_GID, and the webapp URL are all hard-coded
  // in sheets-webapp-url.js. Any matching .env values are ignored. Previously
  // operators had to ask Antonio for the SoO values, paste them into a local
  // .env, and re-paste on every update — which is why the SoO panel silently
  // failed for any operator who skipped that setup step.
  const sooSheetId = SOO_SHEET_ID;
  const sooGid = SOO_SHEET_GID;
  const webappUrl = SHEETS_WEBAPP_URL;

  const payload = JSON.stringify({
    sheetId: sooSheetId,
    action: 'getSoO',
    sooSheetId,
    sooGid: sooGid || '',
  });

  let data;
  try {
    // Apps Script returns 302 on POST; node fetch would downgrade the redirect
    // to GET (HTTP spec). Handle manually — stop on redirect, re-fetch Location.
    //
    // A FRESH signal per hop. Sharing one meant the redirect follow — the hop
    // that actually streams the ~1 MB body — inherited whatever was left after
    // the POST, so a slow handshake could leave it almost no time at all.
    const initial = await fetch(webappUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      redirect: 'manual',
      signal: AbortSignal.timeout(SOO_TIMEOUT_MS),
    });

    const response = (initial.status >= 300 && initial.status < 400)
      ? await fetch(initial.headers.get('location'), { signal: AbortSignal.timeout(SOO_TIMEOUT_MS) })
      : initial;

    data = await response.json();
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw makeError(`Apps Script timed out after ${SOO_TIMEOUT_MS / 1000}s`, 'TIMEOUT');
    }
    throw makeError(`Apps Script fetch failed: ${err.message}`, 'NETWORK');
  }

  if (data && data.error) {
    throw makeError(data.error, data.errorCode || 'UPSTREAM');
  }

  return data;
}
