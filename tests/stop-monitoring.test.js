import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeStillPendingUrls,
  buildClosedNotConnectedUpdate,
  CLOSED_NOT_CONNECTED_STAMP,
} from '../src/stop-monitoring.js';

const ROWS = [
  { 'LinkedIn URL': 'https://linkedin.com/in/a', 'Connection Request Status': 'Connection Request Sent', 'Connection Accepted Status': '' },
  { 'LinkedIn URL': 'https://linkedin.com/in/b', 'Connection Request Status': 'Connection Request Sent', 'Connection Accepted Status': 'Connected' },
  { 'LinkedIn URL': 'https://linkedin.com/in/c', 'Connection Request Status': '', 'Connection Accepted Status': '' },
  { 'LinkedIn URL': '', 'Connection Request Status': 'Connection Request Sent', 'Connection Accepted Status': '' },
];

test('computeStillPendingUrls returns URLs sent but not yet connected', () => {
  const pending = computeStillPendingUrls(ROWS, 'LinkedIn URL');
  assert.deepEqual(pending, ['https://linkedin.com/in/a']);
});

test('computeStillPendingUrls ignores rows that were never sent', () => {
  const pending = computeStillPendingUrls(ROWS, 'LinkedIn URL');
  assert.equal(pending.includes('https://linkedin.com/in/c'), false);
});

test('computeStillPendingUrls ignores rows without a URL', () => {
  const pending = computeStillPendingUrls(ROWS, 'LinkedIn URL');
  assert.equal(pending.includes(''), false);
  assert.equal(pending.length, 1);
});

test('computeStillPendingUrls returns [] on empty input', () => {
  assert.deepEqual(computeStillPendingUrls([], 'LinkedIn URL'), []);
  assert.deepEqual(computeStillPendingUrls(null, 'LinkedIn URL'), []);
});

test('buildClosedNotConnectedUpdate produces a sheet-writer payload', () => {
  const u = buildClosedNotConnectedUpdate();
  assert.equal(u.connectionRequestStatus, CLOSED_NOT_CONNECTED_STAMP);
  assert.equal(u.connectionRequestStatus, 'Closed - Not Connected');
});
