/**
 * Campaign queue — sequential FIFO scheduler.
 *
 * When a campaign starts while another is running, its config is appended
 * here instead of erroring. When a running campaign ends, the runner pops
 * the next entry and launches it. Persisted to disk so a crash mid-run
 * doesn't lose the operator's queued work.
 *
 * One-at-a-time sequential model. Concurrency lives at the account level
 * inside a single campaign, not across campaigns.
 */

import fs from 'fs/promises';
import { dataPath } from './paths.js';

const QUEUE_FILE = dataPath('queued-campaigns.json');

let cache = null;

async function load() {
  if (cache !== null) return cache;
  try {
    const text = await fs.readFile(QUEUE_FILE, 'utf8');
    const parsed = JSON.parse(text);
    cache = Array.isArray(parsed) ? parsed : [];
  } catch {
    cache = [];
  }
  return cache;
}

async function persist() {
  if (cache === null) await load();
  const tmp = QUEUE_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(cache, null, 2));
  await fs.rename(tmp, QUEUE_FILE);
}

export async function getQueue() {
  return [...(await load())];
}

export async function addToQueue(config, owner) {
  await load();
  const entry = {
    id: 'q_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    queuedAt: Date.now(),
    name: (config && config.name) || '',
    config,
    owner: owner || null,
  };
  cache.push(entry);
  await persist();
  return entry;
}

export async function removeFromQueue(id) {
  await load();
  const idx = cache.findIndex((e) => e.id === id);
  if (idx === -1) return false;
  cache.splice(idx, 1);
  await persist();
  return true;
}

export async function popNext() {
  await load();
  if (cache.length === 0) return null;
  const next = cache.shift();
  await persist();
  return next;
}

// Move a queued entry up (-1) or down (+1) within the FIFO order. No-op
// if the entry is already at the boundary in the requested direction.
// Returns the new index (or -1 if the id wasn't found).
export async function moveInQueue(id, direction) {
  await load();
  const idx = cache.findIndex((e) => e.id === id);
  if (idx === -1) return -1;
  const delta = direction === 'up' ? -1 : direction === 'down' ? 1 : 0;
  const target = idx + delta;
  if (target < 0 || target >= cache.length || delta === 0) return idx;
  const [entry] = cache.splice(idx, 1);
  cache.splice(target, 0, entry);
  await persist();
  return target;
}

export async function clearQueue() {
  cache = [];
  await persist();
}

// Atomic full-order reorder. Accepts an array of queue ids in the desired
// new order. Validates that the ids match the current queue exactly (same
// set, same length) so a concurrent pop/cancel can't silently corrupt the
// order. Returns true on success, or an object with reason='mismatch' so
// the caller can refresh and retry. Used by drag-to-reorder in the dashboard.
export async function reorderQueue(ids) {
  await load();
  if (!Array.isArray(ids)) return { ok: false, reason: 'invalid_input' };
  if (ids.length !== cache.length) return { ok: false, reason: 'mismatch' };
  const have = new Set(cache.map((e) => e.id));
  for (const id of ids) {
    if (!have.has(id)) return { ok: false, reason: 'mismatch' };
  }
  const byId = new Map(cache.map((e) => [e.id, e]));
  cache = ids.map((id) => byId.get(id));
  await persist();
  return { ok: true };
}
