import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickUnreconciled } from '../src/fg-autopilot-reconcile.js';

test('returns dispatched runs with perAccount that are not already reconciled locally', () => {
  const serviceRuns = [
    { cloudId: 'a', status: 'dispatched', perAccount: [{ profileId: 'p1' }] },
    { cloudId: 'b', status: 'dispatched', perAccount: [{ profileId: 'p2' }] },
    { cloudId: 'c', status: 'failed' }, // no perAccount, skip
  ];
  const out = pickUnreconciled(serviceRuns, new Set(['a']));
  assert.deepEqual(out.map((r) => r.cloudId), ['b']);
});

test('empty when everything reconciled or nothing dispatched', () => {
  assert.deepEqual(pickUnreconciled([{ cloudId: 'x', status: 'failed' }], new Set()), []);
});
