// tests/campaigns-client-primaryconn.test.js
//
// The cloud engine keys connection-to-primary state per CAMPAIGN, so a fresh
// CC+IC campaign forgets that these accounts already connected to that same
// person in an earlier run. This machine remembers (primary-status.json is keyed
// per account+primary), so the launch payload carries the remembered CONNECTED
// accounts along and the engine seeds them at create time.
//
// These tests pin the wire contract only: what leaves this machine. The engine
// side (what it does with the seed, and never seeding a guess) is covered by
// test-campaign-primaryconn-seed.js in the engine repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startCloudCampaign } from '../src/campaigns-client.js';

const LEADS = [{ leadUrl: 'https://www.linkedin.com/in/lead-one' }];

// Stub fetch, capture the outgoing body, stay offline.
async function capture(payload) {
  const origFetch = globalThis.fetch;
  let body = null;
  globalThis.fetch = async (_url, opts) => {
    body = opts?.body ? JSON.parse(opts.body) : null;
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'c1', leadsAdded: 1 }) };
  };
  try { await startCloudCampaign(payload); } finally { globalThis.fetch = origFetch; }
  return body;
}

const base = {
  mode: 'connect_and_introduce', name: 'CC+IC', owner: 'op@ortus.solutions',
  profileIds: ['gl_a', 'gl_b'], leads: LEADS,
};

test('remembered connections ride along with the launch', async () => {
  const body = await capture({ ...base, primaryConn: { gl_a: 'connected' } });
  assert.deepEqual(body.primaryConn, { gl_a: 'connected' });
});

test('the field is OMITTED when there is nothing to seed', async () => {
  // An empty object would be indistinguishable from "I checked and none are
  // connected". Absent means "no claim" — the engine then reports null per
  // account, and the panel shows no badge instead of asserting a negative.
  for (const primaryConn of [undefined, null, {}]) {
    const body = await capture({ ...base, primaryConn });
    assert.ok(!('primaryConn' in body), `omitted for ${JSON.stringify(primaryConn)}`);
  }
});

test('seeding never disturbs the rest of the launch payload', async () => {
  const body = await capture({ ...base, dailyLimit: 35, sheetUrl: 'https://sheet', primaryConn: { gl_a: 'connected' } });
  assert.equal(body.mode, 'connect_and_introduce');
  assert.deepEqual(body.profileIds, ['gl_a', 'gl_b']);
  assert.equal(body.dailyLimit, 35);
  assert.equal(body.sheetUrl, 'https://sheet');
  assert.equal(body.leads.length, 1);
});
