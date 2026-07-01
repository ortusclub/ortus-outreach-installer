// Durable per-campaign scrape logs. Engine logs are live-only + operator-scoped;
// we persist a campaign's own stream (dispatch/progress/done + toggle actions)
// so the board's Logs tab has content for queued/done campaigns too.
import fs from 'fs/promises';
import path from 'path';
import { dataPath } from './paths.js';

let DIR = dataPath('scrape-logs');

export function __setDirForTests(d) { DIR = d; }

function fileFor(campaignId) {
  // campaignId is our own 'sc_...' id — safe, but strip separators defensively.
  const safe = String(campaignId).replace(/[^a-zA-Z0-9_-]/g, '');
  return path.join(DIR, safe + '.ndjson');
}

export async function appendScrapeLog(campaignId, { ts, message }) {
  await fs.mkdir(DIR, { recursive: true });
  const line = JSON.stringify({ ts: ts || Date.now(), message: String(message || '') }) + '\n';
  await fs.appendFile(fileFor(campaignId), line);
}

export async function appendAction(campaignId, { actor, admin, action }) {
  const who = admin ? `${actor} (admin)` : actor;
  await appendScrapeLog(campaignId, { ts: Date.now(), message: `${action} by ${who}` });
}

export async function readScrapeLog(campaignId, { limit = 300 } = {}) {
  let text;
  try { text = await fs.readFile(fileFor(campaignId), 'utf8'); }
  catch { return []; }
  const lines = text.split('\n').filter(Boolean);
  const tail = lines.slice(-limit);
  const out = [];
  for (const l of tail) { try { out.push(JSON.parse(l)); } catch { /* skip */ } }
  return out;
}
