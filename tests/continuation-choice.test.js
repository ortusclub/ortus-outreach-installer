import { test } from 'node:test';
import assert from 'node:assert/strict';
import { continuationChoices } from '../public/js/continuation-choice.mjs';
test('connect-only and unsupported modes never offer acceptance monitoring', () => {
  for (const mode of ['connect_only','open_profile_only','introduce_back','follower_growth','post_amplification']) {
    assert.deepEqual(continuationChoices({ mode }).map(c => c.value), ['sending']);
  }
});
test('CC+IC and CC+DM distinguish sending, one-check, and scheduled monitoring', () => {
  for (const mode of ['connect_and_introduce', 'connect_and_message']) {
    const choices = continuationChoices({ mode }, { monitoringAvailable: true });
    assert.deepEqual(choices.map(c => c.value), ['sending','check','monitoring']);
    assert.match(choices[1].detail, /automatic-check setting stays unchanged/);
    assert.match(choices[2].detail, /No new invitations/);
  }
});
test('active monitoring is not presented as needing to resume; absent capabilities stay disabled', () => {
  const active = continuationChoices({ mode: 'connect_and_introduce', state: 'monitoring', autoChecksEnabled: true }, { monitoringAvailable: true });
  assert.equal(active[2].disabled, true); assert.match(active[2].label, /already active/);
  const missing = continuationChoices({ mode: 'connect_and_introduce' }, { monitoringAvailable: false, checkAvailable: false });
  assert.equal(missing[1].disabled, true); assert.equal(missing[2].disabled, true);
});
