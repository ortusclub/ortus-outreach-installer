import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  primaryKeyFromUrl, storeKey, getEntry, shouldRecheck,
  mergeLiveRead, resolveDisplayState, seedConnectedIds,
} from '../src/primary-status-store.js';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPrimaryStatus, savePrimaryStatus } from '../src/primary-status-store.js';

test('primaryKeyFromUrl prefers vanity slug, lowercased', () => {
  assert.equal(primaryKeyFromUrl('https://www.linkedin.com/in/John-Smith/'), 's:john-smith');
  assert.equal(primaryKeyFromUrl('linkedin.com/in/john-smith?utm=x'), 's:john-smith');
});

test('primaryKeyFromUrl falls back to encoded member token when no vanity slug', () => {
  assert.equal(primaryKeyFromUrl('https://www.linkedin.com/in/ACwAABcd123_-/'), 'm:ACwAABcd123_-');
  assert.equal(primaryKeyFromUrl('https://www.linkedin.com/sales/lead/ACoAABcd999,NAME'), 'm:ACoAABcd999');
});

test('primaryKeyFromUrl returns empty for unusable input', () => {
  assert.equal(primaryKeyFromUrl(''), '');
  assert.equal(primaryKeyFromUrl(null), '');
  assert.equal(primaryKeyFromUrl('https://example.com/nope'), '');
});

test('storeKey joins profileId and primaryKey', () => {
  assert.equal(storeKey('prof1', 's:john-smith'), 'prof1|s:john-smith');
});

test('getEntry returns the entry or null', () => {
  const store = { 'prof1|s:john': { state: 'connected', degree: '1st', verifiedAt: 'T', primaryUrl: 'u' } };
  assert.deepEqual(getEntry(store, 'prof1', 's:john').state, 'connected');
  assert.equal(getEntry(store, 'prof1', 's:other'), null);
  assert.equal(getEntry({}, 'prof1', 's:john'), null);
});

test('shouldRecheck is false only for stored connected', () => {
  assert.equal(shouldRecheck({ state: 'connected' }), false);
  assert.equal(shouldRecheck({ state: 'pending' }), true);
  assert.equal(shouldRecheck({ state: 'unverified' }), true);
  assert.equal(shouldRecheck(null), true);
});

test('mergeLiveRead: connected is sticky — unverified does NOT demote it', () => {
  const prev = { state: 'connected', degree: '1st', verifiedAt: 'OLD', primaryUrl: 'u' };
  const next = mergeLiveRead(prev, 'unverified', 'NEW', 'u');
  assert.equal(next.state, 'connected');
  assert.equal(next.verifiedAt, 'OLD'); // unverified never re-stamps
});

test('mergeLiveRead: definitive connected/pending overwrites prior non-connected and stamps verifiedAt', () => {
  assert.equal(mergeLiveRead({ state: 'pending' }, 'connected', 'NEW', 'u').state, 'connected');
  assert.equal(mergeLiveRead({ state: 'unverified' }, 'pending', 'NEW', 'u').state, 'pending');
  assert.equal(mergeLiveRead(null, 'connected', 'NEW', 'u').verifiedAt, 'NEW');
});

test('mergeLiveRead: unverified over nothing stays unverified, no verifiedAt', () => {
  const next = mergeLiveRead(null, 'unverified', 'NEW', 'u');
  assert.equal(next.state, 'unverified');
  assert.equal(next.verifiedAt, null);
});

test('resolveDisplayState: live wins unless unverified-with-stored-connected (fallback)', () => {
  assert.deepEqual(
    resolveDisplayState({ state: 'connected' }, 'unverified'),
    { state: 'connected', source: 'remembered' });
  assert.deepEqual(
    resolveDisplayState({ state: 'connected' }, 'pending'),
    { state: 'pending', source: 'live' });
  assert.deepEqual(
    resolveDisplayState(null, 'unverified'),
    { state: 'unverified', source: 'live' });
});

test('seedConnectedIds returns the profileIds stored connected for a primaryKey', () => {
  // verifiedAt matters now: a connected stamp expires after a week, so these
  // have to be freshly verified to be seeded at all.
  const fresh = new Date().toISOString();
  const store = {
    'p1|s:john': { state: 'connected', verifiedAt: fresh },
    'p2|s:john': { state: 'pending', verifiedAt: fresh },
    'p3|s:other': { state: 'connected', verifiedAt: fresh },
    'p4|s:john': { state: 'connected', verifiedAt: fresh },
  };
  assert.deepEqual(seedConnectedIds(store, 's:john').sort(), ['p1', 'p4']);
  assert.deepEqual(seedConnectedIds(store, 's:none'), []);
});

test('savePrimaryStatus then loadPrimaryStatus round-trips', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pstore-'));
  const file = join(dir, 'primary-status.json');
  const data = { 'p1|s:john': { state: 'connected', degree: '1st', verifiedAt: 'T', primaryUrl: 'u' } };
  await savePrimaryStatus(file, data);
  assert.deepEqual(await loadPrimaryStatus(file), data);
  await rm(dir, { recursive: true, force: true });
});

test('loadPrimaryStatus returns {} for a missing file', async () => {
  assert.deepEqual(await loadPrimaryStatus(join(tmpdir(), 'nope-does-not-exist.json')), {});
});

test('loadPrimaryStatus returns {} for a corrupt file (never throws)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pstore-'));
  const file = join(dir, 'primary-status.json');
  await savePrimaryStatus(file, {});            // create
  await readFile(file);                          // exists
  const fsp = await import('node:fs/promises');
  await fsp.writeFile(file, '{ this is not json');
  assert.deepEqual(await loadPrimaryStatus(file), {});
  await rm(dir, { recursive: true, force: true });
});

test('savePrimaryStatus leaves no .tmp file behind', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pstore-'));
  const file = join(dir, 'primary-status.json');
  await savePrimaryStatus(file, { a: 1 });
  const fsp = await import('node:fs/promises');
  const entries = await fsp.readdir(dir);
  assert.deepEqual(entries, ['primary-status.json']);
  await rm(dir, { recursive: true, force: true });
});
