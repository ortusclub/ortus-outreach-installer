/**
 * Cloud launch-config store.
 *
 * The GKE engine only reports a cloud campaign's status/counts — not the full
 * wizard config (templates, delays, sender columns). To let the app DUPLICATE a
 * cloud campaign (open + New campaign pre-filled), we snapshot the exact config
 * the operator dispatched, keyed by the engine's campaign id.
 *
 * Persisted to disk (survives restarts). Capped so it can't grow unbounded.
 */

import fs from 'fs/promises';
import { dataPath } from './paths.js';

const FILE = dataPath('cloud-launch-configs.json');
const MAX_ENTRIES = 200;

let cache = null;

async function load() {
  if (cache !== null) return cache;
  try {
    const parsed = JSON.parse(await fs.readFile(FILE, 'utf8'));
    cache = parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    cache = {};
  }
  return cache;
}

async function persist() {
  if (cache === null) await load();
  const tmp = FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(cache, null, 2));
  await fs.rename(tmp, FILE);
}

export async function saveCloudLaunchConfig(id, name, config) {
  if (!id || !config) return;
  await load();
  cache[id] = { name: name || '', config, ts: Date.now() };
  // Trim oldest if over the cap.
  const ids = Object.keys(cache);
  if (ids.length > MAX_ENTRIES) {
    ids.sort((a, b) => (cache[a].ts || 0) - (cache[b].ts || 0));
    for (const old of ids.slice(0, ids.length - MAX_ENTRIES)) delete cache[old];
  }
  await persist();
}

export async function getCloudLaunchConfig(id) {
  if (!id) return null;
  await load();
  return cache[id] || null;
}
