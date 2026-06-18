import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  primaryKeyFromUrl, storeKey, getEntry, shouldRecheck,
  mergeLiveRead, resolveDisplayState, seedConnectedIds,
} from '../src/primary-status-store.js';

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
  const store = {
    'p1|s:john': { state: 'connected' },
    'p2|s:john': { state: 'pending' },
    'p3|s:other': { state: 'connected' },
    'p4|s:john': { state: 'connected' },
  };
  assert.deepEqual(seedConnectedIds(store, 's:john').sort(), ['p1', 'p4']);
  assert.deepEqual(seedConnectedIds(store, 's:none'), []);
});
