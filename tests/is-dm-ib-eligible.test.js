import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDmIbEligible } from '../src/campaign.js';

// ─────────────────────────────────────────────────────────────────────────
// Accept cases — three legitimate "row represents a known connection" states
// ─────────────────────────────────────────────────────────────────────────

test('Stage="Connected · DM Now" accepts (per-lead Voyager confirmed)', () => {
  assert.equal(isDmIbEligible({ Stage: 'Connected · DM Now' }), true);
});

test('Stage="Already connected" accepts (bulk-check Path B, pre-existing 1st-degree)', () => {
  assert.equal(isDmIbEligible({ Stage: 'Already connected' }), true);
});

test('Stage="Connect Pending" + Connection Accepted Status="Connected" accepts (bulk-check Path A)', () => {
  const row = {
    Stage: 'Connect Pending',
    'Connection Accepted Status': 'Connected',
  };
  assert.equal(isDmIbEligible(row), true);
});

test('Stage="Connect Pending" + Connection Accepted Status="Already connected" accepts (Path A pre-existing)', () => {
  const row = {
    Stage: 'Connect Pending',
    'Connection Accepted Status': 'Already connected',
  };
  assert.equal(isDmIbEligible(row), true);
});

test('Legacy "Connected Status" column header still recognised for Path A', () => {
  // v2.13.x sheets pre-rename — column was "Connected Status" before v2.14
  // renamed it to "Connection Accepted Status". Both should match.
  const row = {
    Stage: 'Connect Pending',
    'Connected Status': 'Connected',
  };
  assert.equal(isDmIbEligible(row), true);
});

test('Lowercase header variants are accepted (sheet exported with normalised headers)', () => {
  const row = {
    stage: 'connect pending'.replace('connect pending', 'Connect Pending'), // sanity: keep canonical
    'connection accepted status': 'Connected',
  };
  // Stage value itself uses canonical casing — only the column NAME is
  // case-insensitive in our lookup, not the cell value.
  assert.equal(isDmIbEligible({ stage: 'Connect Pending', 'connection accepted status': 'Connected' }), true);
});

// ─────────────────────────────────────────────────────────────────────────
// Reject cases — terminal stages, skipped rows, empty, unconnected
// ─────────────────────────────────────────────────────────────────────────

test('Stage="" rejects (row never touched)', () => {
  assert.equal(isDmIbEligible({ Stage: '' }), false);
  assert.equal(isDmIbEligible({}), false);
});

test('Stage="Connect Pending" alone (no cc column) rejects', () => {
  // Bulk-check hasn't confirmed acceptance yet — just an outstanding invite.
  assert.equal(isDmIbEligible({ Stage: 'Connect Pending' }), false);
});

test('Stage="Connect Pending" + Connection Accepted Status="Still Pending" rejects', () => {
  const row = {
    Stage: 'Connect Pending',
    'Connection Accepted Status': 'Still Pending',
  };
  assert.equal(isDmIbEligible(row), false);
});

test('Stage="DM Sent" rejects (terminal — already messaged)', () => {
  assert.equal(isDmIbEligible({ Stage: 'DM Sent' }), false);
});

test('Stage="IC Sent" rejects (terminal — already intro\'d)', () => {
  assert.equal(isDmIbEligible({ Stage: 'IC Sent' }), false);
});

test('Stage="OP Sent" rejects (terminal — open-profile message sent)', () => {
  assert.equal(isDmIbEligible({ Stage: 'OP Sent' }), false);
});

test('Stage="InM Sent" rejects (terminal — InMail sent)', () => {
  assert.equal(isDmIbEligible({ Stage: 'InM Sent' }), false);
});

test('Stage="Replied" rejects (terminal — operator marked replied)', () => {
  assert.equal(isDmIbEligible({ Stage: 'Replied' }), false);
});

test('Stage="Done" rejects (terminal — operator-marked done)', () => {
  assert.equal(isDmIbEligible({ Stage: 'Done' }), false);
});

test('Stage="Skipped: URL not found" rejects (any Skipped-* stage)', () => {
  assert.equal(isDmIbEligible({ Stage: 'Skipped: URL not found' }), false);
  assert.equal(isDmIbEligible({ Stage: 'Skipped' }), false);
  assert.equal(isDmIbEligible({ Stage: 'Skipped: Rate limited' }), false);
});

test('Stage="Send Connect" rejects (cold lead, never invited)', () => {
  assert.equal(isDmIbEligible({ Stage: 'Send Connect' }), false);
});

test('Stage with whitespace is trimmed before matching', () => {
  assert.equal(isDmIbEligible({ Stage: '  Connected · DM Now  ' }), true);
  assert.equal(isDmIbEligible({ Stage: '  DM Sent  ' }), false);
});

test('Non-string cell values do not throw', () => {
  assert.equal(isDmIbEligible({ Stage: null }), false);
  assert.equal(isDmIbEligible({ Stage: undefined }), false);
  assert.equal(isDmIbEligible({ Stage: 0 }), false);
});
