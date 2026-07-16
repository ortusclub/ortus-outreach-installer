import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp } from '../services/fg-roster/app.js';

const TOKEN = 'tok';
function harness(handlerResult = { dispatched: true, cloudId: 'c1', cycleKey: '2026-08-01' }) {
  let saved = null;
  const store = { load: () => saved, save: (c) => { saved = c; } };
  const runStore = { load: () => [{ cloudId: 'c1', cycleKey: '2026-08-01', status: 'dispatched' }] };
  const autopilot = { run: async (opts) => ({ ...handlerResult, _opts: opts }) };
  const app = makeApp({
    impl: {}, token: TOKEN, isReady: () => true, onRefresh: async () => {},
    autopilot, configStore: store, runStore,
  });
  return { app, store: () => saved };
}
async function listen(app) {
  const srv = await new Promise((res) => { const s = app.listen(0, () => res(s)); });
  return { base: `http://127.0.0.1:${srv.address().port}/fg-roster`, close: () => srv.close() };
}
const H = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` };

test('POST /admin/autopilot-config persists and GET returns it', async () => {
  const h = harness();
  const { base, close } = await listen(h.app);
  try {
    const cfg = { enabled: true, days: [1, 15], pairs: [{ profileId: 'p1' }], keywords: ['x'] };
    const put = await fetch(base + '/admin/autopilot-config', { method: 'POST', headers: H, body: JSON.stringify(cfg) });
    assert.equal(put.status, 200);
    assert.deepEqual(h.store().pairs, cfg.pairs);
    const get = await fetch(base + '/admin/autopilot', { headers: { authorization: `Bearer ${TOKEN}` } });
    const j = await get.json();
    assert.equal(j.config.enabled, true);
    assert.equal(j.runs.length, 1);
  } finally { close(); }
});

test('POST /admin/autopilot runs the handler and returns its result', async () => {
  const h = harness();
  const { base, close } = await listen(h.app);
  try {
    const r = await fetch(base + '/admin/autopilot', { method: 'POST', headers: H, body: JSON.stringify({ force: true }) });
    const j = await r.json();
    assert.equal(j.dispatched, true);
    assert.equal(j._opts.force, true);
  } finally { close(); }
});

test('autopilot routes require the bearer token', async () => {
  const h = harness();
  const { base, close } = await listen(h.app);
  try {
    const r = await fetch(base + '/admin/autopilot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 401);
  } finally { close(); }
});
