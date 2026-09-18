import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'ortus-picker-roster-'));
process.env.ORTUS_DATA_DIR = root;
process.env.ORTUS_ENGINE_ENVIRONMENT = 'preview';
process.env.ORTUS_PREVIEW_PR = '19';
delete process.env.GOLOGIN_REQUEST_PACING;
const token = 'fixture-ortus-token';
process.env.GOLOGIN_API_TOKEN = token;
delete process.env.GOLOGIN_API_TOKEN_LINKEDVELOCITY;
delete process.env.GOLOGIN_API_TOKEN_MARKETING;
const originalFetch = globalThis.fetch;
const snapshot = await import('../src/gologin-roster-snapshot.js');
const { getProfilesForPicker, getProfiles, fetchAccountProfiles, clearProfileCache } = await import('../src/gologin-launcher.js');
const credential = JSON.stringify({ environment: 'preview', preview: '19', accounts: [['ortus', token]] });
const profiles = [{ id: 'profile-one', name: 'One', account: 'ortus', notes: 'not-for-disk' }];
after(() => {
  globalThis.fetch = originalFetch;
  rmSync(root, { recursive: true, force: true });
});

test('verified roster snapshot stores no token or notes and rejects changed credentials or expired data', () => {
  assert.equal(snapshot.saveRosterSnapshot(root, 'picker', credential, profiles), true);
  const file = join(root, 'gologin-roster-picker.json');
  const disk = readFileSync(file, 'utf8');
  assert.ok(!disk.includes(token));
  assert.ok(!disk.includes('not-for-disk'));
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(snapshot.readRosterSnapshot(root, 'picker', credential).profiles[0].id, 'profile-one');
  assert.equal(snapshot.readRosterSnapshot(root, 'picker', 'changed-token'), null);
  assert.equal(snapshot.readRosterSnapshot(root, 'picker', JSON.stringify({ environment: 'production', preview: '', accounts: [['ortus', token]] })), null);
  assert.equal(snapshot.readRosterSnapshot(root, 'picker', credential, { now: Date.now() + 25 * 60 * 60 * 1000 }), null);
});

test('a fresh saved picker roster survives process-cache clearing without GoLogin calls', async () => {
  clearProfileCache();
  globalThis.fetch = () => { throw new Error('GoLogin must not be contacted for a fresh saved roster'); };
  const result = await getProfilesForPicker();
  assert.equal(result.source, 'cached');
  assert.deepEqual(result.profiles.map(p => p.id), ['profile-one']);
});

test('an older verified roster displays immediately; a forced 429 preserves it while strict lookup fails closed', async () => {
  clearProfileCache();
  snapshot.saveRosterSnapshot(root, 'picker', credential, profiles, Date.now() - snapshot.PICKER_ROSTER_FRESH_MS - 1000);
  let calls = 0;
  globalThis.fetch = async () => { calls++; return { ok: false, status: 429, headers: new Headers({ 'retry-after': '121' }) }; };
  const saved = await getProfilesForPicker();
  assert.equal(saved.source, 'stale');
  assert.equal(calls, 0);
  const result = await getProfilesForPicker({ forceRefresh: true });
  assert.equal(result.source, 'limited');
  assert.deepEqual(result.profiles.map(p => p.id), ['profile-one']);
  assert.equal(calls, 1);
  const immediateRetry = await getProfilesForPicker({ forceRefresh: true });
  assert.equal(immediateRetry.source, 'cooldown');
  assert.equal(calls, 1);
  await assert.rejects(getProfiles(), /GoLogin HTTP 429/);
});

test('without a verified snapshot, a 429 remains an honest error', async () => {
  clearProfileCache();
  process.env.GOLOGIN_API_TOKEN = 'different-token';
  try {
    globalThis.fetch = async () => ({ ok: false, status: 429, headers: new Headers({ 'retry-after': '121' }) });
    await assert.rejects(getProfilesForPicker(), /GoLogin HTTP 429/);
  } finally {
    process.env.GOLOGIN_API_TOKEN = token;
  }
});

test('a failed secondary workspace is shown as partial, never saved as a complete roster', async () => {
  clearProfileCache();
  process.env.GOLOGIN_API_TOKEN_LINKEDVELOCITY = 'fixture-lv-token';
  try {
    globalThis.fetch = async (_url, options) => {
      const auth = options.headers.Authorization;
      if (auth === `Bearer ${token}`) return { ok: true, json: async () => ({ allProfilesCount: 1,
        profiles: [{ id: 'ortus-only', name: 'Ortus Only' }] }) };
      return { ok: false, status: 429, headers: new Headers({ 'retry-after': '121' }) };
    };
    const result = await getProfilesForPicker();
    assert.equal(result.source, 'partial');
    assert.deepEqual(result.profiles.map(p => p.id), ['ortus-only']);
    const bothTokens = JSON.stringify({ environment: 'preview', preview: '19',
      accounts: [['ortus', token], ['linkedvelocity', 'fixture-lv-token']] });
    assert.equal(snapshot.readRosterSnapshot(root, 'picker', bothTokens), null);
  } finally {
    delete process.env.GOLOGIN_API_TOKEN_LINKEDVELOCITY;
  }
});

test('read-only pagination waits after 429 and resumes the same page without repeating prior pages', async () => {
  const pages = [];
  const waits = [];
  let pageTwoAttempts = 0;
  globalThis.fetch = async url => {
    const page = Number(new URL(url).searchParams.get('page'));
    pages.push(page);
    if (page === 2 && pageTwoAttempts++ === 0) return { ok: false, status: 429, headers: new Headers() };
    return { ok: true, json: async () => ({ allProfilesCount: 2,
      profiles: [{ id: `id-${page}`, name: `Profile ${page}` }] }) };
  };
  const result = await fetchAccountProfiles('ortus', token, { waitOnRateLimit: async ms => waits.push(ms) });
  assert.deepEqual(pages, [1, 2, 2]);
  assert.deepEqual(waits, [60_000]);
  assert.deepEqual(result.map(p => p.id), ['id-1', 'id-2']);
});

test('read-only pagination stops after three 429 pauses', async () => {
  let calls = 0;
  const waits = [];
  globalThis.fetch = async () => { calls++; return { ok: false, status: 429, headers: new Headers() }; };
  await assert.rejects(fetchAccountProfiles('ortus', token, { waitOnRateLimit: async ms => waits.push(ms) }), /GoLogin HTTP 429/);
  assert.equal(calls, 4);
  assert.deepEqual(waits, [60_000, 60_000, 60_000]);
});

test('an incomplete profile list is rejected instead of saved as a complete roster', async () => {
  globalThis.fetch = async url => {
    const page = Number(new URL(url).searchParams.get('page'));
    return { ok: true, json: async () => ({ allProfilesCount: 2,
      profiles: page === 1 ? [{ id: 'id-1', name: 'One' }] : [] }) };
  };
  await assert.rejects(fetchAccountProfiles('ortus', token), /ended early/);
});

test('a small terminal count mismatch accepts the accessible 501 of 503 profiles', async () => {
  globalThis.fetch = async url => {
    const page = Number(new URL(url).searchParams.get('page'));
    const start = (page - 1) * 30;
    const count = Math.max(0, Math.min(30, 501 - start));
    return { ok: true, json: async () => ({ allProfilesCount: 503,
      profiles: Array.from({ length: count }, (_, i) => ({ id: `id-${start + i}`, name: `Profile ${start + i}` })) }) };
  };
  const result = await fetchAccountProfiles('ortus', token);
  assert.equal(result.length, 501);
  assert.equal(result[500].id, 'id-500');
});
