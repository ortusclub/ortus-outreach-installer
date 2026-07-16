import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROSTER_FNS, rpcDispatch, dbCall } from '../src/connections/db-client.js';

test('ROSTER_FNS is exactly the five whitelisted reads', () => {
  assert.deepEqual([...ROSTER_FNS].sort(), [
    'buildLeadRows', 'exportConnections', 'getConnectionsStats',
    'listFgColleaguesMatched', 'searchConnections',
  ]);
});

test('rpcDispatch calls a whitelisted fn on the impl with spread args', () => {
  const impl = { searchConnections: (crit, opts) => ({ crit, opts }) };
  assert.deepEqual(rpcDispatch('searchConnections', [{ q: 1 }, { limit: 5 }], impl),
    { crit: { q: 1 }, opts: { limit: 5 } });
});

test('rpcDispatch throws on a non-whitelisted fn', () => {
  assert.throws(() => rpcDispatch('startConnectionsSync', [], { startConnectionsSync: () => 1 }),
    /unknown roster fn: startConnectionsSync/);
});

test('dbCall runs locally when hasLocal() is true and never fetches', async () => {
  let fetched = false;
  const out = await dbCall('getConnectionsStats', [], {
    hasLocal: () => true,
    local: { getConnectionsStats: () => ({ total: 42 }) },
    fetchImpl: () => { fetched = true; throw new Error('should not fetch'); },
  });
  assert.deepEqual(out, { total: 42 });
  assert.equal(fetched, false);
});

test('dbCall POSTs to central with Bearer and returns .result when hasLocal() is false', async () => {
  let seen;
  const out = await dbCall('searchConnections', [{ q: 1 }, { limit: 5 }], {
    hasLocal: () => false,
    rosterUrl: 'https://x/fg-roster',
    rosterToken: 'tok',
    fetchImpl: async (url, opts) => {
      seen = { url, opts };
      return { ok: true, status: 200, json: async () => ({ result: [{ email: 'a' }] }) };
    },
  });
  assert.deepEqual(out, [{ email: 'a' }]);
  assert.equal(seen.url, 'https://x/fg-roster/rpc');
  assert.equal(seen.opts.method, 'POST');
  assert.equal(seen.opts.headers.authorization, 'Bearer tok');
  assert.deepEqual(JSON.parse(seen.opts.body), { fn: 'searchConnections', args: [{ q: 1 }, { limit: 5 }] });
});

test('dbCall throws (fail-closed) on a non-2xx central response', async () => {
  await assert.rejects(() => dbCall('getConnectionsStats', [], {
    hasLocal: () => false,
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({ error: 'db not loaded' }) }),
  }), /roster getConnectionsStats failed: 503/);
});
