// The handover's pure decisions. The endpoint itself is integration-tested by
// hand; what is worth locking down is which leads are excluded and the ORDER of
// operations, because reversing that order is what would let both sides run at
// once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processedLeadUrls, handoverPlan, sheetProcessedUrls, heldLocalOutcomeUrls, waitForVerifiedCloudRelease } from '../src/handover.js';

test('VM move waits for a verified source release and never advances from a pending receipt', async () => {
  const replies = [{ pending: true }, { pending: true }, { released: true }];
  let calls = 0;
  const result = await waitForVerifiedCloudRelease(async () => replies[calls++], { wait: async () => {} });
  assert.equal(calls, 3);
  assert.deepEqual(result, { released: true });
  const stuck = await waitForVerifiedCloudRelease(async () => ({ pending: true }), { attempts: 2, wait: async () => {} });
  assert.deepEqual(stuck, { pending: true });
  const refusal = await waitForVerifiedCloudRelease(async () => ({ error: 'outcome review required' }), { wait: async () => {} });
  assert.deepEqual(refusal, { error: 'outcome review required' });
});

test('every non-pending lead is excluded from the new side', () => {
  const urls = processedLeadUrls([
    { leadUrl: 'https://a', status: 'sent' },
    { leadUrl: 'https://b', status: 'pending' },
    { leadUrl: 'https://c', status: 'failed' },
    { leadUrl: 'https://d', status: 'skipped' },
    { leadUrl: '', status: 'sent' },
  ]);
  assert.deepEqual(urls.sort(), ['https://a', 'https://c', 'https://d'],
    'pending is the only status that means "still to do"; a blank URL is unusable');
});

test('the lead in flight is excluded from automatic retry', () => {
  assert.deepEqual(processedLeadUrls([{ leadUrl: 'https://x', status: 'in_progress' }]), ['https://x']);
  assert.deepEqual(processedLeadUrls([{ leadUrl: 'https://held', status: 'needs_review' }]), ['https://held']);
});

test('local unconfirmed actions stay out of VM work after shutdown', () => {
  const rows = [{ url: 'https://clicked' }, { url: 'https://held' }, { url: 'https://untouched' }];
  assert.deepEqual(heldLocalOutcomeUrls(rows, row => row.url, {
    'https://clicked': { action: '_in_progress' },
    'https://held': { action: 'needs_review' },
    'https://untouched': { action: 'pending' },
  }), ['https://clicked', 'https://held']);
});

test('the plan always stops the source before starting the target', () => {
  const steps = handoverPlan({ from: 'vm', to: 'local' }).map((s) => s.kind);
  assert.deepEqual(steps, ['release-source', 'read-sheet', 'start-target', 'reset-cadence']);
  assert.ok(steps.indexOf('release-source') < steps.indexOf('start-target'),
    'THE rule: the target may not start until the source is confirmed stopped');
});

test('a handover to the side already running is a no-op, not a restart', () => {
  assert.deepEqual(handoverPlan({ from: 'local', to: 'local' }), [],
    'a double-click must never stop and restart a healthy campaign');
});

// The local side keeps no per-lead table — the SHEET is its ledger. So the
// local→VM exclude list is derived from the stamps the local run left there.
test('a row the local run stamped is excluded; an untouched row is not', () => {
  const urlOf = (r) => r['LinkedIn URL'] || '';
  const urls = sheetProcessedUrls([
    { 'LinkedIn URL': 'https://a', Stage: 'IC Sent' },
    { 'LinkedIn URL': 'https://b', Stage: '' },
    { 'LinkedIn URL': 'https://c', 'Connection Request Status': 'Connection Request Sent' },
    { 'LinkedIn URL': 'https://d', 'DM Status': 'DM Sent' },
    { 'LinkedIn URL': 'https://e', 'Introduction Status': 'Failed — no thread' },
    { 'LinkedIn URL': '', Stage: 'IC Sent' },
    { 'LinkedIn URL': 'https://f', Stage: '   ' },
  ], urlOf);
  assert.deepEqual(urls.sort(), ['https://a', 'https://c', 'https://d', 'https://e'],
    'any non-blank status column means the local side is done with that row');
});
