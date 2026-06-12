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
// CC (connection) credit. open_profile_only / inmail_only are intentionally not
// here.
const CONNECT_MODES = new Set([
  'connect_only',
  'connect_and_introduce',
  'connect_and_message',
]);

/**
 * Pure mapping. Given the campaign mode and the send result's action, return
 * the SoO credit column to flip + its paired User column, or null for "no
 * write". Keyed on the action (what was actually sent) AND gated by mode so
 * open_profile_only writes nothing — including its InMail fallback (OP deferred).
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
