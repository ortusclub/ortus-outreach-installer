/**
 * Writes account status back to the State of Operations (SoO) "LinkedIn
 * Accounts" board. Companion to src/soo.js (which only READS the SoO).
 *
 * Two one-way, best-effort writes (see the 2026-06-12 spec):
 *   - flipAccountInUse():        credit cell Available -> In Use + operator email
 *   - markAccountNeedsLoginSoO(): the account's "Needs Login" cell -> 'Y'
 *
 * Every export is best-effort and NEVER throws to the caller. A failure (kill
 * switch off, no email, network error, 503, no matching row) resolves to a
 * result object — outreach must never depend on it.
 */
import { SHEETS_WEBAPP_URL, SOO_SHEET_ID, SOO_SHEET_GID } from './sheets-webapp-url.js';

const SOO_WRITE_TIMEOUT_MS = 10_000;

// The connection-request modes. A 'connection_sent' in any of these consumes a
// CC (connection) credit. open_profile_only is intentionally not here (it never
// writes to the SoO). inmail_only is also not here — it has its own branch below.
const CONNECT_MODES = new Set([
  'connect_only',
  'connect_and_introduce',
  'connect_and_message',
]);

/**
 * Pure mapping. Given the campaign mode and the send result's action, return
 * the SoO credit column to flip + its paired User column, or null for "no
 * write". Keyed on the action (what was actually sent) AND gated by mode so
 * open_profile_only writes nothing — even if it falls back to InMail (OP mode is excluded from this map entirely).
 * @returns {{creditHeader: string, userHeader: string}|null}
 */
export function resolveSoOTarget(mode, action) {
  if (action === 'connection_sent' && CONNECT_MODES.has(mode)) {
    return { creditHeader: 'CC (Credits)', userHeader: 'CC User' };
  }
  if (action === 'inmail_sent' && mode === 'inmail_only') {
    return { creditHeader: 'Inmail Credits', userHeader: 'Inmail User' };
  }
  return null;
}

/** Kill-switch: enabled unless ORTUS_SOO_WRITEBACK is off/0/false. Default on. */
export function sooWritebackEnabled() {
  const v = (process.env.ORTUS_SOO_WRITEBACK || '').toString().trim().toLowerCase();
  return !(v === 'off' || v === '0' || v === 'false');
}

/** Build the setSoO payload for an "In Use" flip (credit + paired user, guarded). */
export function buildFlipPayload({ email, creditHeader, userHeader, operatorEmail }) {
  const fields = { [creditHeader]: 'In Use' };
  if (operatorEmail) fields[userHeader] = operatorEmail;
  return {
    sheetId: SOO_SHEET_ID,   // satisfies the Apps Script router's required field
    gid: SOO_SHEET_GID,      // router resolves the LinkedIn Accounts tab by gid
    action: 'setSoO',
    email,
    fields,
    guardAvailableFor: [creditHeader],
  };
}

/** Build the setSoO payload for a Needs Login flag (no guard). */
export function buildNeedsLoginPayload({ email }) {
  return {
    sheetId: SOO_SHEET_ID,
    gid: SOO_SHEET_GID,
    action: 'setSoO',
    email,
    fields: { 'Needs Login': 'Y' },
    guardAvailableFor: [],
  };
}

// POST a setSoO payload to the central Apps Script. Mirrors src/soo.js: Apps
// Script answers POST with a 302 that node fetch would downgrade to GET, so we
// stop on the redirect and re-fetch the Location.
async function postSetSoO(payload) {
  const signal = AbortSignal.timeout(SOO_WRITE_TIMEOUT_MS);
  const initial = await fetch(SHEETS_WEBAPP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    redirect: 'manual',
    signal,
  });
  const response = (initial.status >= 300 && initial.status < 400)
    ? await fetch(initial.headers.get('location'), { signal })
    : initial;
  return response.json();
}

/**
 * Flip an account's credit cell to "In Use" (server-side guarded to Available)
 * and stamp the operator email into the paired User cell. Best-effort.
 * @returns {Promise<object>} { ok, matched, written, skipped } or { ok:false, ... }
 */
export async function flipAccountInUse({ email, creditHeader, userHeader, operatorEmail }) {
  if (!sooWritebackEnabled()) return { ok: false, disabled: true };
  if (!email) return { ok: false, error: 'no email' };
  try {
    const data = await postSetSoO(buildFlipPayload({ email, creditHeader, userHeader, operatorEmail }));
    if (data && data.error) return { ok: false, error: data.error };
    return { ok: true, ...data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Set the account's "Needs Login" SoO cell to 'Y'. Best-effort. Never cleared
 * by the app (manual clear by the LinkedIn team).
 * @returns {Promise<object>} { ok, matched, written } or { ok:false, ... }
 */
export async function markAccountNeedsLoginSoO({ email }) {
  if (!sooWritebackEnabled()) return { ok: false, disabled: true };
  if (!email) return { ok: false, error: 'no email' };
  try {
    const data = await postSetSoO(buildNeedsLoginPayload({ email }));
    if (data && data.error) return { ok: false, error: data.error };
    return { ok: true, ...data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
