// Local company/domain blocklist — companies the app must never cold-contact.
// Stored per-machine in data/blocklist.json (spec decision 2026-07-07).
import fs from 'node:fs';
import path from 'node:path';
import { dataPath } from './paths.js';

export const BLOCKLIST_FILE = dataPath('blocklist.json');

export function inferKind(value) {
  const v = String(value || '').trim();
  return v.includes('.') && !v.includes(' ') ? 'domain' : 'company';
}

export function readBlocklist() {
  try {
    const raw = fs.readFileSync(BLOCKLIST_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
}

function writeBlocklist(entries) {
  fs.mkdirSync(path.dirname(BLOCKLIST_FILE), { recursive: true });
  const tmp = BLOCKLIST_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ entries }, null, 2));
  fs.renameSync(tmp, BLOCKLIST_FILE);
}

export function addEntry({ value, reason = '', addedBy = '' }) {
  const v = String(value || '').trim();
  if (!v) throw new Error('blocklist: value required');
  const entries = readBlocklist();
  const existing = entries.find((e) => e.value.toLowerCase() === v.toLowerCase());
  if (existing) return existing;
  const entry = { value: v, kind: inferKind(v), reason, addedBy, addedAt: new Date().toISOString() };
  entries.push(entry);
  writeBlocklist(entries);
  return entry;
}

export function removeEntry(value) {
  const v = String(value || '').trim().toLowerCase();
  const entries = readBlocklist();
  const next = entries.filter((e) => e.value.toLowerCase() !== v);
  if (next.length === entries.length) return false;
  writeBlocklist(next);
  return true;
}
