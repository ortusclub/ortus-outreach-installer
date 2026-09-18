import test from 'node:test';
import assert from 'node:assert/strict';
import { createManualProfileOpenControl } from '../src/manual-profile-open-control.js';

test('Stop aborts a manual launch and confirms closure without touching campaign work', async () => {
  const calls = [];
  let launchStarted;
  const started = new Promise(resolve => { launchStarted = resolve; });
  const control = createManualProfileOpenControl({
    resolve: async id => id,
    getPid: () => null,
    focus: async () => { throw new Error('must not focus'); },
    launch: async (id, signal, onOwnedStart) => {
      onOwnedStart();
      calls.push(['launch', id]);
      launchStarted();
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
    unhide: async () => { throw new Error('must not unhide'); },
    close: async id => { calls.push(['close', id]); return { browserClosed: true }; },
  });
  const opening = control.open('exact-profile');
  await started;
  assert.deepEqual(await control.cancel('exact-profile'), { ok: true, cancelled: true, browserClosed: true });
  await assert.rejects(opening, /cancelled/);
  assert.deepEqual(calls, [['launch', 'exact-profile'], ['close', 'exact-profile']]);
});

test('Stop before profile resolution prevents browser launch', async () => {
  let finishResolve;
  let launched = false;
  const control = createManualProfileOpenControl({
    resolve: () => new Promise(resolve => { finishResolve = resolve; }),
    getPid: () => null,
    focus: async () => {},
    launch: async () => { launched = true; },
    unhide: async () => {},
    close: async () => { throw new Error('nothing was spawned'); },
  });
  const opening = control.open('exact-profile');
  const cancelling = control.cancel('exact-profile');
  finishResolve('exact-profile');
  assert.equal((await cancelling).browserClosed, true);
  await assert.rejects(opening, /cancelled/);
  assert.equal(launched, false);
});

test('Stop never closes a browser that was already open', async () => {
  let finishFocus;
  let focusing;
  const focused = new Promise(resolve => { focusing = resolve; });
  let closed = false;
  const control = createManualProfileOpenControl({
    resolve: async id => id,
    getPid: () => 1234,
    focus: () => { focusing(); return new Promise(resolve => { finishFocus = resolve; }); },
    launch: async () => { throw new Error('must not launch'); },
    unhide: async () => {},
    close: async () => { closed = true; },
  });
  const opening = control.open('exact-profile');
  await focused;
  const stopping = control.cancel('exact-profile');
  finishFocus();
  assert.equal((await stopping).alreadyOpen, true);
  assert.equal((await opening).action, 'focused-existing');
  assert.equal(closed, false);
});

test('a conflicting campaign launch is never closed by manual Stop', async () => {
  let closed = false;
  const control = createManualProfileOpenControl({
    resolve: async id => id,
    getPid: () => null,
    focus: async () => {},
    launch: async () => { throw new Error('GoLogin profile launch is already in progress'); },
    unhide: async () => {},
    close: async () => { closed = true; return { browserClosed: true }; },
  });
  await assert.rejects(control.open('exact-profile'), /already in progress/);
  assert.equal(closed, false);
});
