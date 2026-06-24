// Incremental HubSpot cache for the in-app Connections search.
// Looks ingested connection slugs up in HubSpot and persists the contact data to
// data/connections-cache.json. INCREMENTAL: only slugs not already in the cache's
// `processedSlugs` set are looked up — so after a Drive sync adds a few networks,
// we query HubSpot for just the new slugs, not all 94k. Resumable via atomic
// checkpoint (tmp+rename) after every chunk.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ingestFolder } from './csv-ingest.js';
import { lookupBySlugs } from './hubspot-client.js';
import { normalizeSlug } from './slug.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '../..');
export const DEFAULT_DIR = path.join(REPO, 'data/connections');
export const DEFAULT_CACHE = path.join(REPO, 'data/connections-cache.json');

let _building = false;
export function isBuilding() { return _building; }

// Recover the set of already-looked-up slugs, handling three cases:
//  1. New schema: an explicit `processedSlugs` array.
//  2. Old schema, still complete + same slug set: every current slug is processed.
//  3. Old schema otherwise: derive from contacts (undercounts slugs with zero
//     HubSpot matches → those get re-looked-up once, which is correct, just not free).
function recoverProcessed(prev, allSlugs) {
  if (Array.isArray(prev.processedSlugs)) return new Set(prev.processedSlugs);
  if (prev.slugsProcessed === prev.totalSlugs && prev.totalSlugs === allSlugs.length) {
    return new Set(allSlugs);
  }
  const fromContacts = new Set();
  for (const c of prev.contacts || []) {
    const s = normalizeSlug(c.linkedinbio);
    if (s) fromContacts.add(s);
  }
  return fromContacts;
}

function loadCache(cachePath, allSlugs) {
  if (!fs.existsSync(cachePath)) return { contacts: [], processed: new Set() };
  try {
    const prev = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    return { contacts: prev.contacts || [], processed: recoverProcessed(prev, allSlugs) };
  } catch {
    return { contacts: [], processed: new Set() };
  }
}

// Build/refresh the cache. Returns { added, totalContacts, totalSlugs, lookedUp, networks }.
// onProgress({ processed, total, contacts }) fires after each chunk.
export async function buildCache({ dir = DEFAULT_DIR, cachePath = DEFAULT_CACHE, chunk = 5000, onProgress } = {}) {
  if (_building) throw new Error('cache build already in progress');
  if (!process.env.HUBSPOT_TOKEN) throw new Error('HUBSPOT_TOKEN not set — add it to .env');
  _building = true;
  try {
    const { index, stats } = ingestFolder(dir);
    const allSlugs = [...index.keys()].sort();
    const { contacts, processed } = loadCache(cachePath, allSlugs);
    const toLookup = allSlugs.filter((s) => !processed.has(s));

    const cache = {
      builtAt: new Date().toISOString(),
      totalSlugs: allSlugs.length,
      slugsProcessed: processed.size,
      contacts,
      processedSlugs: [...processed],
    };
    const save = () => {
      cache.builtAt = new Date().toISOString();
      cache.slugsProcessed = cache.processedSlugs.length;
      cache.totalSlugs = allSlugs.length;
      fs.writeFileSync(`${cachePath}.tmp`, JSON.stringify(cache));
      fs.renameSync(`${cachePath}.tmp`, cachePath); // atomic (CLAUDE.md convention)
    };

    let added = 0;
    if (toLookup.length === 0) {
      save(); // persist migration (e.g. add processedSlugs to an old-schema cache)
    } else {
      for (let i = 0; i < toLookup.length; i += chunk) {
        const batch = toLookup.slice(i, i + chunk);
        const found = await lookupBySlugs(batch, {});
        cache.contacts.push(...found);
        for (const s of batch) cache.processedSlugs.push(s);
        added += found.length;
        save();
        onProgress?.({ processed: cache.processedSlugs.length, total: allSlugs.length, contacts: cache.contacts.length });
      }
    }
    return {
      added,
      lookedUp: toLookup.length,
      totalContacts: cache.contacts.length,
      totalSlugs: allSlugs.length,
      networks: stats.files,
    };
  } finally {
    _building = false;
  }
}
