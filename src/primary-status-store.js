// Persistent per-account connection-to-primary status.
// Key: `${profileId}|${primaryKey}`. primaryKey is derived from the configured
// primary URL (vanity slug, else encoded member token). A true numeric member#
// needs a live page read, so cross-URL-form identity is best-effort here — the
// same person entered once as a slug and once as an encoded URL keys differently.
// Status is remembered PER PRIMARY: "A is connected to X", not "A is connected".

export function primaryKeyFromUrl(url) {
  const s = String(url || '');
  const slug = s.match(/\/in\/([^/?#]+)/i);
  if (slug && !/^AC[ow]AA/i.test(slug[1])) return 's:' + slug[1].toLowerCase();
  const tok = s.match(/(AC[ow]AA[A-Za-z0-9_-]+)/);
  if (tok) return 'm:' + tok[1];
  return '';
}

export function storeKey(profileId, primaryKey) {
  return `${profileId}|${primaryKey}`;
}

export function getEntry(store, profileId, primaryKey) {
  if (!store || !primaryKey) return null;
  return store[storeKey(profileId, primaryKey)] || null;
}

export function shouldRecheck(entry) {
  return !(entry && entry.state === 'connected');
}

// liveState is one of 'connected' | 'pending' | 'unverified' (from primaryConnState).
// connected is sticky; a non-definitive 'unverified' never demotes or re-stamps.
export function mergeLiveRead(prev, liveState, nowIso, primaryUrl) {
  if (prev && prev.state === 'connected') return prev; // sticky
  if (liveState === 'unverified') {
    return prev || { state: 'unverified', degree: 'unknown', verifiedAt: null, primaryUrl: primaryUrl || '' };
  }
  return {
    state: liveState, // 'connected' | 'pending'
    degree: liveState === 'connected' ? '1st' : '2nd/3rd',
    verifiedAt: nowIso,
    primaryUrl: primaryUrl || (prev && prev.primaryUrl) || '',
  };
}

// What to SHOW: the live read wins, except a rate-limited 'unverified' on an
// account the store knows is connected → show connected (the false-flag fix).
export function resolveDisplayState(entry, liveState) {
  if (liveState === 'unverified' && entry && entry.state === 'connected') {
    return { state: 'connected', source: 'remembered' };
  }
  return { state: liveState, source: 'live' };
}

export function seedConnectedIds(store, primaryKey) {
  if (!store || !primaryKey) return [];
  const suffix = '|' + primaryKey;
  return Object.keys(store)
    .filter((k) => k.endsWith(suffix) && store[k] && store[k].state === 'connected')
    .map((k) => k.slice(0, -suffix.length));
}

import { readFile as _readFile, writeFile as _writeFile, rename as _rename } from 'node:fs/promises';

// Read-or-empty: a missing or corrupt store must never block a campaign.
export async function loadPrimaryStatus(file) {
  try { return JSON.parse(await _readFile(file, 'utf8')); }
  catch { return {}; }
}

// Atomic write: tmp + rename, so a crash mid-write can't corrupt the store.
export async function savePrimaryStatus(file, map) {
  try {
    const tmp = file + '.tmp';
    await _writeFile(tmp, JSON.stringify(map, null, 2));
    await _rename(tmp, file);
  } catch (err) {
    console.warn(`[primary-status] store write failed: ${err.message}`);
  }
}
