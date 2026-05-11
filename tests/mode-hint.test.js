import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getModeHint } from '../src/campaign.js';

// Pure helper — maps campaign mode (and optional prevAction) to an action hint
// string understood by the outreach engine. Returns null for unknown modes.

test('connect_only mode returns "force_connect"', () => {
  const hint = getModeHint('connect_only', null);
  assert.equal(hint, 'force_connect');
});

test('message_only mode returns "force_message"', () => {
  const hint = getModeHint('message_only', null);
  assert.equal(hint, 'force_message');
});

test('check_status mode returns "check_only"', () => {
  const hint = getModeHint('check_status', null);
  assert.equal(hint, 'check_only');
});

test('inmail_only mode returns "force_inmail"', () => {
  const hint = getModeHint('inmail_only', null);
  assert.equal(hint, 'force_inmail');
});

test('open_profile_only mode returns "force_open_profile"', () => {
  const hint = getModeHint('open_profile_only', null);
  assert.equal(hint, 'force_open_profile');
});

test('unknown mode returns null (no throw)', () => {
  const hint = getModeHint('not_a_real_mode', null);
  assert.equal(hint, null);
});
