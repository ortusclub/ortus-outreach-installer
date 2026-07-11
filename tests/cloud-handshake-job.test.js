import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startHandshakeJob, getHandshakeJob, resetHandshakeJob } from '../src/cloud-handshake-job.js';

const tick = () => new Promise((r) => setTimeout(r, 5));

test('rejects empty senderProfileIds with 400', () => {
  resetHandshakeJob();
  const r = startHandshakeJob({ senderProfileIds: [], primaryUrl: 'https://linkedin.com/in/p' }, { run: async () => ({}) });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
});

test('rejects missing primaryUrl with 400', () => {
  resetHandshakeJob();
  const r = startHandshakeJob({ senderProfileIds: ['a'] }, { run: async () => ({}) });
  assert.equal(r.status, 400);
});

test('starts, streams progress into the snapshot, and finishes with the summary', async () => {
  resetHandshakeJob();
  const run = async ({ onProgress }) => {
    onProgress({ profileId: 'a', state: 'connecting' });
    onProgress({ profileId: 'a', state: 'sent', name: 'Alice' });
    onProgress({ profileId: 'a', state: 'connected' });
    return { ok: true, connected: 1, accepted: 1, pending: 0, senders: [{ profileId: 'a', state: 'connected' }] };
  };
  const r = startHandshakeJob({ senderProfileIds: ['a'], primaryUrl: 'https://linkedin.com/in/p' }, { run });
  assert.equal(r.status, 200);
  assert.equal(r.started, true);
  await tick();
  const snap = getHandshakeJob();
  assert.equal(snap.active, true);
  assert.equal(snap.done, true);
  assert.equal(snap.summary.connected, 1);
  assert.equal(snap.senders[0].state, 'connected');
  assert.equal(snap.senders[0].name, 'Alice');
});

test('a second start while running returns 409', async () => {
  resetHandshakeJob();
  let release;
  const gate = new Promise((r) => { release = r; });
  const run = async () => { await gate; return { ok: true }; };
  const r1 = startHandshakeJob({ senderProfileIds: ['a'], primaryUrl: 'https://linkedin.com/in/p' }, { run });
  assert.equal(r1.status, 200);
  const r2 = startHandshakeJob({ senderProfileIds: ['b'], primaryUrl: 'https://linkedin.com/in/p' }, { run });
  assert.equal(r2.status, 409);
  release();
  await tick();
  // once finished, a new one is accepted
  const r3 = startHandshakeJob({ senderProfileIds: ['c'], primaryUrl: 'https://linkedin.com/in/p' }, { run: async () => ({ ok: true }) });
  assert.equal(r3.status, 200);
  await tick();
});

test('run rejection is captured as job error, not an unhandled rejection', async () => {
  resetHandshakeJob();
  const run = async () => { throw new Error('boom'); };
  startHandshakeJob({ senderProfileIds: ['a'], primaryUrl: 'https://linkedin.com/in/p' }, { run });
  await tick();
  const snap = getHandshakeJob();
  assert.equal(snap.done, true);
  assert.equal(snap.error, 'boom');
});
