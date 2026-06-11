import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAcceptTask, dedupeKey } from '../src/primary-tasks.js';

test('an accept task for a connect-sent account is well-formed and due now', () => {
  const t = buildAcceptTask({
    campaignProfileId: '690d',
    campaignProfileName: 'patrick.s',
    sheetId: 'SHEET123',
    sheetUrl: 'u',
    account: { name: 'Patrick Smith', profileUrl: 'https://lnkd/in/patrick' },
    primaryUrl: 'https://lnkd/in/you',
    now: 7,
  });
  assert.equal(t.type, 'accept');
  assert.equal(t.status, 'pending');
  assert.equal(t.dueAt, 7);
  assert.equal(dedupeKey(t), 'accept:690d');
});
