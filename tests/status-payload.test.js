import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getCampaignStatus, _setTestState } from '../src/campaign.js';

test('resources and throttle are null when no sample has been taken', () => {
  _setTestState({ _lastSample: null, _throttle: null });
  const s = getCampaignStatus();
  assert.equal(s.resources, null);
  assert.equal(s.throttle, null);
});

test('resources payload shape matches when sample present', () => {
  _setTestState({
    _lastSample: {
      ramPct: 82.5,
      load1: 6.1,
      cpuPct: 0,
      cpuCount: 8,
      browsers: [{ pid: 123, rssMb: 450 }],
      totalBrowserRssMb: 450,
      sampledAt: 1234567890,
    },
    _throttle: { active: true, reason: 'RAM 83%', multiplier: 2 },
  });
  const s = getCampaignStatus();
  assert.equal(s.resources.ramPct, 82.5);
  assert.equal(s.resources.load1, 6.1);
  assert.equal(s.resources.cpuPct, 0);
  assert.equal(s.resources.cpuCount, 8);
  assert.equal(s.resources.browsers.length, 1);
  assert.equal(s.resources.browsers[0].pid, 123);
  assert.equal(s.resources.browsers[0].rssMb, 450);
  assert.equal(s.resources.totalBrowserRssMb, 450);
  assert.equal(s.resources.sampledAt, 1234567890);
  assert.equal(s.throttle.active, true);
  assert.equal(s.throttle.reason, 'RAM 83%');
  assert.equal(s.throttle.multiplier, 2);

  // Reset state so other tests aren't polluted
  _setTestState({ _lastSample: null, _throttle: null });
});

// Review finding 4: the local status payload must carry the SAME cadence
// shape the cloud path sends (checkIntervalMinutes=effective,
// checkIntervalBaseMinutes=base, emptyCheckStreak), so
// public/js/live-activity.mjs's checkSlowdown() reads one shape for both —
// not a second local-only display rule.
test('status cadence fields: no streak → effective equals base, not slowed', () => {
  _setTestState({ checkIntervalMinutes: 60, emptyCheckStreak: 0 });
  const s = getCampaignStatus();
  assert.equal(s.checkIntervalMinutes, 60);
  assert.equal(s.checkIntervalBaseMinutes, 60);
  assert.equal(s.emptyCheckStreak, 0);
});

test('status cadence fields: a stretched streak surfaces the EFFECTIVE cadence, base stays the operator setting', () => {
  _setTestState({ checkIntervalMinutes: 60, emptyCheckStreak: 6 });
  const s = getCampaignStatus();
  assert.equal(s.checkIntervalMinutes, 240, 'effective — what the card should show as "next check"');
  assert.equal(s.checkIntervalBaseMinutes, 60, 'base — the operator setting, unaffected by the streak');
  assert.equal(s.emptyCheckStreak, 6);
  _setTestState({ checkIntervalMinutes: null, emptyCheckStreak: 0 });
});

test('status cadence fields: campaign never started → all null/0, not a fabricated 60', () => {
  _setTestState({ checkIntervalMinutes: null, emptyCheckStreak: 0 });
  const s = getCampaignStatus();
  assert.equal(s.checkIntervalMinutes, null);
  assert.equal(s.checkIntervalBaseMinutes, null);
  assert.equal(s.emptyCheckStreak, 0);
});
