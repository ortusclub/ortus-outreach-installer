import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readScheduleSnapshot, saveScheduleSnapshot } from '../src/schedule-snapshot-store.js';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'ortus-schedule-cas-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'schedules.json');
  await writeFile(file, JSON.stringify({ a: { owner: 'a', lastCheckedAt: 1 }, b: { owner: 'b' } }));
  return file;
}

test('a late tick cannot resurrect a schedule removed by Stop', async t => {
  const file = await fixture(t);
  const tick = await readScheduleSnapshot(file), stop = await readScheduleSnapshot(file);
  delete stop.a;
  await saveScheduleSnapshot(file, stop);
  tick.a.lastCheckedAt = 2;
  await saveScheduleSnapshot(file, tick);
  assert.deepEqual(await readScheduleSnapshot(file), { b: { owner: 'b' } });
});

test('unrelated registrations and tick updates survive concurrent saves', async t => {
  const file = await fixture(t);
  const tick = await readScheduleSnapshot(file), registration = await readScheduleSnapshot(file);
  tick.a.lastCheckedAt = 2;
  registration.c = { owner: 'c' };
  await Promise.all([saveScheduleSnapshot(file, tick), saveScheduleSnapshot(file, registration)]);
  assert.deepEqual(await readScheduleSnapshot(file), { a: { owner: 'a', lastCheckedAt: 2 }, b: { owner: 'b' }, c: { owner: 'c' } });
});

test('Stop with an old snapshot cannot delete another run’s replacement', async t => {
  const file = await fixture(t);
  const stop = await readScheduleSnapshot(file), replacement = await readScheduleSnapshot(file);
  delete stop.a;
  replacement.a = { owner: 'new-run' };
  await saveScheduleSnapshot(file, replacement);
  await saveScheduleSnapshot(file, stop);
  assert.equal((await readScheduleSnapshot(file)).a.owner, 'new-run');
});

test('corrupt schedule reads fail closed', async t => {
  const file = await fixture(t);
  await writeFile(file, 'corrupt');
  await assert.rejects(readScheduleSnapshot(file));
});
