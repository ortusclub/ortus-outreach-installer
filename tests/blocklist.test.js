import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Point the data dir at a temp folder BEFORE importing the module under test.
process.env.ORTUS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'blocklist-test-'));
const { readBlocklist, addEntry, removeEntry, inferKind, BLOCKLIST_FILE } =
  await import('../src/blocklist.js');

beforeEach(() => { try { fs.unlinkSync(BLOCKLIST_FILE); } catch {} });

test('inferKind: dot means domain, otherwise company', () => {
  assert.equal(inferKind('ortusclub.com'), 'domain');
  assert.equal(inferKind('IBM'), 'company');
  assert.equal(inferKind('J.P. Morgan'), 'company'); // dot but spaces → company
});

test('addEntry persists and readBlocklist round-trips', () => {
  const e = addEntry({ value: 'IBM', reason: 'existing client', addedBy: 'antonio@ortusclub.com' });
  assert.equal(e.kind, 'company');
  assert.ok(e.addedAt);
  const list = readBlocklist();
  assert.equal(list.length, 1);
  assert.equal(list[0].value, 'IBM');
});

test('addEntry is case-insensitively idempotent', () => {
  addEntry({ value: 'IBM', reason: 'client', addedBy: 'a' });
  addEntry({ value: 'ibm', reason: 'dup', addedBy: 'b' });
  assert.equal(readBlocklist().length, 1);
});

test('removeEntry removes case-insensitively and reports', () => {
  addEntry({ value: 'ortusclub.com', reason: 'employees', addedBy: 'a' });
  assert.equal(removeEntry('ORTUSCLUB.COM'), true);
  assert.equal(removeEntry('ORTUSCLUB.COM'), false);
  assert.equal(readBlocklist().length, 0);
});

test('corrupt file → empty list, no throw', () => {
  fs.mkdirSync(path.dirname(BLOCKLIST_FILE), { recursive: true });
  fs.writeFileSync(BLOCKLIST_FILE, '{not json');
  assert.deepEqual(readBlocklist(), []);
});
