import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeBulkCheckUpdates } from '../src/linkedin/bulk-check-connections.js';
import {
  INTRO_FAILED_PRIMARY_NOT_CONNECTED,
  INTRO_RETRY_RECONNECT,
  isIntroRetrySentinel,
  isIntroSlotOpen,
} from '../src/linkedin/intro-constants.js';

// v2.98 — reconnect & retry revive.

test('isIntroRetrySentinel matches only the canonical sentinel', () => {
  assert.equal(isIntroRetrySentinel(INTRO_RETRY_RECONNECT), true);
  assert.equal(isIntroRetrySentinel('  ' + INTRO_RETRY_RECONNECT + '  '), true);
  assert.equal(isIntroRetrySentinel('Introduction Made'), false);
  assert.equal(isIntroRetrySentinel(''), false);
  assert.equal(isIntroRetrySentinel(undefined), false);
});

test('isIntroSlotOpen: blank and the sentinel are open; everything else is terminal', () => {
  assert.equal(isIntroSlotOpen(''), true);
  assert.equal(isIntroSlotOpen('   '), true);
  assert.equal(isIntroSlotOpen(INTRO_RETRY_RECONNECT), true);
  assert.equal(isIntroSlotOpen(INTRO_FAILED_PRIMARY_NOT_CONNECTED), false);
  assert.equal(isIntroSlotOpen('Introduction Made'), false);
  assert.equal(isIntroSlotOpen('IC Sent'), false);
});

const baseRow = (overrides = {}) => ({
  'First Name': 'Jane',
  'Last Name': 'Doe',
  'LinkedIn URL': 'https://linkedin.com/in/jane-doe',
  'Connection Request Status': 'Connection Request Sent',
  'Connected Status': '',
  ...overrides,
});
const baseConns = [
  { firstName: 'Jane', lastName: 'Doe', publicId: 'jane-doe', urn: 'ACoAAaaa', memberNumber: '111', account: 'eryca.bilazon@ortus.solutions' },
];
const stillPendingLabel = 'Still Pending (2026-05-12 10:00)';
const linkedinColumn = 'LinkedIn URL';

test('a row with the retry sentinel is re-queued for an intro attempt', () => {
  const rows = [baseRow({ 'Introduction Status': INTRO_RETRY_RECONNECT })];
  const { connectedUrls } = computeBulkCheckUpdates(
    rows, baseConns, linkedinColumn, stillPendingLabel, { suppressAcceptedStamp: false }
  );
  assert.ok(connectedUrls.includes('https://linkedin.com/in/jane-doe'),
    'sentinel row should be treated as an open slot and re-queued');
});

test('a row with the terminal failure stamp is NOT re-queued', () => {
  const rows = [baseRow({ 'Introduction Status': INTRO_FAILED_PRIMARY_NOT_CONNECTED })];
  const { connectedUrls } = computeBulkCheckUpdates(
    rows, baseConns, linkedinColumn, stillPendingLabel, { suppressAcceptedStamp: false }
  );
  assert.ok(!connectedUrls.includes('https://linkedin.com/in/jane-doe'),
    'terminal "Failed — Primary not in your connections" stays one-shot');
});

test('a blank intro row is still re-queued (unchanged behaviour)', () => {
  const rows = [baseRow({ 'Introduction Status': '' })];
  const { connectedUrls } = computeBulkCheckUpdates(
    rows, baseConns, linkedinColumn, stillPendingLabel, { suppressAcceptedStamp: false }
  );
  assert.ok(connectedUrls.includes('https://linkedin.com/in/jane-doe'));
});
