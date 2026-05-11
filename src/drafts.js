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

async function load() {
  if (cache !== null) return cache;
  try {
    const text = await fs.readFile(DRAFTS_FILE, 'utf8');
    const parsed = JSON.parse(text);
    cache = Array.isArray(parsed) ? parsed : [];
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
  return cache.find((d) => d.id === id) || null;
}

export async function addDraft({ name = '', config = null } = {}) {
  await load();
  const entry = {
    id: 'd_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    name: String(name || '').trim(),
    createdAt: Date.now(),
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
  if (patch && typeof patch.name === 'string') cache[idx].name = patch.name.trim();
  if (patch && patch.config !== undefined) cache[idx].config = patch.config;
  cache[idx].updatedAt = Date.now();
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
