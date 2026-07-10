import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCloudMode, modeAvailability, runTargetFacts, DEFAULT_RUN_TARGET, CLOUD_MODES } from '../public/js/run-target.mjs';

test('CLOUD_MODES matches the app\'s engine-supported set', () => {
  for (const m of ['connect_only','message_only','introduce_back','connect_and_introduce','connect_and_message','follower_growth','inmail_only','open_profile_only','check_status']) {
    assert.ok(CLOUD_MODES.has(m), `${m} should be cloud-capable`);
  }
  assert.equal(isCloudMode('check_dms'), false);
  assert.equal(isCloudMode('post_amplification'), false);
});

test('local run → every mode available', () => {
  assert.deepEqual(modeAvailability('check_dms', 'local', { engineConfigured: true }), { available: true, reason: '' });
});

test('cloud run → non-cloud mode unavailable with reason', () => {
  const r = modeAvailability('check_dms', 'cloud', { engineConfigured: true });
  assert.equal(r.available, false);
  assert.match(r.reason, /local/i);
});

test('cloud run + cloud mode → available', () => {
  assert.equal(modeAvailability('connect_and_introduce', 'cloud', { engineConfigured: true }).available, true);
});

test('DEFAULT_RUN_TARGET is local (operator default — cloud is opt-in)', () => {
  assert.equal(DEFAULT_RUN_TARGET, 'local');
});

test('facts differ per target and name the key trade-offs', () => {
  const vm = runTargetFacts('cloud').map((f) => f.text).join(' ');
  assert.match(vm, /close the laptop|survives/i);
  assert.match(vm, /GoLogin/);
  assert.match(vm, /follow-up/i);
  const local = runTargetFacts('local').map((f) => f.text).join(' ');
  assert.match(local, /pause|resume/i);
});
