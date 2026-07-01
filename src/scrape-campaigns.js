// Persisted registry of Sales Nav scrape "campaigns" — a named, owned group of
// engine jobs (one per search URL). The GKE engine owns job scheduling; this
// store only remembers name/owner/destination/profile IDs so the board can
// group the engine's jobs into strips and gate toggles by owner.
import fs from 'fs/promises';
import { dataPath } from './paths.js';

let FILE = dataPath('scrape-campaigns.json');
let cache = null;

export function __setFileForTests(p) { FILE = p; cache = null; }

async function load() {
  if (cache !== null) return cache;
  try {
    const parsed = JSON.parse(await fs.readFile(FILE, 'utf8'));
    cache = Array.isArray(parsed) ? parsed : [];
  } catch { cache = []; }
  return cache;
}

async function persist() {
  if (cache === null) await load();
  const tmp = FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(cache, null, 2));
  await fs.rename(tmp, FILE);
}

export async function addScrapeCampaign({ name, owner, sheetUrl, tabName, profileIds, searchUrls }) {
  await load();
  const rec = {
    id: 'sc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    name: name || '',
    owner: owner || null,
    sheetUrl: sheetUrl || '',
    tabName: tabName || 'Results',
    profileIds: Array.isArray(profileIds) ? profileIds.filter(Boolean) : [],
    searchUrls: Array.isArray(searchUrls) ? searchUrls.filter(Boolean) : [],
    enabled: true,
    createdAt: Date.now(),
  };
  cache.push(rec);
  await persist();
  return rec;
}

export async function listScrapeCampaigns() { return [...(await load())]; }

export async function getScrapeCampaign(id) {
  return (await load()).find((r) => r.id === id) || null;
}

const ALLOWED_PATCH_KEYS = new Set(['name', 'profileIds', 'enabled']);
export async function updateScrapeCampaign(id, patch) {
  await load();
  const rec = cache.find((r) => r.id === id);
  if (!rec) return null;
  for (const k of Object.keys(patch || {})) {
    if (ALLOWED_PATCH_KEYS.has(k)) rec[k] = patch[k];
  }
  await persist();
  return rec;
}
