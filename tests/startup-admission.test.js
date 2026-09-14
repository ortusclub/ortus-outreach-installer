import test from 'node:test';
import assert from 'node:assert/strict';
import { createStartupAdmission } from '../src/startup-admission.js';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('parallel preparation is refused; a nested queue drain belongs to its request', async () => {
  const gate = createStartupAdmission(), wait = deferred();
  const first = gate.enter(async release => {
    try { await wait.promise; gate.assertCurrent(); gate.enter(done => done()); }
    finally { release(); }
  });
  assert.equal(gate.available(), false);
  assert.throws(() => gate.enter(() => {}), /Another operation/);
  wait.resolve(); await first;
  assert.equal(gate.available(), true);
});

test('Stop invalidates pending preparation even when it eventually succeeds', async () => {
  const gate = createStartupAdmission(), wait = deferred();
  const first = gate.enter(async release => {
    try { await wait.promise; gate.assertCurrent(); }
    finally { release(); }
  });
  gate.cancel(); wait.resolve();
  await assert.rejects(first, /cancelled/);
  assert.equal(gate.available(), true);
});

test('boot blocks admission, and a late boot completion cannot undo shutdown', () => {
  const gate = createStartupAdmission();
  gate.setReady(false); assert.equal(gate.available(), false);
  gate.close(); gate.setReady(true); assert.equal(gate.available(), false);
});
