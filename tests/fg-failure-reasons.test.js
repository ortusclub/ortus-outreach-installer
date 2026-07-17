import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fgFailureReasons } from '../src/connections/fg-cloud-launch.js';

const record = { perAccount: [{ account: 'a@x', rowsByUrl: { 'https://x/jane': '111', 'https://x/john': '222', 'https://x/kim': '333' } }] };

test('sent leads are excluded; unsent get a reason keyed by Member ID', () => {
  const leads = [
    { leadUrl: 'https://x/jane', status: 'sent' },                    // sent → skip
    { leadUrl: 'https://x/john', status: 'pending', error: 'profile not found' }, // engine error verbatim
    { leadUrl: 'https://x/kim', status: 'pending' },                 // no error, run finished ok → generic
  ];
  const out = fgFailureReasons(leads, record, 'done');
  assert.equal(out['111'], undefined);
  assert.equal(out['222'], 'profile not found');
  assert.match(out['333'], /^Not sent — check the account/);
});

test('campaign stopped → all unsent read "Campaign stopped"', () => {
  const leads = [{ leadUrl: 'https://x/john', status: 'pending' }];
  const out = fgFailureReasons(leads, record, 'cancelled');
  assert.equal(out['222'], 'Campaign stopped before it sent');
});

test('a lead whose URL is not in the run record is ignored', () => {
  const out = fgFailureReasons([{ leadUrl: 'https://x/ghost', status: 'pending' }], record, 'done');
  assert.deepEqual(out, {});
});
