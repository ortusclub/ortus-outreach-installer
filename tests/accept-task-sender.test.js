import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAcceptTask, partitionByBrowser } from '../src/primary-tasks.js';

test('buildAcceptTask carries sender, defaults to local-browser', () => {
  const a = buildAcceptTask({ campaignProfileId: 'c1', now: 1000 });
  assert.equal(a.sender, 'local-browser');
  const b = buildAcceptTask({ campaignProfileId: 'c1', sender: 'profX', now: 1000 });
  assert.equal(b.sender, 'profX');
});

test('partitionByBrowser routes accept tasks by sender (legacy = local)', () => {
  const due = [
    { type: 'accept', sender: 'local-browser' },
    { type: 'accept', sender: 'profA' },
    { type: 'accept' },                       // legacy task, no sender → local
    { type: 'follow-up', sender: 'profB' },
    { type: 'follow-up', sender: 'local-browser' },
  ];
  const { local, byAccount } = partitionByBrowser(due);
  assert.equal(local.length, 3);             // local accept + legacy accept + local follow-up
  assert.deepEqual(Object.keys(byAccount).sort(), ['profA', 'profB']);
  assert.equal(byAccount.profA.length, 1);
  assert.equal(byAccount.profB.length, 1);
});
