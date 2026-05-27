// Tests for the lastEditedAt timestamp + getMostRecentDraft helper added in the
// drafts-isolation refactor (2026-05-27 plan, Task 1).
//
// drafts.js is async (fs/promises) and caches state in module scope. Each test
// gets its own data dir via ORTUS_DATA_DIR + a unique ESM cache-buster on the
// import URL so the module re-evaluates fresh. paths.js also caches its ROOT
// at import time, so it's bust-imported alongside.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TEST_DATA_DIR = path.join(os.tmpdir(), 'ortus-drafts-test-' + process.pid + '-' + Math.random().toString(36).slice(2, 8));

beforeEach(() => {
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  process.env.ORTUS_DATA_DIR = TEST_DATA_DIR;
});
afterEach(() => {
  delete process.env.ORTUS_DATA_DIR;
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

async function freshImport() {
  const stamp = Date.now() + '_' + Math.random().toString(36).slice(2, 10);
  // Bust both modules — paths.js resolves ROOT at import time.
  await import('../src/paths.js?lastEdited=' + stamp);
  return import('../src/drafts.js?lastEdited=' + stamp);
}

test('addDraft sets lastEditedAt to current time', async () => {
  const { addDraft } = await freshImport();
  const before = Date.now();
  const entry = await addDraft({ name: 'X', config: {} });
  const after = Date.now();
  const t = new Date(entry.lastEditedAt).getTime();
  assert.ok(t >= before && t <= after, `lastEditedAt ${t} not in [${before}, ${after}]`);
});

test('updateDraft bumps lastEditedAt', async () => {
  const { addDraft, updateDraft } = await freshImport();
  const entry = await addDraft({ name: 'X', config: {} });
  const initial = new Date(entry.lastEditedAt).getTime();
  await new Promise((res) => setTimeout(res, 10));
  const updated = await updateDraft(entry.id, { name: 'X-renamed' });
  const after = new Date(updated.lastEditedAt).getTime();
  assert.ok(after > initial, `updated ${after} should be > initial ${initial}`);
});

test('getMostRecentDraft returns the most recently edited', async () => {
  const { addDraft, updateDraft, getMostRecentDraft } = await freshImport();
  const a = await addDraft({ name: 'A', config: {} });
  await new Promise((res) => setTimeout(res, 5));
  await addDraft({ name: 'B', config: {} });
  await new Promise((res) => setTimeout(res, 5));
  await updateDraft(a.id, { name: 'A-updated' }); // now A is most recent
  const recent = await getMostRecentDraft();
  assert.strictEqual(recent && recent.id, a.id);
});

test('getMostRecentDraft returns null if no drafts', async () => {
  const { getMostRecentDraft } = await freshImport();
  assert.strictEqual(await getMostRecentDraft(), null);
});

test('getDraft on an existing draft includes lastEditedAt', async () => {
  const { addDraft, getDraft } = await freshImport();
  const entry = await addDraft({ name: 'X', config: {} });
  const fetched = await getDraft(entry.id);
  assert.ok(fetched && fetched.lastEditedAt, 'expected lastEditedAt on fetched draft');
});
