import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Point the data dir at a temp folder BEFORE importing the module under test.
process.env.ORTUS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'blocklist-test-'));
const { readBlocklist, addEntry, removeEntry, inferKind, isPersonUrl, parsePersonUrl, BLOCKLIST_FILE } =
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

test('inferKind: LinkedIn profile URL → person (not domain)', () => {
  // Would-be 'domain' (has a dot, no space) but caught as a person first.
  assert.equal(inferKind('https://www.linkedin.com/in/jane-doe'), 'person');
  assert.equal(inferKind('linkedin.com/in/ACwAAB3xYz_encoded'), 'person');
  assert.equal(inferKind('https://www.linkedin.com/sales/lead/ACwAAB3xYz,NAME_SEARCH,abc'), 'person');
});

test('parsePersonUrl: URN vs vanity slug', () => {
  // Encoded member URN — case PRESERVED (base64url is case-sensitive).
  assert.deepEqual(parsePersonUrl('https://www.linkedin.com/in/ACwAAB3xYz_ok'), { urn: 'ACwAAB3xYz_ok' });
  // Sales Nav lead URL carries the same URN token (up to the comma).
  assert.deepEqual(parsePersonUrl('https://www.linkedin.com/sales/lead/ACwAAB3xYz_ok,NAME_SEARCH,x'), { urn: 'ACwAAB3xYz_ok' });
  // Vanity slug — lower-cased.
  assert.deepEqual(parsePersonUrl('https://www.linkedin.com/in/Jane-Doe'), { slug: 'jane-doe' });
  assert.deepEqual(parsePersonUrl('not a url'), {});
  assert.equal(isPersonUrl('IBM'), false);
});

test('addEntry: person by URL stores urn + canonicalizes; dedupes vanity vs sales-nav form', () => {
  const e = addEntry({ value: 'https://www.linkedin.com/sales/lead/ACwAAB3xYz_ok,NAME_SEARCH,abc?trk=x', addedBy: 'a' });
  assert.equal(e.kind, 'person');
  assert.equal(e.urn, 'ACwAAB3xYz_ok');
  assert.equal(e.value, 'linkedin.com/in/ACwAAB3xYz_ok'); // canonical
  // Same person, public /in/ form → same canonical → deduped.
  addEntry({ value: 'https://www.linkedin.com/in/ACwAAB3xYz_ok/', addedBy: 'b' });
  assert.equal(readBlocklist().length, 1);
});

test('addEntry: vanity person stores slug, no urn', () => {
  const e = addEntry({ value: 'https://www.linkedin.com/in/Jane-Doe/', addedBy: 'a' });
  assert.equal(e.kind, 'person');
  assert.equal(e.slug, 'jane-doe');
  assert.equal(e.urn, undefined);
  assert.equal(e.value, 'linkedin.com/in/jane-doe');
});

test('removeEntry removes a person entry by its canonical value', () => {
  const e = addEntry({ value: 'https://www.linkedin.com/in/ACwAAB3xYz_ok', addedBy: 'a' });
  assert.equal(removeEntry(e.value), true);
  assert.equal(readBlocklist().length, 0);
});

test('corrupt file → empty list, no throw', () => {
  fs.mkdirSync(path.dirname(BLOCKLIST_FILE), { recursive: true });
  fs.writeFileSync(BLOCKLIST_FILE, '{not json');
  assert.deepEqual(readBlocklist(), []);
});
