/**
 * Per-operator preferences (timezone today, room for more later).
 * Persistent JSON keyed by email. Pattern mirrors notification-prefs.js.
 *
 * Default state ships with tz blank — operator confirms or overrides on
 * first login via the tz-confirm modal in the dashboard. When blank the
 * bot omits the `tz` field on sheet writes and Apps Script falls back
 * to Session.getScriptTimeZone() — i.e. behaviour is identical to
 * pre-feature operators until they confirm.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dataPath } from './paths.js';

const PREFS_FILE = dataPath('operator-prefs.json');

const DEFAULTS = Object.freeze({
  tz: '',
  // v2.113.x: pre-send identity safeguard. DEFAULT OFF (operator decision
  // 2026-06-22): the wrong-person send was a connect-BUTTON bug (now fixed in
  // sendConnectionRequest's top-card binding), never a mis-loaded URL — so the
  // pre-send name/member gate was friction, not protection. OFF = behave like
  // pre-gate v2.97 (connect straight to the sheet URL, no name/member matching,
  // no retry loop), keeping ONLY the 404 dead-profile skip. true = re-enable the
  // full verify gate. Per-operator + sticky; operators flip it from the sidebar.
  identityGate: false,
});

async function readAll() {
  try { return JSON.parse(await readFile(PREFS_FILE, 'utf8')); }
  catch { return {}; }
}

async function writeAll(data) {
  try { await writeFile(PREFS_FILE, JSON.stringify(data, null, 2)); }
  catch (err) { console.warn(`[operator-prefs] write failed: ${err.message}`); }
}

/**
 * The one place that turns the stored pref into the boolean BOTH runners use.
 *
 * It exists because they diverged: local read `prefs.identityGate === true`
 * (absent → OFF) while the cloud launch never sent the key at all, and the
 * engine reads `identityGateEnabled !== false` (absent → ON). So a sidebar
 * reading "Off" still gated every VM send. Never return undefined — that is
 * exactly the value the engine flips to ON.
 *
 * @param {object|null} prefs  a getPrefs() result, or null when there's no operator
 * @returns {boolean}
 */
export function identityGateEnabled(prefs) {
  return prefs ? prefs.identityGate === true : false;
}

export async function getPrefs(email) {
  if (!email) return { ...DEFAULTS };
  const all = await readAll();
  return { ...DEFAULTS, ...(all[email] || {}) };
}

export async function setPrefs(email, patch) {
  if (!email) return { ...DEFAULTS };
  const all = await readAll();
  const next = { ...DEFAULTS, ...(all[email] || {}), ...(patch || {}) };
  all[email] = next;
  await writeAll(all);
  return next;
}
