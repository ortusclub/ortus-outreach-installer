import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publishAutopilotConfig } from '../src/fg-autopilot-publish.js';

test('publishAutopilotConfig POSTs the config with the bearer token', async () => {
  let seen;
  const fetchImpl = async (url, opts) => { seen = { url, opts }; return { ok: true, json: async () => ({ ok: true }) }; };
  const r = await publishAutopilotConfig({ enabled: true, pairs: [] }, {
    fetchImpl, rosterUrl: 'https://svc/fg-roster', rosterToken: 'tok',
  });
  assert.equal(r.ok, true);
  assert.equal(seen.url, 'https://svc/fg-roster/admin/autopilot-config');
  assert.equal(seen.opts.headers.authorization, 'Bearer tok');
  assert.deepEqual(JSON.parse(seen.opts.body).pairs, []);
});

test('publishAutopilotConfig surfaces a non-ok response as an error', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}) });
  const r = await publishAutopilotConfig({}, { fetchImpl, rosterUrl: 'https://svc/fg-roster', rosterToken: 't' });
  assert.match(r.error, /500/);
});
