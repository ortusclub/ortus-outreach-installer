// Per-scrape config overrides, keyed by the board strip's (engine-derived) id.
//
// The Sales Nav Scraper board groups the engine's jobs into strips, so a strip's
// config normally lives only in its jobs — there's nowhere to persist an edit.
// This store lets an operator open a stopped/done scrape, change its config, and
// Save it; on re-open the saved config wins, so their edits stick. Local-only
// (same machine), atomic writes like the other data stores.
import fs from 'fs/promises';
import { dataPath } from './paths.js';

let FILE = dataPath('scrape-config-overrides.json');
let cache = null;

export function __setFileForTests(p) { FILE = p; cache = null; }

async function load() {
  if (cache !== null) return cache;
  try {
    const parsed = JSON.parse(await fs.readFile(FILE, 'utf8'));
    cache = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch { cache = {}; }
  return cache;
}

async function persist() {
  if (cache === null) await load();
  const tmp = FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(cache, null, 2));
  await fs.rename(tmp, FILE);
}

export async function getScrapeOverride(stripId) {
  if (!stripId) return null;
  return (await load())[stripId] || null;
}

export async function saveScrapeOverride(stripId, cfg = {}) {
  if (!stripId) return null;
  await load();
  cache[stripId] = {
    searchUrls: Array.isArray(cfg.searchUrls) ? cfg.searchUrls.filter(Boolean) : [],
    sheetUrl: String(cfg.sheetUrl || ''),
    tabName: String(cfg.tabName || 'Results'),
    name: String(cfg.name || ''),
    profileIds: Array.isArray(cfg.profileIds) ? cfg.profileIds.filter(Boolean) : [],
    savedAt: Date.now(),
  };
  await persist();
  return cache[stripId];
}
