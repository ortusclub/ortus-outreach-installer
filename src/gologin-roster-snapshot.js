import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export const PICKER_ROSTER_FRESH_MS = 60 * 60 * 1000;
export const PICKER_ROSTER_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function snapshotPath(root, accountId) {
  if (!/^[a-z0-9_-]{1,40}$/.test(accountId)) throw new Error('Invalid GoLogin workspace id');
  return join(root, `gologin-roster-${accountId}.json`);
}

function tokenFingerprint(token) {
  return createHash('sha256').update(String(token || '')).digest('hex');
}

// Store names and IDs only. No API token, GoLogin notes, cookies, or browser data.
export function saveRosterSnapshot(root, accountId, token, profiles, fetchedAt = Date.now()) {
  if (!token || !Array.isArray(profiles) || profiles.length < 1 || profiles.length > 5000) return false;
  if (!profiles.every(p => typeof p.id === 'string' && p.id && typeof p.name === 'string' &&
      typeof p.account === 'string' && /^[a-z0-9_-]{1,40}$/.test(p.account))) return false;
  const file = snapshotPath(root, accountId);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const payload = {
    version: 1, accountId, tokenFingerprint: tokenFingerprint(token), fetchedAt,
    profiles: profiles.map(p => ({ id: p.id, name: p.name, account: p.account })),
  };
  try {
    writeFileSync(temporary, JSON.stringify(payload), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, file);
    return true;
  } catch {
    try { unlinkSync(temporary); } catch {}
    return false;
  }
}

export function readRosterSnapshot(root, accountId, token, { now = Date.now(), maxAgeMs = PICKER_ROSTER_MAX_AGE_MS } = {}) {
  if (!token) return null;
  let snapshot;
  try { snapshot = JSON.parse(readFileSync(snapshotPath(root, accountId), 'utf8')); } catch { return null; }
  if (snapshot?.version !== 1 || snapshot.accountId !== accountId ||
      snapshot.tokenFingerprint !== tokenFingerprint(token) ||
      !Number.isFinite(snapshot.fetchedAt) || snapshot.fetchedAt > now ||
      now - snapshot.fetchedAt > maxAgeMs ||
      !Array.isArray(snapshot.profiles) || snapshot.profiles.length < 1 || snapshot.profiles.length > 5000 ||
      !snapshot.profiles.every(p => typeof p.id === 'string' && p.id && typeof p.name === 'string' &&
        typeof p.account === 'string' && /^[a-z0-9_-]{1,40}$/.test(p.account))) return null;
  return { fetchedAt: snapshot.fetchedAt, profiles: snapshot.profiles.map(p => ({ ...p, notes: '' })) };
}
