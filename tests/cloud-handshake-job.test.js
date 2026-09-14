import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startHandshakeJob, getHandshakeJob, resetHandshakeJob, cancelHandshakeJob } from '../src/cloud-handshake-job.js';

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
    onProgress({ profileId: 'a', state: 'connecting', attempt: 1, maxAttempts: 2, deadlineAt: 123456 });
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
  assert.equal(snap.senders[0].attempt, 1);
  assert.equal(snap.senders[0].maxAttempts, 2);
  assert.equal(snap.senders[0].deadlineAt, 123456);
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

test('cancel aborts the underlying browser job, not only the UI', async () => {
  resetHandshakeJob();
  let receivedSignal;
  const run = ({ signal }) => new Promise((_resolve, reject) => {
    receivedSignal = signal;
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  startHandshakeJob({ senderProfileIds: ['a'], primaryUrl: 'https://linkedin.com/in/p' }, { run });
  await tick();
  const result = cancelHandshakeJob();
  assert.equal(result.cancelled, true);
  assert.equal(receivedSignal.aborted, true);
  const snap = getHandshakeJob();
  assert.equal(snap.done, true);
  assert.match(snap.error, /cancelled/i);
  assert.ok(snap.lines.some((line) => /STOP REQUESTED/.test(line)));
  await tick();
});

test('cancel/reset retains admission until old work settles and ignores late callbacks', async () => {
  resetHandshakeJob();
  let finish, callbacks;
  const run = opts => { callbacks = opts; return new Promise(r => { finish = r; }); };
  const body = { senderProfileIds: ['old'], primaryUrl: 'https://linkedin.com/in/p' };
  assert.equal(startHandshakeJob(body, { run }).status, 200);
  await tick();
  cancelHandshakeJob();
  assert.equal(getHandshakeJob().stopping, true);
  callbacks.onProgress({ profileId: 'old', state: 'connected' });
  assert.equal(getHandshakeJob().senders[0].state, 'pending');
  resetHandshakeJob();
  assert.equal(startHandshakeJob(body, { run }).status, 409);
  finish({});
  await tick();
  let finishNew;
  assert.equal(startHandshakeJob({ ...body, senderProfileIds: ['new'] }, { run: () => new Promise(r => { finishNew = r; }) }).status, 200);
  await tick();
  callbacks.onProgress({ profileId: 'old', state: 'connected' });
  callbacks.log('late old narration');
  assert.deepEqual(getHandshakeJob().senders.map(s => s.profileId), ['new']);
  assert.ok(!getHandshakeJob().lines.some(l => l.includes('late old')));
  finishNew({});
  await tick();
});

test('overall timeout aborts the underlying job and never offers an unsafe bypass', async () => {
  resetHandshakeJob();
  let receivedSignal;
  const run = ({ signal }) => new Promise((_resolve, reject) => {
    receivedSignal = signal;
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  startHandshakeJob(
    { senderProfileIds: ['a'], primaryUrl: 'https://linkedin.com/in/p' },
    { run, maxMs: 10 },
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  const snap = getHandshakeJob();
  assert.equal(receivedSignal.aborted, true);
  assert.equal(snap.done, true);
  assert.match(snap.error, /stopped.*did not respond.*No campaign was dispatched/i);
  assert.doesNotMatch(`${snap.error}\n${snap.lines.join('\n')}`, /dispatch anyway/i);
});
