import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  seedConnectedIds, staleConnectedIds, CONNECTED_TTL_MS,
} from '../src/primary-status-store.js';

const NOW = Date.parse('2026-09-01T15:00:00.000Z');
const at = (iso) => ({ state: 'connected', degree: '1st', verifiedAt: iso });

test('a connected stamp older than the TTL is no longer seeded', () => {
  // The real entry that made the handshake skip the whole check.
  const store = { '68654b73cd7edf1e3ed6d1bb|s:antoniovarlese': at('2026-07-19T12:17:32.824Z') };
  assert.deepEqual(seedConnectedIds(store, 's:antoniovarlese', { now: NOW }), []);
  assert.deepEqual(staleConnectedIds(store, 's:antoniovarlese', { now: NOW }),
    ['68654b73cd7edf1e3ed6d1bb']);
});

test('a recent connected stamp is still trusted', () => {
  const store = { 'p1|s:john': at(new Date(NOW - 60_000).toISOString()) };
  assert.deepEqual(seedConnectedIds(store, 's:john', { now: NOW }), ['p1']);
  assert.deepEqual(staleConnectedIds(store, 's:john', { now: NOW }), []);
});

test('an entry with no verifiedAt is never trusted', () => {
  const store = { 'p1|s:john': { state: 'connected', degree: '1st' } };
  assert.deepEqual(seedConnectedIds(store, 's:john', { now: NOW }), []);
  assert.deepEqual(staleConnectedIds(store, 's:john', { now: NOW }), ['p1']);
});

test('non-connected states are in neither list', () => {
  const store = { 'p1|s:john': { state: 'pending', verifiedAt: new Date(NOW).toISOString() } };
  assert.deepEqual(seedConnectedIds(store, 's:john', { now: NOW }), []);
  assert.deepEqual(staleConnectedIds(store, 's:john', { now: NOW }), []);
});

test('the TTL is a week', () => {
  assert.equal(CONNECTED_TTL_MS, 7 * 24 * 60 * 60 * 1000);
});

test('the handshake tells the operator when it re-checks a stale account', () => {
  const src = readFileSync(new URL('../src/cloud-preflight-handshake.js', import.meta.url), 'utf8');
  assert.match(src, /staleConnectedIds\(store, primaryKey\)/);
  assert.match(src, /last confirmed connected to the primary over a week ago/);
});

test('a sweep that found nothing says whether the page actually loaded', () => {
  const src = readFileSync(new URL('../src/linkedin/accept-invitation.js', import.meta.url), 'utf8');
  // The old line stated a conclusion with no evidence behind it.
  assert.doesNotMatch(src, /no additional pending invitations to accept/);
  assert.match(src, /the invitations page opened and there was nothing waiting to accept/);
  assert.match(src, /never finished loading/);
  assert.match(src, /did not land on the invitations page/);
  assert.match(src, /painted = false/);
});
