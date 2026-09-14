import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { resolve } from 'node:path';
import { updateJsonAtomic } from './atomic-json-store.js';

const snapshots = new WeakMap();
async function readStrict(file) {
  let value;
  try { value = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Schedule must be an object');
  return value;
}
export async function readScheduleSnapshot(file) {
  const value = await readStrict(file);
  snapshots.set(value, structuredClone(value));
  return value;
}
export async function saveScheduleSnapshot(file, next) {
  const before = snapshots.get(next);
  if (!before) throw new Error('Schedule write requires its original snapshot');
  await updateJsonAtomic(resolve(file), {}, async () => {
    const current = await readStrict(file);
    for (const key of new Set([...Object.keys(before), ...Object.keys(next)])) {
      if (isDeepStrictEqual(before[key], next[key]) || !isDeepStrictEqual(before[key], current[key])) continue;
      if (Object.hasOwn(next, key)) current[key] = next[key];
      else delete current[key];
    }
    return current;
  });
}
