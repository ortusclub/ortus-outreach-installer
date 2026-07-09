/**
 * Replies log — persistent record of inbound LinkedIn replies found by the
 * automatic hourly reply-check (post-campaign-reply-check.js) and the manual
 * Check DMs flow. Powers the in-app "Replies" panel so the operator can see,
 * at a glance, who replied, which account to log into, and the message text.
 *
 * The Google Sheet remains the source of truth (Reply / ReplyAt / ReplyPreview
 * columns + the Replies tab). This log is a convenience mirror for the UI and
 * for de-duplicating notifications across hourly sweeps.
 *
 * Persistent state: data/replies-log.json (newest appended last, capped).
 */

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { dataPath } from './paths.js';

const FILE = dataPath('replies-log.json');
const MAX = 500;

// Stable content-derived key so the same reply found on consecutive hourly
// sweeps is recorded (and notified) only once. Mirrors the bridge's dedup
// philosophy in check-dms.js.
export function replyKey(r) {
  return [
    r.profileId || r.profileName || '',
    (r.linkedinUrl || '').toLowerCase(),
    String(r.text || '').slice(0, 80),
  ].join('|');
}

/**
 * Pure helper (unit-tested): given the existing log and a batch of incoming
 * replies, return only the genuinely new ones (not already present by key).
 * Does no I/O.
 */
export function dedupeReplies(existing, incoming) {
  const seen = new Set((existing || []).map(replyKey));
  const fresh = [];
  for (const r of (incoming || [])) {
    const k = replyKey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    fresh.push(r);
  }
  return fresh;
}

export async function readRepliesLog() {
  try { return JSON.parse(await readFile(FILE, 'utf8')); }
  catch { return []; }
}

async function write(log) {
  // Atomic .tmp + rename (blocklist.js pattern) so a crash mid-write can't
  // truncate the inbox.
  try {
    await mkdir(dirname(FILE), { recursive: true });
    const tmp = FILE + '.tmp';
    await writeFile(tmp, JSON.stringify(log, null, 2));
    await rename(tmp, FILE);
  }
  catch (err) { console.warn(`[replies-log] write failed: ${err.message}`); }
}

/**
 * Append a batch of replies, skipping any already recorded. Returns the rows
 * that were actually added (newest-first) so callers can notify only on those.
 */
export async function appendReplies(entries, nowMs = Date.now()) {
  if (!Array.isArray(entries) || entries.length === 0) return [];
  const log = await readRepliesLog();
  const fresh = dedupeReplies(log, entries).map((e) => ({
    profileId: e.profileId || '',
    profileName: e.profileName || '',
    linkedinUrl: e.linkedinUrl || '',
    leadName: e.leadName || '',
    text: String(e.text || ''),
    // v2.135+ (replies inbox): which campaign this reply belongs to, when the
    // capturing sweep knows it. Display-only context for the inbox subline.
    campaign: e.campaign || '',
    repliedAt: e.repliedAt || null,
    // v2.72: true when the name matched >1 lead (same-name) — surfaced as a
    // "suspected reply" the operator should verify manually.
    suspected: !!e.suspected,
    recordedAt: e.recordedAt || nowMs,
    seen: false,
  }));
  if (fresh.length === 0) return [];
  log.push(...fresh);
  while (log.length > MAX) log.shift();
  await write(log);
  return fresh.slice().reverse();
}

/** Newest-first slice for the dashboard panel. */
export async function listReplies({ limit = 100 } = {}) {
  const log = await readRepliesLog();
  return log.slice(-limit).reverse();
}

/** Count of replies the operator hasn't acknowledged yet (for the badge). */
export async function unseenCount() {
  const log = await readRepliesLog();
  return log.reduce((n, r) => n + (r.seen ? 0 : 1), 0);
}

/** Mark every recorded reply as seen (called when the operator opens the panel). */
export async function markAllSeen() {
  const log = await readRepliesLog();
  let changed = false;
  for (const r of log) { if (!r.seen) { r.seen = true; changed = true; } }
  if (changed) await write(log);
  return log.length;
}

/**
 * Replies-inbox: store a manual label correction on one reply, addressed by
 * its stable content key (replyKey). A manual label always wins over the
 * heuristic auto-label computed at read time. Returns true if a row matched.
 */
export async function setReplyLabel(key, label) {
  const log = await readRepliesLog();
  let changed = false;
  for (const r of log) {
    if (replyKey(r) === key) { r.label = label; changed = true; }
  }
  if (changed) await write(log);
  return changed;
}
