import { test } from 'node:test';
import assert from 'node:assert/strict';
import { introConnectionStamp } from '../src/linkedin/auto-intro.js';

// v2.104 — a made (or already-made) 3-way intro proves the lead is a 1st-degree
// connection of the sending account, so the intro stamp must also stamp the
// connection columns. Otherwise "Introduction Made" rows still read "Connect
// Pending" on the reconnect-&-retry and aged-off paths (which fire without a
// fresh bulk-check Connected stamp). Values must mirror bulk-check's Connected
// stamp so they route to the same columns (cc/checkStatus → Connection Accepted
// Status, stage → Stage, connectedAlready → Connected).

test('confirmed intro stamps the full Connected column set', () => {
  assert.deepEqual(introConnectionStamp(true), {
    cc: 'Connected',
    stage: 'Connected',
    checkStatus: 'Connected',
    connectedAlready: 'Yes',
  });
});

test('a non-confirmed outcome (failed/skipped) stamps NO connection columns', () => {
  // Never claim Connected on a failed or interrupted intro.
  assert.deepEqual(introConnectionStamp(false), {});
});
