import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _decideReverifyAction } from '../src/linkedin/auto-intro.js';

test('downgrade when status is connect and CC=Connected', () => {
  assert.deepStrictEqual(
    _decideReverifyAction('connect', 'Connected'),
    { action: 'downgrade' }
  );
});

test('downgrade when status is pending and CC=Connected', () => {
  assert.deepStrictEqual(
    _decideReverifyAction('pending', 'Connected'),
    { action: 'downgrade' }
  );
});

test('noop with reason genuine-1st-degree when status is message', () => {
  assert.deepStrictEqual(
    _decideReverifyAction('message', 'Connected'),
    { action: 'noop', reason: 'genuine-1st-degree' }
  );
});

test('noop with reason follow-only-restricted when status is follow', () => {
  assert.deepStrictEqual(
    _decideReverifyAction('follow', 'Connected'),
    { action: 'noop', reason: 'follow-only-restricted' }
  );
});

test('noop with reason ambiguous when status is unknown', () => {
  assert.deepStrictEqual(
    _decideReverifyAction('unknown', 'Connected'),
    { action: 'noop', reason: 'ambiguous' }
  );
});

test('noop with reason cc-not-connected when row CC is anything but Connected', () => {
  assert.deepStrictEqual(
    _decideReverifyAction('connect', ''),
    { action: 'noop', reason: 'cc-not-connected' }
  );
  assert.deepStrictEqual(
    _decideReverifyAction('connect', 'Already connected'),
    { action: 'noop', reason: 'cc-not-connected' }
  );
  assert.deepStrictEqual(
    _decideReverifyAction('connect', 'Unverified — manual review (May 27th, 2026)'),
    { action: 'noop', reason: 'cc-not-connected' }
  );
});
