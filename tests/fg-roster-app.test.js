import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp } from '../services/fg-roster/app.js';

// Minimal in-process HTTP helper (no supertest dependency).
function listen(app) {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const { port } = srv.address();
      resolve({ port, close: () => new Promise((r) => srv.close(r)) });
    });
  });
}
const impl = { getConnectionsStats: () => ({ total: 7 }) };
const post = (port, path, body, headers = {}) => fetch(`http://127.0.0.1:${port}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});

test('GET /fg-roster/health is 200 and needs no auth', async () => {
  const app = makeApp({ impl, token: 't', isReady: () => true, onRefresh: async () => {} });
  const s = await listen(app);
  const r = await fetch(`http://127.0.0.1:${s.port}/fg-roster/health`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  await s.close();
});

test('POST /fg-roster/rpc: 401 without Bearer, 200 with a whitelisted fn', async () => {
  const app = makeApp({ impl, token: 't', isReady: () => true, onRefresh: async () => {} });
  const s = await listen(app);
  const noAuth = await post(s.port, '/fg-roster/rpc', { fn: 'getConnectionsStats', args: [] });
  assert.equal(noAuth.status, 401);
  const ok = await post(s.port, '/fg-roster/rpc', { fn: 'getConnectionsStats', args: [] }, { authorization: 'Bearer t' });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { result: { total: 7 } });
  await s.close();
});

test('POST /fg-roster/rpc: 400 on a non-whitelisted fn', async () => {
  const app = makeApp({ impl, token: 't', isReady: () => true, onRefresh: async () => {} });
  const s = await listen(app);
  const r = await post(s.port, '/fg-roster/rpc', { fn: 'startSync', args: [] }, { authorization: 'Bearer t' });
  assert.equal(r.status, 400);
  await s.close();
});

test('POST /fg-roster/rpc: 503 when the DB is not ready', async () => {
  const app = makeApp({ impl, token: 't', isReady: () => false, onRefresh: async () => {} });
  const s = await listen(app);
  const r = await post(s.port, '/fg-roster/rpc', { fn: 'getConnectionsStats', args: [] }, { authorization: 'Bearer t' });
  assert.equal(r.status, 503);
  await s.close();
});

test('POST /fg-roster/admin/refresh calls onRefresh (auth required)', async () => {
  let refreshed = false;
  const app = makeApp({ impl, token: 't', isReady: () => true, onRefresh: async () => { refreshed = true; } });
  const s = await listen(app);
  const noAuth = await post(s.port, '/fg-roster/admin/refresh', {});
  assert.equal(noAuth.status, 401);
  const ok = await post(s.port, '/fg-roster/admin/refresh', {}, { authorization: 'Bearer t' });
  assert.equal(ok.status, 200);
  assert.equal(refreshed, true);
  await s.close();
});
