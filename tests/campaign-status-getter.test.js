import { test } from 'node:test';
import assert from 'node:assert/strict';
import { campaign } from '../src/campaign.js';

test('status getter is readable via direct property access', () => {
  campaign.running = false;
  campaign._paused = false;
  campaign._pauseRequested = false;
  campaign.state = undefined;
  assert.strictEqual(campaign.status, 'idle');

  campaign.running = true;
  assert.strictEqual(campaign.status, 'running');

  campaign.running = false;
  campaign.state = 'monitoring';
  assert.strictEqual(campaign.status, 'monitoring');

  campaign._paused = true;
  assert.strictEqual(campaign.status, 'paused');

  // restore clean state
  campaign.running = false;
  campaign._paused = false;
  campaign._pauseRequested = false;
  campaign.state = undefined;
});

test('status getter is non-enumerable so spread + Object.assign round-trips do not throw', () => {
  campaign.running = true;
  const snapshot = { ...campaign, state: 'monitoring' };
  assert.ok(
    !Object.prototype.hasOwnProperty.call(snapshot, 'status'),
    'spread should not capture the status getter'
  );
  assert.doesNotThrow(
    () => Object.assign(campaign, snapshot),
    'Object.assign(campaign, snapshot) must not throw on the status property'
  );
  // restore
  campaign.running = false;
  campaign.state = undefined;
});
