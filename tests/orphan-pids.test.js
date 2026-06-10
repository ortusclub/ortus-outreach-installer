import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectOrphanPids } from '../src/gologin-launcher.js';

test('orphan = spawned + alive + NOT active', () => {
  const spawned = new Map([['p1', 101], ['p2', 102], ['p3', 103]]);
  const activePids = new Set([101]);            // p1 still tracked-active
  const isAlive = (pid) => pid !== 102;          // p2 already dead
  // p1 active → skip; p2 dead → skip; p3 alive + not active → orphan
  assert.deepEqual(selectOrphanPids({ spawned, activePids, isAlive }), [103]);
});

test('no orphans when all spawned are active or dead', () => {
  const spawned = new Map([['p1', 101], ['p2', 102]]);
  assert.deepEqual(selectOrphanPids({ spawned, activePids: new Set([101]), isAlive: (p) => p === 101 }), []);
});

test('ignores null/undefined pids', () => {
  const spawned = new Map([['p1', null], ['p2', undefined]]);
  assert.deepEqual(selectOrphanPids({ spawned, activePids: new Set(), isAlive: () => true }), []);
});
