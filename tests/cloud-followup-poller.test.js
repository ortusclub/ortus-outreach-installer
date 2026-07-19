// tests/cloud-followup-poller.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pollOnce } from '../src/cloud-followup-poller.js';

const NOW = 1_700_000_000_000;
// In-memory drained store shared across a test's polls (mirrors the durable file).
function mkStore(init = []) {
  let ids = [...init];
  return {
    loadDrained: async () => [...ids],
    saveDrained: async (next) => { ids = [...next]; },
    get: () => ids,
  };
}
const base = (over = {}) => ({
  getOperatorEmail: () => 'o@test',
  now: () => NOW,
  log: () => {},
  ...over,
});

test('maps engine follow-ups → buildFollowUpTask, enqueues, acks both, counts late, maps sheetId', async () => {
  const built = [];
  const enqueued = [];
  let acked = null;
  const store = mkStore();
  const res = await pollOnce(base({
    ...store,
    getLocalFollowups: async () => ({ followups: [
      { taskId: 't1', profileId: 'accA', sheetUrl: 'https://docs.google.com/spreadsheets/d/SHEET123/edit#gid=0', threadUrl: 'th', introTitle: 'it', leadName: 'A', leadUrl: 'la', primaryName: 'P', primaryUrl: 'pu', body: 'b', dueAt: new Date(NOW - 40 * 60_000).toISOString() },
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
  assert.equal(built[0].sheetId, 'SHEET123');         // extracted from the sheet URL
  assert.equal(built[0].sheetUrl, 'https://docs.google.com/spreadsheets/d/SHEET123/edit#gid=0');
  assert.equal(enqueued.length, 2);
  assert.deepEqual(acked, ['t1', 't2']);
  assert.deepEqual(res, { enqueued: 2, acked: 2, late: 1 });
  assert.deepEqual(store.get().sort(), ['t1', 't2']); // both persisted as drained
});

test('re-offered (already-drained) follow-up is re-acked but NEVER re-enqueued — no double-send', async () => {
  const enqueued = [];
  let acked = null;
  const store = mkStore(['t1']); // t1 already sent in a prior poll (ack was lost)
  const res = await pollOnce(base({
    ...store,
    getLocalFollowups: async () => ({ followups: [
      { taskId: 't1', profileId: 'accA', leadUrl: 'la', body: 'b', dueAt: null },
      { taskId: 't2', profileId: 'accB', leadUrl: 'lb', body: 'b2', dueAt: null },
    ] }),
    buildFollowUpTask: (a) => ({ id: a.leadUrl }),
    enqueuePrimaryTask: async (t) => { enqueued.push(t); return t; },
    ackLocalFollowups: async (ids) => { acked = ids; return { delegated: ids.length }; },
  }));
  assert.deepEqual(enqueued.map((t) => t.id), ['lb']); // ONLY t2 enqueued; t1 skipped
  assert.deepEqual(acked, ['t1', 't2']);               // both acked (t1 re-acked to stop re-offers)
  assert.equal(res.enqueued, 1);
});

test('acks ONLY what enqueued — enqueue failure never acks nor marks drained', async () => {
  let acked = null;
  const store = mkStore();
  const res = await pollOnce(base({
    ...store,
    getLocalFollowups: async () => ({ followups: [
      { taskId: 't1', profileId: 'accA', leadUrl: 'la', body: 'b', dueAt: null },
      { taskId: 't2', profileId: 'accB', leadUrl: 'lb', body: 'b2', dueAt: null },
    ] }),
    buildFollowUpTask: (a) => ({ id: a.leadUrl }),
    enqueuePrimaryTask: async (t) => { if (t.id === 'lb') throw new Error('disk full'); return t; },
    ackLocalFollowups: async (ids) => { acked = ids; return { delegated: ids.length }; },
  }));
  assert.deepEqual(acked, ['t1']);        // t2 failed → not acked
  assert.deepEqual(store.get(), ['t1']);  // t2 NOT marked drained (so it re-offers + retries)
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
