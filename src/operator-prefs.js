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
});

async function readAll() {
  try { return JSON.parse(await readFile(PREFS_FILE, 'utf8')); }
  catch { return {}; }
}

async function writeAll(data) {
  try { await writeFile(PREFS_FILE, JSON.stringify(data, null, 2)); }
  catch (err) { console.warn(`[operator-prefs] write failed: ${err.message}`); }
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
