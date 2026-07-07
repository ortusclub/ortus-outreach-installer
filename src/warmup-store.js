// ⑫ Account warm-up mode — per-machine persistence (data/warmup.json).
// Map of GoLogin profileId → { enabled, startedAt }. Schedule math lives in
// src/warmup.js; this file only reads/writes state. Atomic .tmp+rename writes
// follow the src/blocklist.js pattern.
import fs from 'node:fs';
import path from 'node:path';
import { dataPath } from './paths.js';

export const WARMUP_FILE = dataPath('warmup.json');

export function readWarmup() {
  try {
    const parsed = JSON.parse(fs.readFileSync(WARMUP_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeWarmup(map) {
  fs.mkdirSync(path.dirname(WARMUP_FILE), { recursive: true });
  const tmp = WARMUP_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(map, null, 2));
  fs.renameSync(tmp, WARMUP_FILE);
}

// Enable/disable warm-up for one profile. Enabling sets startedAt — but an
// existing startedAt is preserved, so an accidental off/on toggle doesn't
// reset a half-done ramp back to week 1. Disabling keeps startedAt around
// for the same reason.
export function setWarmup(profileId, enabled) {
  const id = String(profileId || '').trim();
  if (!id) throw new Error('warmup: profileId required');
  const map = readWarmup();
  const prev = map[id] || {};
  const entry = {
    enabled: Boolean(enabled),
    startedAt: prev.startedAt || (enabled ? new Date().toISOString() : null),
  };
  map[id] = entry;
  writeWarmup(map);
  return entry;
}
