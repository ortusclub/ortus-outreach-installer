// Campaign presets — whole-campaign snapshots (mode, sheet, accounts, templates,
// rate, limits, etc.) so operators can reload a full setup with one click.
// Stored globally (team-shared) in data/presets.json; "last used" is per-user.
// Shape: { presets: { name: { config, meta… } }, last_used: { email: { config, savedAt } } }
//
// Same store pattern as src/blocklist.js: sync fs + atomic .tmp+rename write.
import fs from 'node:fs';
import path from 'node:path';
import { dataPath } from './paths.js';

export const PRESETS_FILE = dataPath('presets.json');

export function readPresetsFile() {
  try {
    const parsed = JSON.parse(fs.readFileSync(PRESETS_FILE, 'utf8'));
    return {
      presets: parsed.presets && typeof parsed.presets === 'object' ? parsed.presets : {},
      last_used: parsed.last_used && typeof parsed.last_used === 'object' ? parsed.last_used : {},
    };
  } catch {
    return { presets: {}, last_used: {} };
  }
}

function writePresetsFile(data) {
  fs.mkdirSync(path.dirname(PRESETS_FILE), { recursive: true });
  const tmp = PRESETS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, PRESETS_FILE);
}

// Small summary per preset — what the picker dropdown needs, not full configs.
export function listPresets() {
  const file = readPresetsFile();
  const summary = {};
  for (const [name, entry] of Object.entries(file.presets)) {
    summary[name] = {
      name,
      mode: entry.config?.mode || null,
      profileCount: Array.isArray(entry.config?.profileIds) ? entry.config.profileIds.length : 0,
      createdBy: entry.createdBy || null,
      updatedAt: entry.updatedAt || entry.createdAt || null,
    };
  }
  return summary;
}

export function getPreset(name) {
  return readPresetsFile().presets[name] || null;
}

export function savePreset({ name, config, user = '' }) {
  const cleanName = String(name || '').trim();
  if (!cleanName) throw new Error('presets: name required');
  if (!config || typeof config !== 'object') throw new Error('presets: config required');
  const file = readPresetsFile();
  const existing = file.presets[cleanName];
  const now = new Date().toISOString();
  file.presets[cleanName] = {
    config,
    createdBy: existing?.createdBy || user,
    createdAt: existing?.createdAt || now,
    updatedBy: user,
    updatedAt: now,
  };
  writePresetsFile(file);
  return { saved: true, name: cleanName };
}

export function deletePreset(name) {
  const file = readPresetsFile();
  if (!(name in file.presets)) return false;
  delete file.presets[name];
  writePresetsFile(file);
  return true;
}

export function getLastUsed(user) {
  return readPresetsFile().last_used[user] || null;
}

export function saveLastUsed(user, config) {
  if (!config || typeof config !== 'object') throw new Error('presets: config required');
  const file = readPresetsFile();
  file.last_used[user] = { config, savedAt: new Date().toISOString() };
  writePresetsFile(file);
  return { saved: true };
}
