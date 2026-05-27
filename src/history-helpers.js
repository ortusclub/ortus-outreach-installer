// Helpers backing the /api/history/:idx/* routes (v0.3 dashboard).
//
// Kept thin and pure so the routes stay declarative and unit tests can
// exercise the logic without spinning up an HTTP listener (matching the
// repo-wide convention in tests/* — pure-helper, not integration).
//
// Persistence model: history.json is a JSON array, oldest-first. We
// replace it wholesale (read → mutate → write) just like the existing
// /api/history/* routes in server.js. No .tmp + rename here — matching
// the in-place pattern those routes already use.

import { readFile, writeFile } from 'node:fs/promises';
import { dataPath } from './paths.js';
import { addToQueue } from './campaign-queue.js';

const HISTORY_PATH = dataPath('history.json');

async function readHistory() {
  try {
    const raw = await readFile(HISTORY_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeHistory(arr) {
  await writeFile(HISTORY_PATH, JSON.stringify(arr, null, 2), 'utf-8');
}

// Result codes mirror the route's HTTP semantics so the route handler
// is a 1:1 translator. 'ok' carries the new queue entry on success.
export async function relaunchHistoryEntry(idx) {
  if (!Number.isInteger(idx) || idx < 0) {
    return { ok: false, code: 'invalid_idx' };
  }
  const history = await readHistory();
  if (idx >= history.length) {
    return { ok: false, code: 'out_of_range' };
  }
  const entry = history[idx];
  if (!entry.settings) {
    return { ok: false, code: 'missing_settings' };
  }
  const config = {
    ...entry.settings,
    name: (entry.name || 'Campaign') + ' (rerun)',
    mode: entry.mode || entry.settings.mode,
  };
  const queued = await addToQueue(config, entry.owner || null);
  return { ok: true, entry: queued };
}

export async function archiveHistoryEntry(idx) {
  if (!Number.isInteger(idx) || idx < 0) {
    return { ok: false, code: 'invalid_idx' };
  }
  const history = await readHistory();
  if (idx >= history.length) {
    return { ok: false, code: 'out_of_range' };
  }
  history[idx].archived = true;
  await writeHistory(history);
  return { ok: true };
}

// Read history with optional archived filter. The default (no filter)
// matches the existing GET /api/history behaviour for backwards compat;
// only `?includeArchived=false` activates the filter.
export async function listHistory({ includeArchived = true } = {}) {
  const all = await readHistory();
  if (includeArchived) return all;
  return all.filter((e) => !e.archived);
}

// Read the per-campaign filtered slice of data/campaign.log. Returns
// the last `limit` lines that mention the campaign's name (case-sensitive
// substring match — the log format embeds the name verbatim).
export async function readCampaignLog(idx, { limit = 500 } = {}) {
  if (!Number.isInteger(idx) || idx < 0) {
    return { ok: false, code: 'invalid_idx' };
  }
  const history = await readHistory();
  if (idx >= history.length) {
    return { ok: false, code: 'out_of_range' };
  }
  const name = history[idx].name || '';
  if (!name) return { ok: true, name, lines: [], total: 0 };
  const logFile = dataPath('campaign.log');
  let text;
  try {
    text = await readFile(logFile, 'utf-8');
  } catch {
    return { ok: true, name, lines: [], total: 0 };
  }
  const all = text.split('\n');
  const filtered = all.filter((l) => l.includes(name));
  const last = filtered.slice(-limit);
  return { ok: true, name, lines: last, total: filtered.length };
}
