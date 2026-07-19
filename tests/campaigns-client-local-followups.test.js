// tests/campaigns-client-local-followups.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getLocalFollowups, ackLocalFollowups } from '../src/campaigns-client.js';

// SCRAPER_ENGINE_URL is hardcoded — stub fetch to stay offline + deterministic.

test('getLocalFollowups GETs /api/local-followups with the owner encoded + Bearer', async () => {
  const origFetch = globalThis.fetch;
  let sawUrl = null, sawMethod = null, sawAuth = null;
  globalThis.fetch = async (url, opts) => {
    sawUrl = url; sawMethod = opts?.method; sawAuth = opts?.headers?.Authorization;
    return { ok: true, status: 200, text: async () => JSON.stringify({ followups: [{ taskId: 1 }] }) };
  };
  try {
    const r = await getLocalFollowups('a b@ortus.test');
    assert.equal(sawMethod, 'GET');
    assert.match(sawUrl, /\/api\/local-followups\?owner=a%20b%40ortus\.test$/);
    assert.match(sawAuth || '', /^Bearer /);
    assert.deepEqual(r, { followups: [{ taskId: 1 }] });
  } finally { globalThis.fetch = origFetch; }
});

test('ackLocalFollowups POSTs taskIds to /api/local-followups/ack', async () => {
  const origFetch = globalThis.fetch;
  let sawUrl = null, sawMethod = null, sawBody = null;
  globalThis.fetch = async (url, opts) => {
    sawUrl = url; sawMethod = opts?.method; sawBody = opts?.body ? JSON.parse(opts.body) : null;
    return { ok: true, status: 200, text: async () => JSON.stringify({ delegated: 2 }) };
  };
  try {
    const r = await ackLocalFollowups(['t1', 't2']);
    assert.equal(sawMethod, 'POST');
    assert.match(sawUrl, /\/api\/local-followups\/ack$/);
    assert.deepEqual(sawBody, { taskIds: ['t1', 't2'] });
    assert.deepEqual(r, { delegated: 2 });

    await ackLocalFollowups(undefined); // non-array → []
    assert.deepEqual(sawBody, { taskIds: [] });
  } finally { globalThis.fetch = origFetch; }
});

test('getLocalFollowups never throws — transport failure → { error }', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('offline'); };
  try {
    const r = await getLocalFollowups('o@test');
    assert.equal(r.error, 'offline');
  } finally { globalThis.fetch = origFetch; }
});
