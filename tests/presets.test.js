import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Point the data dir at a temp folder BEFORE importing the module under test.
process.env.ORTUS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'presets-test-'));
const {
  readPresetsFile, listPresets, getPreset, savePreset, deletePreset,
  getLastUsed, saveLastUsed, PRESETS_FILE,
} = await import('../src/presets.js');

beforeEach(() => { try { fs.unlinkSync(PRESETS_FILE); } catch {} });

const cfg = (over = {}) => ({ mode: 'connect_only', profileIds: ['p1', 'p2'], sheetUrl: 'https://x', ...over });

test('readPresetsFile: missing/corrupt file yields empty store', () => {
  assert.deepEqual(readPresetsFile(), { presets: {}, last_used: {} });
  fs.writeFileSync(PRESETS_FILE, 'not json');
  assert.deepEqual(readPresetsFile(), { presets: {}, last_used: {} });
});

test('savePreset persists and getPreset round-trips', () => {
  savePreset({ name: 'FinTech settings', config: cfg(), user: 'a@ortusclub.com' });
  const entry = getPreset('FinTech settings');
  assert.equal(entry.config.mode, 'connect_only');
  assert.equal(entry.createdBy, 'a@ortusclub.com');
  assert.ok(entry.createdAt);
});

test('savePreset trims the name and rejects empty/invalid input', () => {
  const r = savePreset({ name: '  Trimmed  ', config: cfg() });
  assert.equal(r.name, 'Trimmed');
  assert.ok(getPreset('Trimmed'));
  assert.throws(() => savePreset({ name: '   ', config: cfg() }), /name required/);
  assert.throws(() => savePreset({ name: 'x', config: null }), /config required/);
  assert.throws(() => savePreset({ name: 'x', config: 'str' }), /config required/);
});

test('savePreset on an existing name updates config but keeps createdBy/createdAt', () => {
  savePreset({ name: 'P', config: cfg(), user: 'creator' });
  const first = getPreset('P');
  savePreset({ name: 'P', config: cfg({ mode: 'message_only' }), user: 'editor' });
  const second = getPreset('P');
  assert.equal(second.config.mode, 'message_only');
  assert.equal(second.createdBy, 'creator');
  assert.equal(second.createdAt, first.createdAt);
  assert.equal(second.updatedBy, 'editor');
});

test('listPresets returns summaries, not full configs', () => {
  savePreset({ name: 'A', config: cfg(), user: 'u' });
  const list = listPresets();
  assert.deepEqual(Object.keys(list), ['A']);
  assert.equal(list.A.mode, 'connect_only');
  assert.equal(list.A.profileCount, 2);
  assert.equal(list.A.config, undefined);
});

test('deletePreset removes only the named preset', () => {
  savePreset({ name: 'A', config: cfg() });
  savePreset({ name: 'B', config: cfg() });
  assert.equal(deletePreset('A'), true);
  assert.equal(deletePreset('A'), false); // already gone
  assert.equal(getPreset('A'), null);
  assert.ok(getPreset('B'));
});

test('last-used is per-user and round-trips', () => {
  assert.equal(getLastUsed('op1'), null);
  saveLastUsed('op1', cfg({ mode: 'message_only' }));
  saveLastUsed('op2', cfg());
  assert.equal(getLastUsed('op1').config.mode, 'message_only');
  assert.equal(getLastUsed('op2').config.mode, 'connect_only');
  assert.ok(getLastUsed('op1').savedAt);
  assert.throws(() => saveLastUsed('op1', null), /config required/);
});

test('writes are atomic: no lingering .tmp and file is valid JSON', () => {
  savePreset({ name: 'A', config: cfg() });
  assert.ok(!fs.existsSync(PRESETS_FILE + '.tmp'));
  JSON.parse(fs.readFileSync(PRESETS_FILE, 'utf8')); // does not throw
});

test('presets and last_used coexist in one file without clobbering', () => {
  savePreset({ name: 'A', config: cfg() });
  saveLastUsed('op1', cfg());
  const file = readPresetsFile();
  assert.ok(file.presets.A);
  assert.ok(file.last_used.op1);
});
