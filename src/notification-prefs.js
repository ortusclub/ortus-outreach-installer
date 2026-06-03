/**
 * Per-operator notification preferences. Persistent JSON keyed by email.
 *
 * Default state ships with auto-send features OFF — operators opt in
 * explicitly via the sidebar Notifications panel.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dataPath } from './paths.js';

const PREFS_FILE = dataPath('notification-prefs.json');

const DEFAULTS = Object.freeze({
  connectionCheckReminders: false,
  // v2.72: desktop + email alerts when the hourly reply-check finds new
  // inbound replies. Off by default (operator opts in) per the auto-send rule.
  replyAlerts: false,
});

async function readAll() {
  try { return JSON.parse(await readFile(PREFS_FILE, 'utf8')); }
  catch { return {}; }
}

async function writeAll(data) {
  try { await writeFile(PREFS_FILE, JSON.stringify(data, null, 2)); }
  catch (err) { console.warn(`[notification-prefs] write failed: ${err.message}`); }
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
