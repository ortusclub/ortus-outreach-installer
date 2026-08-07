// Durable per-campaign scrape logs. Engine logs are live-only + operator-scoped;
// we persist a campaign's own stream (dispatch/control/progress/done + operator
// actions) so the board's Logs tab has content for queued/done campaigns too.
//
// Lines carry a `level` ('info' | 'ok' | 'warn' | 'err') so the strip can colour
// them the way the launch console already colours its own, instead of the
// renderer guessing severity from the message text.
import fs from 'fs/promises';
import path from 'path';
import { dataPath } from './paths.js';

let DIR = dataPath('scrape-logs');

// Append-only files with no rotation grow unbounded (the campaign log rotates;
// this one never did). Rotate by halving: cheap, keeps recent history, and the
// read side only ever wants the tail anyway.
const MAX_BYTES = 512 * 1024;

export function __setDirForTests(d) { DIR = d; }

function fileFor(campaignId) {
  // campaignId is a board id ('sc_...' local, 'eng_...' engine-derived) — safe,
  // but strip separators defensively.
  const safe = String(campaignId).replace(/[^a-zA-Z0-9_-]/g, '');
  return path.join(DIR, safe + '.ndjson');
}

async function rotateIfBig(file) {
  try {
    const st = await fs.stat(file);
    if (st.size < MAX_BYTES) return;
    const text = await fs.readFile(file, 'utf8');
    const lines = text.split('\n').filter(Boolean);
    await fs.writeFile(file, lines.slice(Math.floor(lines.length / 2)).join('\n') + '\n');
  } catch { /* missing file, or a racing writer — the append still succeeds */ }
}

export async function appendScrapeLog(campaignId, { ts, message, level, actor } = {}) {
  await fs.mkdir(DIR, { recursive: true });
  const file = fileFor(campaignId);
  await rotateIfBig(file);
  const rec = { ts: ts || Date.now(), message: String(message || '') };
  if (level && level !== 'info') rec.level = level;
  if (actor) rec.actor = String(actor);
  await fs.appendFile(file, JSON.stringify(rec) + '\n');
}

export async function appendAction(campaignId, { actor, admin, action, level } = {}) {
  const who = admin ? `${actor} (admin)` : actor;
  await appendScrapeLog(campaignId, { ts: Date.now(), message: `${action} by ${who}`, level, actor });
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
