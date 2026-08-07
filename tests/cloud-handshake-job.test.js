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

// The Path A handshake used to run completely silent: startHandshakeJob never
// passed a `log` to runCloudPreflightHandshake, whose default is `() => {}`. So
// when an operator asked "did all four senders actually send a request to the
// primary?" there was no record anywhere to answer from — only
// data/primary-status.json, written at the very end. These pin the narration.
test('the handshake narrates itself — start, each transition, and the outcome', async () => {
  resetHandshakeJob();
  const run = async ({ onProgress, log }) => {
    assert.equal(typeof log, 'function', 'run() must be given a log — a silent handshake is unauditable');
    onProgress({ profileId: 'a', state: 'connecting', name: 'Alice' });
    onProgress({ profileId: 'a', state: 'connecting' });   // repeat → must not re-log
    onProgress({ profileId: 'a', state: 'sent' });
    return { ok: true, connected: 0, accepted: 0, pending: 1, senders: [{ profileId: 'a', state: 'sent' }] };
  };
  startHandshakeJob({ senderProfileIds: ['a'], primaryUrl: 'https://linkedin.com/in/p' }, { run });
  await tick();
  const lines = getHandshakeJob().lines;
  assert.ok(lines.some((l) => l.includes('starting') && l.includes('1 sender')), lines.join('\n'));
  assert.equal(lines.filter((l) => l.includes('connecting')).length, 1, `repeat states must not spam the log:\n${lines.join('\n')}`);
  assert.ok(lines.some((l) => l.includes('Alice: sent')), lines.join('\n'));
  assert.ok(lines.some((l) => l.includes('done —') && l.includes('1 still pending')), lines.join('\n'));
});

test('a failed handshake says so in the log, not just in .error', async () => {
  resetHandshakeJob();
  startHandshakeJob(
    { senderProfileIds: ['a'], primaryUrl: 'https://linkedin.com/in/p' },
    { run: async () => { throw new Error('browser never opened'); } },
  );
  await tick();
  const snap = getHandshakeJob();
  assert.match(snap.error, /browser never opened/);
  assert.ok(snap.lines.some((l) => l.includes('FAILED') && l.includes('browser never opened')), snap.lines.join('\n'));
});
