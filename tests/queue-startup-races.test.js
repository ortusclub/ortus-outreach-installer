import test from 'node:test';
import assert from 'node:assert/strict';
import { createQueueStore } from '../src/queue-store.js';

test('cold reads and additions serialize without stale cache replacement', async () => {
  let release, reads = 0, disk = [];
  const gate = new Promise(r => { release = r; });
  const store = createQueueStore({ read: async () => { reads++; await gate; return []; }, write: async q => { disk = structuredClone(q); } });
  const first = store.getQueue();
  const add = store.addToQueue({ name: 'A' }, 'operator');
  const last = store.getQueue();
  release();
  assert.deepEqual(await first, []);
  await add;
  assert.equal((await last)[0].name, 'A');
  assert.equal(reads, 1);
  assert.equal(disk.length, 1);
});

test('failed writes do not publish phantom additions and lane recovers', async () => {
  let fail = true;
  const store = createQueueStore({ read: async () => [], write: async () => { if (fail) throw new Error('disk full'); } });
  await assert.rejects(store.addToQueue({ name: 'failed' }), /disk full/);
  assert.deepEqual(await store.getQueue(), []);
  fail = false;
  await store.addToQueue({ name: 'good' });
  assert.equal((await store.getQueue())[0].name, 'good');
});

test('concurrent pops are unique and returned configs cannot mutate stored work', async () => {
  const store = createQueueStore({ read: async () => [], write: async () => {} });
  const entry = await store.addToQueue({ name: 'A', nested: { value: 1 } });
  entry.config.nested.value = 9;
  const snapshot = await store.getQueue();
  assert.equal(snapshot[0].config.nested.value, 1);
  snapshot[0].config.name = 'changed';
  const results = await Promise.all([store.popNextReady(), store.popNextReady()]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(results[0].config.name, 'A');
});

test('duplicate reorder ids cannot duplicate one campaign and erase another', async () => {
  const store = createQueueStore({ read: async () => [], write: async () => {} });
  const a = await store.addToQueue({ name: 'A' });
  await store.addToQueue({ name: 'B' });
  assert.equal((await store.reorderQueue([a.id, a.id])).ok, false);
  assert.deepEqual((await store.getQueue()).map(e => e.name), ['A', 'B']);
});

test('corrupt queue fails closed rather than silently becoming an empty queue', async () => {
  const store = createQueueStore({ read: async () => { throw new SyntaxError('corrupt'); }, write: async () => assert.fail('must not overwrite') });
  await assert.rejects(store.addToQueue({}), /corrupt/);
});

test('durable launch claim survives restart and is not replayed automatically', async () => {
  let disk = [];
  const options = { read: async () => structuredClone(disk), write: async q => { disk = structuredClone(q); } };
  const store = createQueueStore(options);
  const entry = await store.addToQueue({ name: 'A' });
  assert.equal((await store.claimNextReady()).id, entry.id);
  const restarted = createQueueStore(options);
  assert.equal(await restarted.claimNextReady(), null);
  assert.equal((await restarted.getQueue()).length, 1);
  // Only a launch proven refused may release the claim for retry.
  await restarted.releaseQueueClaim(entry.id);
  assert.equal((await restarted.claimNextReady()).id, entry.id);
});
