import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  getProfiles,
  clearProfileCache,
  accountOfProfile,
  tokenForProfile,
} from '../src/gologin-launcher.js';

// getProfiles used to take a token and return an untagged list. It now walks
// every configured GoLogin account and tags each profile with its owner — which
// is what lets launchProfile pick the right token without any of its ~15 callers
// knowing there is more than one account. These cover that walk.

const ORTUS = 'tok-ortus';
const LV = 'tok-lv';

// Minimal stand-in for GoLogin's paged /browser/v2. One page per account is
// enough: paging is unchanged from the single-account version.
function mockGologin(byToken) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const token = String(init?.headers?.Authorization || '').replace('Bearer ', '');
    calls.push(token);
    const entry = byToken[token];
    if (!entry) return { ok: false, status: 401 };
    if (entry.throws) throw new Error(entry.throws);
    const page = Number(new URL(url).searchParams.get('page') || 1);
    const profiles = page === 1 ? entry.profiles : [];
    return {
      ok: true,
      status: 200,
      json: async () => ({ allProfilesCount: entry.profiles.length, profiles }),
    };
  };
  return calls;
}

function withAccounts(tokens, fn) {
  const saved = [process.env.GOLOGIN_API_TOKEN, process.env.GOLOGIN_API_TOKEN_LINKEDVELOCITY];
  const savedFetch = globalThis.fetch;
  if (tokens.ortus === undefined) delete process.env.GOLOGIN_API_TOKEN;
  else process.env.GOLOGIN_API_TOKEN = tokens.ortus;
  if (tokens.lv === undefined) delete process.env.GOLOGIN_API_TOKEN_LINKEDVELOCITY;
  else process.env.GOLOGIN_API_TOKEN_LINKEDVELOCITY = tokens.lv;
  clearProfileCache();
  return (async () => {
    try { return await fn(); }
    finally {
      globalThis.fetch = savedFetch;
      clearProfileCache();
      if (saved[0] === undefined) delete process.env.GOLOGIN_API_TOKEN; else process.env.GOLOGIN_API_TOKEN = saved[0];
      if (saved[1] === undefined) delete process.env.GOLOGIN_API_TOKEN_LINKEDVELOCITY; else process.env.GOLOGIN_API_TOKEN_LINKEDVELOCITY = saved[1];
    }
  })();
}

test('profiles from both workspaces come back in one list, each tagged', async () => {
  await withAccounts({ ortus: ORTUS, lv: LV }, async () => {
    mockGologin({
      [ORTUS]: { profiles: [{ id: 'o1', name: 'ortus-one' }] },
      [LV]: { profiles: [{ id: 'v1', name: 'lv-one' }, { id: 'v2', name: 'lv-two' }] },
    });

    const list = await getProfiles();
    assert.deepEqual(list.map((p) => [p.id, p.account]), [
      ['o1', 'ortus'], ['v1', 'linkedvelocity'], ['v2', 'linkedvelocity'],
    ]);
  });
});

test('the token that launches a profile is its own account\'s', async () => {
  await withAccounts({ ortus: ORTUS, lv: LV }, async () => {
    mockGologin({
      [ORTUS]: { profiles: [{ id: 'o1', name: 'ortus-one' }] },
      [LV]: { profiles: [{ id: 'v1', name: 'lv-one' }] },
    });

    // Cold: nothing listed yet. tokenForProfile must list rather than guess —
    // guessing is what would 404 every Linked Velocity launch after a restart.
    assert.equal(accountOfProfile('v1'), null);
    assert.equal(await tokenForProfile('v1'), LV);
    assert.equal(await tokenForProfile('o1'), ORTUS);
  });
});

test('an unknown profile falls back to the default account\'s token', async () => {
  await withAccounts({ ortus: ORTUS, lv: LV }, async () => {
    mockGologin({ [ORTUS]: { profiles: [] }, [LV]: { profiles: [] } });
    assert.equal(await tokenForProfile('never-seen'), ORTUS);
  });
});

test('a Linked Velocity outage does not blank the Ortus roster', async () => {
  await withAccounts({ ortus: ORTUS, lv: LV }, async () => {
    mockGologin({
      [ORTUS]: { profiles: [{ id: 'o1', name: 'ortus-one' }] },
      [LV]: { throws: 'ECONNRESET' },
    });

    const list = await getProfiles();
    assert.deepEqual(list.map((p) => p.id), ['o1']);
  });
});

test('an Ortus outage still throws — an empty picker there is a real outage', async () => {
  await withAccounts({ ortus: ORTUS, lv: LV }, async () => {
    mockGologin({ [ORTUS]: { throws: 'ECONNRESET' }, [LV]: { profiles: [{ id: 'v1', name: 'lv' }] } });
    await assert.rejects(() => getProfiles(), /ECONNRESET/);
  });
});

test('with only one token configured nothing extra is fetched', async () => {
  await withAccounts({ ortus: ORTUS, lv: undefined }, async () => {
    const calls = mockGologin({ [ORTUS]: { profiles: [{ id: 'o1', name: 'ortus-one' }] } });
    const list = await getProfiles();
    assert.deepEqual(list.map((p) => p.account), ['ortus']);
    assert.deepEqual([...new Set(calls)], [ORTUS], 'no call made for an unconfigured account');
  });
});

test('the cache is per account — a second call re-fetches neither', async () => {
  await withAccounts({ ortus: ORTUS, lv: LV }, async () => {
    const calls = mockGologin({
      [ORTUS]: { profiles: [{ id: 'o1', name: 'ortus-one' }] },
      [LV]: { profiles: [{ id: 'v1', name: 'lv-one' }] },
    });
    await getProfiles();
    const after = calls.length;
    await getProfiles();
    assert.equal(calls.length, after, 'second call served from cache');
  });
});
