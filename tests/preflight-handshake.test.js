import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planAccountsNeedingConnect, handshakeProgress, shouldProceed, checklistRow,
} from '../src/preflight-handshake.js';

test('planAccountsNeedingConnect: skips local-browser and already-connected', () => {
  const participating = ['p1', 'p2', 'local-browser', 'p3'];
  const primaryConn = new Map([['p1', 'connected'], ['p3', 'no_url']]);
  assert.deepEqual(planAccountsNeedingConnect(participating, primaryConn), ['p2', 'p3']);
});

test('planAccountsNeedingConnect: empty when all connected or local', () => {
  const participating = ['local-browser', 'p1'];
  const primaryConn = new Map([['p1', 'connected']]);
  assert.deepEqual(planAccountsNeedingConnect(participating, primaryConn), []);
});

test('handshakeProgress: counts accepted vs expected', () => {
  const expected = ['p1', 'p2', 'p3'];
  const primaryConn = new Map([['p1', 'connected'], ['p2', 'sent'], ['p3', 'accepting']]);
  assert.deepEqual(handshakeProgress(primaryConn, expected), { accepted: 1, total: 3, done: false });
});

test('handshakeProgress: done when all accepted', () => {
  const expected = ['p1', 'p2'];
  const primaryConn = new Map([['p1', 'connected'], ['p2', 'connected']]);
  assert.deepEqual(handshakeProgress(primaryConn, expected), { accepted: 2, total: 2, done: true });
});

test('handshakeProgress: total 0 → done true (nothing to do)', () => {
  assert.deepEqual(handshakeProgress(new Map(), []), { accepted: 0, total: 0, done: true });
});

test('shouldProceed: true when all accepted, regardless of time', () => {
  assert.equal(shouldProceed({ startedAt: 0, now: 1000, capMs: 120000, accepted: 3, total: 3 }), true);
});

test('shouldProceed: true when cap elapsed even if not all accepted', () => {
  assert.equal(shouldProceed({ startedAt: 0, now: 120001, capMs: 120000, accepted: 1, total: 3 }), true);
});

test('shouldProceed: false while waiting inside the cap with stragglers', () => {
  assert.equal(shouldProceed({ startedAt: 0, now: 30000, capMs: 120000, accepted: 1, total: 3 }), false);
});

test('checklistRow: maps state → icon + label', () => {
  assert.deepEqual(checklistRow('Angelica', 'connected'),        { name: 'Angelica', state: 'connected',        icon: '✓', label: 'accepted by primary' });
  assert.deepEqual(checklistRow('Miriam',   'accepting'),        { name: 'Miriam',   state: 'accepting',        icon: '↻', label: 'accepting…' });
  assert.deepEqual(checklistRow('Cindy',    'sent'),             { name: 'Cindy',    state: 'sent',             icon: '•', label: 'request sent — waiting' });
  assert.deepEqual(checklistRow('Stan',     'already_connected'),{ name: 'Stan',     state: 'already_connected',icon: '–', label: 'already connected' });
  assert.deepEqual(checklistRow('Unk',      'unverified'),       { name: 'Unk',      state: 'unverified',       icon: '•', label: 'could not verify' });
});
