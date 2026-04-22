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
