import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateJsonAtomic, writeJsonAtomic, readJson } from '../src/atomic-json-store.js';

test('concurrent atomic updates are serialized without losing entries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ortus-atomic-'));
  const path = join(dir, 'history.json');
  await writeJsonAtomic(path, []);
  await Promise.all(Array.from({ length: 30 }, (_, id) =>
    updateJsonAtomic(path, [], (rows) => [...rows, { id }])));
  const rows = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(rows.length, 30);
  assert.deepEqual(new Set(rows.map((row) => row.id)), new Set(Array.from({ length: 30 }, (_, id) => id)));
});

test('a corrupt primary file recovers from the last known-good backup', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ortus-recovery-'));
  const path = join(dir, 'state.json');
  await writeJsonAtomic(path, { revision: 1 });
  await writeJsonAtomic(path, { revision: 2 });
  await writeFile(path, '{broken', 'utf8');
  assert.deepEqual(await readJson(path, {}), { revision: 1 });
});
