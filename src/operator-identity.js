/**
 * Per-machine operator email — who is actually running THIS install.
 *
 * Every operator's app logs in with the SAME shared dashboard credential
 * (DASHBOARD_USERS), so the login email can't identify the person at the
 * keyboard — it's antonio@ortusclub.com for everyone. This module holds an
 * explicit, per-install email the operator sets once; it's the authoritative
 * source for "who reserved this account" written into the SoO 'CC User App'
 * column. Persisted to the per-user data dir (like operator-id.js), so it's
 * stable across restarts and distinct per machine.
 *
 * Read synchronously + cached so the campaign stamp path stays sync-friendly.
 */
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dataPath } from './paths.js';

const EMAIL_FILE = dataPath('operator-identity.json');

let cached = null; // null = not loaded yet; '' = loaded-but-unset

/** Loose email shape check — we only block obvious garbage, not valid edge cases. */
export function isPlausibleEmail(value) {
  const s = String(value || '').trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

/** The operator email for this install, or '' if never set. Cached after first read. */
export function getOperatorEmail() {
  if (cached !== null) return cached;
  try {
    const parsed = JSON.parse(readFileSync(EMAIL_FILE, 'utf8'));
    cached = (parsed && typeof parsed.email === 'string') ? parsed.email.trim() : '';
  } catch {
    cached = ''; // not created yet
  }
  return cached;
}

/**
 * Persist the operator email (atomic write). Returns the stored value.
 * Throws on an implausible email so the API can surface a 400.
 */
export function setOperatorEmail(email) {
  const clean = String(email || '').trim();
  if (clean && !isPlausibleEmail(clean)) throw new Error('invalid email');
  const tmp = `${EMAIL_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify({ email: clean }, null, 2));
  renameSync(tmp, EMAIL_FILE);
  cached = clean;
  return clean;
}

/** Test-only: drop the in-memory cache so a fresh read hits disk. */
export function _resetOperatorEmailCache() { cached = null; }
