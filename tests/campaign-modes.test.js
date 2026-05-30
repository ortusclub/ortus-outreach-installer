import { test } from 'node:test';
import assert from 'node:assert/strict';

import { usesMonitoringCadence } from '../public/js/campaign-modes.mjs';

// Single source of truth for "which campaign modes send a connection request
// and then monitor for acceptance to auto-fire a follow-up". Both the cadence
// dropdown's visibility AND the launch payload's cadence read must use this —
// they drifted apart once (visibility showed the control for CC+DM but the
// payload reader only honoured CC+IC), which silently dropped the operator's
// 15-min choice and defaulted CC+DM to 60. This helper prevents that drift.

test('CC+IC uses monitoring cadence', () => {
  assert.equal(usesMonitoringCadence('connect_and_introduce'), true);
});

test('CC+DM uses monitoring cadence (the regression mode)', () => {
  assert.equal(usesMonitoringCadence('connect_and_message'), true);
});

test('modes that do NOT monitor for acceptance return false', () => {
  for (const mode of [
    'connect_only',
    'message_only',
    'introduce_back',
    'inmail_only',
    'open_profile_only',
    'check_status',
    'check_dms',
  ]) {
    assert.equal(usesMonitoringCadence(mode), false, `${mode} should not use cadence`);
  }
});

test('unknown / empty / nullish modes are safe (false, no throw)', () => {
  assert.equal(usesMonitoringCadence(undefined), false);
  assert.equal(usesMonitoringCadence(null), false);
  assert.equal(usesMonitoringCadence(''), false);
  assert.equal(usesMonitoringCadence('not_a_real_mode'), false);
});
