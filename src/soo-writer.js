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
    // Stamp the reserver into the unprotected fallback column 'CC App User'
    // (column AJ on the SoO board), NOT the protected 'CC User' (writes to the
    // protected column throw inside the Apps Script setSoO handler). The Apps
    // Script matches the column by header name, so this MUST equal the sheet
    // header EXACTLY — verified 2026-06-16 via a dry-run that printed
    // `column AJ (#36) header = "CC App User"`. An earlier guess of
    // 'CC User App' silently matched no column, so nothing was ever stamped.
    return { creditHeader: 'CC (Credits)', userHeader: 'CC App User' };
  }
  if (action === 'inmail_sent' && mode === 'inmail_only') {
    return { creditHeader: 'Inmail Credits', userHeader: 'Inmail User' };
  }
  // Message Campaign (open_profile_only): a genuine Open-Profile message uses the
  // Linkedin OP channel, so flip Linkedin (OP Credits) [AD] + stamp Linkedin OP
  // User [AE]. Reverses the earlier "OP writes nothing" stance per the operator
  // (2026-06-19): the credit column MUST reflect that the account was used. The
  // InMail fallback path (action 'inmail_sent' in OP mode) is left untouched.
  if (mode === 'open_profile_only' && (action === 'op_message_sent' || action === 'message_sent')) {
    return { creditHeader: 'Linkedin (OP Credits)', userHeader: 'Linkedin OP User' };
  }
  return null;
}

/** Kill-switch: enabled unless ORTUS_SOO_WRITEBACK is off/0/false. Default on. */
export function sooWritebackEnabled() {
  const v = (process.env.ORTUS_SOO_WRITEBACK || '').toString().trim().toLowerCase();
  return !(v === 'off' || v === '0' || v === 'false');
}

// Shared/admin logins that must NEVER be stamped as an individual reserver.
// The shared DASHBOARD_USERS credential (and the ADMIN_EMAILS notification
// addresses) collapse multiple operators onto one identity, so stamping it
// would label every reservation as Antonio — exactly what we must avoid.
const ALWAYS_BLOCKED_STAMP_EMAILS = ['ortus@ortusclub.com', 'antonio@ortusclub.com'];

/**
 * Build the lowercased set of emails that must not be stamped as a reserver:
 * the hardcoded admin/shared addresses + every login parsed out of the shared
 * DASHBOARD_USERS ("email:pass,email:pass") + the ADMIN_EMAILS list.
 */
export function blockedOperatorEmails(env = process.env) {
  const out = new Set(ALWAYS_BLOCKED_STAMP_EMAILS);
  String(env.DASHBOARD_USERS || '')
    .split(',')
    .map((pair) => pair.split(':')[0].trim().toLowerCase())
    .filter(Boolean)
    .forEach((e) => out.add(e));
  String(env.ADMIN_EMAILS || 'antonio@ortusclub.com')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
    .forEach((e) => out.add(e));
  return out;
}

/**
 * Normalize the operator email for stamping, dropping it (→ '') when blank or
 * when it's a shared/admin login. buildFlipPayload then omits the user cell, so
 * a shared login leaves the reserver blank rather than mislabelling it.
 * Preserves original case for the stamp; the block check is case-insensitive.
 */
export function resolveStampEmail(operatorEmail, blocked = blockedOperatorEmails()) {
  const trimmed = String(operatorEmail || '').trim();
  if (!trimmed) return '';
  if (blocked.has(trimmed.toLowerCase())) return '';
  return trimmed;
}

/**
 * Decide which email to stamp as the reserver. The per-machine operator email
 * (operator-identity.js) is AUTHORITATIVE and used verbatim — it's the explicit
 * "who is at this keyboard", so it's never blocked (an operator may legitimately
 * set antonio@ on Antonio's own machine). Only when it's unset do we fall back
 * to the login email, which still blank-stamps the shared/admin credential so a
 * shared login never mislabels every reservation as one person.
 */
export function resolveOperatorStamp({ perMachineEmail, loginEmail, blocked = blockedOperatorEmails() } = {}) {
  const pm = String(perMachineEmail || '').trim();
  if (pm) return pm;
  return resolveStampEmail(loginEmail, blocked);
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
  let response = initial;
  if (initial.status >= 300 && initial.status < 400) {
    const location = initial.headers.get('location');
    if (!location) throw new Error('redirect with no Location header');
    response = await fetch(location, { signal });
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
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
  if (!creditHeader || !userHeader) return { ok: false, error: 'no headers' };
  try {
    // operatorEmail is already resolved by the caller (resolveOperatorStamp):
    // the per-machine operator identity, or a blanked shared login. Stamp verbatim.
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
