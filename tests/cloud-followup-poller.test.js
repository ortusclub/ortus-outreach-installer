// tests/cloud-followup-poller.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pollOnce } from '../src/cloud-followup-poller.js';

const NOW = 1_700_000_000_000;
const base = (over = {}) => ({
  getOperatorEmail: () => 'o@test',
  now: () => NOW,
  log: () => {},
  ...over,
});

test('maps engine follow-ups → buildFollowUpTask, enqueues, acks both, counts late', async () => {
  const built = [];
  const enqueued = [];
  let acked = null;
  const res = await pollOnce(base({
    getLocalFollowups: async () => ({ followups: [
      { taskId: 't1', profileId: 'accA', sheetUrl: 's', threadUrl: 'th', introTitle: 'it', leadName: 'A', leadUrl: 'la', primaryName: 'P', primaryUrl: 'pu', body: 'b', dueAt: new Date(NOW - 40 * 60_000).toISOString() },
      { taskId: 't2', profileId: 'accB', sheetUrl: 's2', threadUrl: 'th2', leadUrl: 'lb', body: 'b2', dueAt: new Date(NOW - 60_000).toISOString() },
    ] }),
    buildFollowUpTask: (a) => { built.push(a); return { id: 'task:' + a.leadUrl }; },
    enqueuePrimaryTask: async (t) => { enqueued.push(t); return t; },
    ackLocalFollowups: async (ids) => { acked = ids; return { delegated: ids.length }; },
  }));

  assert.equal(built.length, 2);
  assert.equal(built[0].campaignProfileId, 'accA');   // profileId → campaignProfileId
  assert.equal(built[0].sender, 'local-browser');
  assert.equal(built[0].delayMinutes, 0);             // engine only offers due ones
  assert.equal(built[0].threadUrl, 'th');
  assert.equal(built[0].sheetUrl, 's');
  assert.equal(enqueued.length, 2);
  assert.deepEqual(acked, ['t1', 't2']);              // ack both
  assert.deepEqual(res, { enqueued: 2, acked: 2, late: 1 }); // t1 due 40m ago = late
});

test('acks ONLY what enqueued — enqueue failure never acks that item', async () => {
  let acked = null;
  const res = await pollOnce(base({
    getLocalFollowups: async () => ({ followups: [
      { taskId: 't1', profileId: 'accA', leadUrl: 'la', body: 'b', dueAt: null },
      { taskId: 't2', profileId: 'accB', leadUrl: 'lb', body: 'b2', dueAt: null },
    ] }),
    buildFollowUpTask: (a) => ({ id: a.leadUrl }),
    enqueuePrimaryTask: async (t) => { if (t.id === 'lb') throw new Error('disk full'); return t; },
    ackLocalFollowups: async (ids) => { acked = ids; return { delegated: ids.length }; },
  }));
  assert.deepEqual(acked, ['t1']);                    // t2 failed to enqueue → not acked
  assert.equal(res.enqueued, 1);
});

test('no operator email → does not call the engine', async () => {
  let called = false;
  const res = await pollOnce(base({
    getOperatorEmail: () => '',
    getLocalFollowups: async () => { called = true; return { followups: [] }; },
  }));
  assert.equal(called, false);
  assert.deepEqual(res, { enqueued: 0, acked: 0, late: 0 });
});

test('engine error / empty → no-op, no ack', async () => {
  let ackCalled = false;
  const res = await pollOnce(base({
    getLocalFollowups: async () => ({ error: 'HTTP 500' }),
    ackLocalFollowups: async () => { ackCalled = true; return {}; },
  }));
  assert.equal(ackCalled, false);
  assert.deepEqual(res, { enqueued: 0, acked: 0, late: 0 });
});
