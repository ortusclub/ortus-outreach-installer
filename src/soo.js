/**
 * Shared helper for fetching State of Operations data from the Apps Script
 * web app. Used by both the /api/soo-status endpoint and the signup allowlist
 * path in auth.js so they share timeout, error-shape, and redirect handling.
 *
 * Throws errors with `.code` set to one of:
 *   NOT_CONFIGURED · TIMEOUT · NETWORK · UPSTREAM
 * so callers can branch on the kind of failure without parsing messages.
 */

import { SHEETS_WEBAPP_URL } from './sheets-webapp-url.js';

export const SOO_TIMEOUT_MS = 10_000;

function makeError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

export async function fetchSoOData() {
  const sooSheetId = process.env.SOO_SHEET_ID;
  const sooGid = process.env.SOO_SHEET_GID;
  // v2.52.0: webapp URL is hard-coded in sheets-webapp-url.js, .env value ignored.
  const webappUrl = SHEETS_WEBAPP_URL;

  if (!sooSheetId) throw makeError('SOO_SHEET_ID not configured', 'NOT_CONFIGURED');

  const payload = JSON.stringify({
    sheetId: sooSheetId,
    action: 'getSoO',
    sooSheetId,
    sooGid: sooGid || '',
  });

  let data;
  try {
    const signal = AbortSignal.timeout(SOO_TIMEOUT_MS);

    // Apps Script returns 302 on POST; node fetch would downgrade the redirect
    // to GET (HTTP spec). Handle manually — stop on redirect, re-fetch Location.
    const initial = await fetch(webappUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      redirect: 'manual',
      signal,
    });

    const response = (initial.status >= 300 && initial.status < 400)
      ? await fetch(initial.headers.get('location'), { signal })
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
