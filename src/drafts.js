/**
 * Multi-draft store. Each draft is a name (and later, a full wizard config
 * snapshot) the operator is staging without launching. Persisted to disk so
 * the dashboard's Drafts section survives restarts.
 *
 * Migration: on first load, if `data/drafts.json` is missing but the legacy
 * `data/draft-name.json` carries a non-empty name, seed the new store with
 * that single entry so the operator's existing in-progress draft isn't lost.
 */

import fs from 'fs/promises';
import { dataPath } from './paths.js';

const DRAFTS_FILE = dataPath('drafts.json');
const LEGACY_DRAFT_NAME_FILE = dataPath('draft-name.json');

let cache = null;

// 2026-05-27 (drafts-isolation): every persisted draft must expose a
// `lastEditedAt` ISO string so the wizard can sort/pick the most-recent one
// for the dashboard's Resume pill. Existing rows on disk may lack it — we
// backfill on read using updatedAt → createdAt → now, and persist the
// inferred value on the next write.
function _nowIso() { return new Date().toISOString(); }
function _backfillLastEditedAt(d) {
  if (d && !d.lastEditedAt) {
    if (d.updatedAt) d.lastEditedAt = new Date(d.updatedAt).toISOString();
    else if (d.createdAt) d.lastEditedAt = new Date(d.createdAt).toISOString();
    else d.lastEditedAt = _nowIso();
  }
  return d;
}

async function load() {
  if (cache !== null) return cache;
  try {
    const text = await fs.readFile(DRAFTS_FILE, 'utf8');
    const parsed = JSON.parse(text);
    cache = Array.isArray(parsed) ? parsed : [];
    cache.forEach(_backfillLastEditedAt);
  } catch {
    // Migrate legacy single-draft if present.
    cache = [];
    try {
      const legacyText = await fs.readFile(LEGACY_DRAFT_NAME_FILE, 'utf8');
      const legacyParsed = JSON.parse(legacyText);
      const legacyName = (legacyParsed && legacyParsed.name) ? String(legacyParsed.name).trim() : '';
      if (legacyName) {
        cache.push({
          id: 'd_' + Date.now() + '_legacy',
          name: legacyName,
          createdAt: Date.now(),
          lastEditedAt: _nowIso(),
        });
        await persist();
      }
    } catch { /* no legacy draft, that's fine */ }
  }
  return cache;
}

async function persist() {
  if (cache === null) await load();
  const tmp = DRAFTS_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(cache, null, 2));
  await fs.rename(tmp, DRAFTS_FILE);
}

export async function getDrafts() {
  return [...(await load())];
}

export async function getDraft(id) {
  await load();
  const d = cache.find((d) => d.id === id) || null;
  return d ? _backfillLastEditedAt(d) : null;
}

// Returns the draft with the latest lastEditedAt (ISO string compare works
// because all timestamps are ISO-8601 in UTC). null when no drafts exist.
// Used by the dashboard "Resume draft" pill on app boot.
export async function getMostRecentDraft() {
  await load();
  if (!cache.length) return null;
  let best = null;
  for (const d of cache) {
    _backfillLastEditedAt(d);
    if (!best || String(d.lastEditedAt) > String(best.lastEditedAt)) best = d;
  }
  return best || null;
}

// v2.59: name uniqueness enforcement. Drops every other draft with the
// same (trimmed, case-insensitive) non-empty name except for `exceptId`.
// Empty names are never deduped (those are placeholder drafts the
// operator hasn't named yet — collapsing them all into one would be a
// surprise). Returns the number of entries removed for logging.
function _dedupByName(name, exceptId) {
  const norm = String(name || '').trim().toLowerCase();
  if (!norm) return 0;
  const before = cache.length;
  cache = cache.filter((d) => {
    if (d.id === exceptId) return true;
    return String(d.name || '').trim().toLowerCase() !== norm;
  });
  return before - cache.length;
}

export async function addDraft({ name = '', config = null } = {}) {
  await load();
  const trimmed = String(name || '').trim();
  // Silently merge over any existing draft with the same name (operator
  // request — no two campaigns can have the same name). For named saves
  // only; empty-name drafts coexist.
  if (trimmed) _dedupByName(trimmed, null);
  const entry = {
    id: 'd_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    name: trimmed,
    createdAt: Date.now(),
    lastEditedAt: _nowIso(),
    config: config || null,
  };
  cache.push(entry);
  await persist();
  return entry;
}

export async function updateDraft(id, patch) {
  await load();
  const idx = cache.findIndex((d) => d.id === id);
  if (idx === -1) return null;
  if (patch && typeof patch.name === 'string') {
    const trimmed = patch.name.trim();
    cache[idx].name = trimmed;
    // Dedup any other draft that now collides with this one's new name.
    if (trimmed) _dedupByName(trimmed, id);
  }
  if (patch && patch.config !== undefined) cache[idx].config = patch.config;
  cache[idx].updatedAt = Date.now();
  cache[idx].lastEditedAt = _nowIso();
  await persist();
  return cache[idx];
}

export async function removeDraft(id) {
  await load();
  const idx = cache.findIndex((d) => d.id === id);
  if (idx === -1) return false;
  cache.splice(idx, 1);
  await persist();
  return true;
}
