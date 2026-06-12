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
