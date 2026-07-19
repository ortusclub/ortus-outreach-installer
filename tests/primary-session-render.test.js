import { test } from 'node:test';
import assert from 'node:assert/strict';
import { primarySessionBadge } from '../public/js/primary-session-render.mjs';

// Retired: personal follow-ups drain locally now, so the "Primary needs login"
// badge is never surfaced (no VM login for a personal account). The badge is a
// no-op for every input; the honest signal is the local-followups nudge.

test('needs_login no longer surfaces a badge (local-drain retirement)', () => {
  assert.deepEqual(primarySessionBadge({ state: 'needs_login', name: 'Antonio', parked: 3 }), { show: false });
});

test('live / none / null / unknown all render nothing', () => {
  assert.equal(primarySessionBadge({ state: 'live', name: 'Antonio' }).show, false);
  assert.equal(primarySessionBadge({ state: 'none' }).show, false);
  assert.equal(primarySessionBadge(null).show, false);
  assert.equal(primarySessionBadge(undefined).show, false);
  assert.equal(primarySessionBadge({ state: 'bogus' }).show, false);
});
