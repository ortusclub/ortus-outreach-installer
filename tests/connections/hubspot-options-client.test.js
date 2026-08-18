import test from 'node:test';
import assert from 'node:assert/strict';
import { connectionsProp, connectionsPropOptions, addConnectionsOptions, tokenScopes }
  from '../../src/connections/hubspot-client.js';

const opts = (...vals) => vals.map((v, i) => ({ label: v, value: v, displayOrder: i, hidden: false }));

// A stub HubSpot that holds the option list in memory and records every call.
function stubHubSpot(initial) {
  const calls = [];
  let current = initial.slice();
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    if (init.method === 'PATCH') {
      current = JSON.parse(init.body).options;
      return { ok: true, status: 200, json: async () => ({ options: current }) };
    }
    return { ok: true, status: 200, json: async () => ({ options: current }) };
  };
  return { fetchImpl, calls, now: () => current };
}

test('connectionsProp returns the raw options array', async () => {
  const hs = stubHubSpot(opts('a@ortus.solutions'));
  const p = await connectionsProp({ fetchImpl: hs.fetchImpl, token: 't' });
  assert.deepEqual(p.options, opts('a@ortus.solutions'));
});

test('connectionsPropOptions still returns a lowercased Set of values', async () => {
  const hs = stubHubSpot(opts('A@Ortus.Solutions', 'b@ortus.solutions'));
  const set = await connectionsPropOptions({ fetchImpl: hs.fetchImpl, token: 't' });
  assert.ok(set instanceof Set);
  assert.ok(set.has('a@ortus.solutions'));
  assert.ok(set.has('b@ortus.solutions'));
});

test('addConnectionsOptions reads, patches, then reads again to verify', async () => {
  const hs = stubHubSpot(opts('a@ortus.solutions'));
  const r = await addConnectionsOptions(['c@ortus.solutions'], { fetchImpl: hs.fetchImpl, token: 't' });
  assert.deepEqual(r.added, ['c@ortus.solutions']);
  assert.equal(r.total, 2);
  assert.deepEqual(hs.calls.map((c) => c.method), ['GET', 'PATCH', 'GET']);
});

test('addConnectionsOptions sends the whole array, existing entries untouched', async () => {
  const hs = stubHubSpot(opts('a@ortus.solutions', 'b@ortus.solutions'));
  await addConnectionsOptions(['c@ortus.solutions'], { fetchImpl: hs.fetchImpl, token: 't' });
  const sent = hs.calls.find((c) => c.method === 'PATCH').body.options;
  assert.equal(sent.length, 3);
  assert.deepEqual(sent.slice(0, 2), opts('a@ortus.solutions', 'b@ortus.solutions'));
});

test('addConnectionsOptions does not PATCH when nothing is missing', async () => {
  const hs = stubHubSpot(opts('a@ortus.solutions'));
  const r = await addConnectionsOptions(['a@ortus.solutions'], { fetchImpl: hs.fetchImpl, token: 't' });
  assert.deepEqual(r.added, []);
  assert.equal(hs.calls.filter((c) => c.method === 'PATCH').length, 0);
});

test('addConnectionsOptions throws when the read-back does not show the new value', async () => {
  const frozen = opts('a@ortus.solutions');
  const fetchImpl = async () => ({
    ok: true, status: 200, json: async () => ({ options: frozen }),   // PATCH silently ignored
  });
  await assert.rejects(
    () => addConnectionsOptions(['c@ortus.solutions'], { fetchImpl, token: 't' }),
    /did not take/i,
  );
});

test('tokenScopes returns the scope list', async () => {
  const fetchImpl = async () => ({
    ok: true, status: 200,
    json: async () => ({ hubId: 2748825, scopes: ['oauth', 'crm.schemas.contacts.write'] }),
  });
  assert.deepEqual(await tokenScopes({ fetchImpl, token: 't' }), ['oauth', 'crm.schemas.contacts.write']);
});

test('tokenScopes returns [] rather than throwing when the endpoint fails', async () => {
  const fetchImpl = async () => ({ ok: false, status: 404, json: async () => ({}) });
  assert.deepEqual(await tokenScopes({ fetchImpl, token: 't' }), []);
});

test('tokenScopes returns [] rather than throwing when fetch itself throws', async () => {
  const fetchImpl = async () => { throw new Error('network down'); };
  assert.deepEqual(await tokenScopes({ fetchImpl, token: 't' }), []);
});
