import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { RETIRED_MODES, isRetiredMode } from '../public/js/campaign-modes.mjs';
import { CLOUD_MODES, isCloudMode } from '../src/campaigns-client.js';

// 'Direct Messages' (message_only) and 'InMail Only' (inmail_only) were retired
// on 2026-08-06 — removed from the picker AND from both launch paths, local and
// cloud. They had been greyed "Unavailable" for months, which stopped nobody: a
// saved draft, a schedule or a queued row still carries the mode and goes
// straight to the server. These pin the structural half of the retirement.
//
// Why they went: docs/HANDOFF-message-modes-on-vm.md lists six gaps in the
// message-sending modes. The engine PR that closed gaps 1-3 covered
// `open_profile_only` ONLY, so on the VM these two still have no re-send guard —
// a re-launch would message every row that already reads "DM Sent".

test('all three modes are retired', () => {
  assert.ok(isRetiredMode('message_only'));
  assert.ok(isRetiredMode('inmail_only'));
  assert.ok(isRetiredMode('check_status'));
  assert.equal(RETIRED_MODES.size, 3);
});

// check_status is the delicate one: only the standalone CAMPAIGN TYPE is gone.
// The acceptance sweep it performed still runs inside CC+IC / CC+DM, behind the
// "Run check now" button, and on the cloud monitor cadence — all of which reach
// it through /api/bulk-check-* and the monitor task, never by launching a
// check_status campaign. If a future change routes a sweep through a campaign
// launch again, this guard is what should stop it silently 400ing.
test('retiring check_status does not touch the acceptance-sweep plumbing', () => {
  const app = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  assert.ok(app.includes('window.dashRunCheck'), 'the Run-check-now entry point still exists');
  assert.ok(app.includes('dashBulkCheck'), 'the bulk-check path still exists');
  // Nothing may build a launch payload with this mode.
  assert.equal(app.includes("mode: 'check_status'"), false, 'something launches a check_status campaign');
});

test('modes that are still shipping are NOT retired', () => {
  for (const m of ['connect_only', 'connect_and_introduce', 'connect_and_message',
    'introduce_back', 'open_profile_only', 'follower_growth']) {
    assert.equal(isRetiredMode(m), false, `${m} must stay launchable`);
  }
});

test('isRetiredMode is total — no throw on junk input', () => {
  for (const v of [undefined, null, '', 0, {}, []]) assert.equal(isRetiredMode(v), false);
});

test('a retired mode can never be dispatched to the cloud', () => {
  // This is what makes the VM half work with no engine deploy: handleStartCloud
  // gates on isCloudMode, so dropping them here 400s the dispatch.
  for (const m of RETIRED_MODES) {
    assert.equal(isCloudMode(m), false, `${m} must not be a cloud mode`);
    assert.equal(CLOUD_MODES.has(m), false);
  }
  assert.ok(isCloudMode('open_profile_only'), 'Message Campaign stays — it is the one the engine fixed');
});

test('the wizard offers no way to pick a retired mode', () => {
  // The <select> is the real form control the card grid drives; a leftover
  // <option> would let applyPresetConfig re-select a retired mode from an old
  // draft and quietly put the wizard back into it.
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  for (const m of RETIRED_MODES) {
    assert.equal(html.includes(`<option value="${m}"`), false, `#campaign-mode still offers ${m}`);
  }
  assert.ok(html.includes('<option value="open_profile_only"'), 'sanity: the check can actually find options');
});

test('the mode-card grid no longer lists them', () => {
  const app = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  for (const m of RETIRED_MODES) {
    assert.equal(app.includes(`value: '${m}'`), false, `the mode grid still has a card for ${m}`);
  }
  assert.ok(app.includes("value: 'open_profile_only'"), 'sanity: the check can actually find cards');
});
