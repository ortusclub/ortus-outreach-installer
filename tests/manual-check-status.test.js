import test from 'node:test';
import assert from 'node:assert/strict';
import { applyManualCheckStatus } from '../src/manual-check-status.js';

test('stopping a manual check keeps the monitored campaign on the board', () => {
  const status = applyManualCheckStatus({ state: 'monitoring', stopping: false }, false, { stopping: true, stopConfirmed: false });
  assert.equal(status.state, 'monitoring');
  assert.equal(status.stopping, false);
  assert.equal(status.checkStopping, true);
  assert.equal(status.manualCheck.stopping, true);
});

test('a standalone check still reports its own stopping state', () => {
  const status = applyManualCheckStatus({ state: 'idle' }, false, { stopping: true, stopConfirmed: false });
  assert.equal(status.state, 'stopping');
  assert.equal(status.stopping, true);
});
