import test from 'node:test';
import assert from 'node:assert/strict';
import { guardSdkStartup } from '../src/sdk-startup-control.js';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
test('stop during SDK preparation prevents the future browser spawn', async () => {
  const gate = deferred(); let spawns = 0;
  const sdk = { processSpawned: null, async start() { await gate.promise; return this.spawnBrowser(); }, async spawnBrowser() { spawns++; return {}; } };
  const controller = new AbortController();
  const control = guardSdkStartup(sdk, { signal: controller.signal });
  await Promise.resolve(); controller.abort(new Error('stop'));
  await assert.rejects(control.promise, /stop/);
  assert.equal((await control.close()).spawnPrevented, true);
  gate.resolve(); await assert.rejects(control.source);
  assert.equal(spawns, 0);
});
test('a spawn already in progress remains unconfirmed and its late child is killed', async () => {
  const gate = deferred(), entered = deferred(); let kills = 0;
  const sdk = { processSpawned: null, async start() { return this.spawnBrowser(); }, async spawnBrowser() { entered.resolve(); await gate.promise; this.processSpawned = { pid: 7 }; return {}; } };
  const control = guardSdkStartup(sdk, { kill: () => kills++ });
  await entered.promise; control.cancel(new Error('stop'));
  await assert.rejects(control.promise, /stop/);
  assert.equal((await control.close()).browserClosed, false);
  gate.resolve(); await assert.rejects(control.source);
  assert.ok(kills > 0);
  assert.equal((await control.close(async () => ({ browserClosed: true }))).browserClosed, true);
});
test('timeout cancellation also prevents late startup; ordinary success is untouched', async () => {
  let spawns = 0;
  const sdk = { processSpawned: null, async start() { return this.spawnBrowser(); }, async spawnBrowser() { spawns++; return { status: 'success' }; } };
  const control = guardSdkStartup(sdk);
  assert.equal((await control.promise).status, 'success'); assert.equal(spawns, 1); control.detach();
});
