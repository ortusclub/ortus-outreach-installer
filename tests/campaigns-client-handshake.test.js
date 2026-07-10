// tests/campaigns-client-handshake.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signalPrimaryAcceptDone } from '../src/campaigns-client.js';

// SCRAPER_ENGINE_URL is hardcoded (scraper-engine-url.js), so we can't reach the
// "unconfigured" branch by env — stub fetch to stay offline and deterministic.

test('never throws — a transport failure returns a structured { error }', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network disabled in test'); };
  try {
    const r = await signalPrimaryAcceptDone('cmp_x', ['gl_a']);
    assert.ok(r && typeof r === 'object');
    assert.equal(r.error, 'network disabled in test'); // requestOnce catch → { error: err.message }
  } finally { globalThis.fetch = origFetch; }
});

test('POSTs to the right path and coerces acceptedIds to an array', async () => {
  const origFetch = globalThis.fetch;
  let sawUrl = null, sawBody = null, sawMethod = null;
  globalThis.fetch = async (url, opts) => {
    sawUrl = url; sawMethod = opts?.method; sawBody = opts?.body ? JSON.parse(opts.body) : null;
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, resumed: true }) };
  };
  try {
    const ok = await signalPrimaryAcceptDone('cmp 1/x', undefined);
    assert.equal(sawMethod, 'POST');
    assert.match(sawUrl, /\/api\/campaign\/cmp%201%2Fx\/primary-accept-done$/); // id is encodeURIComponent'd
    assert.deepEqual(sawBody, { accepted: [] });                                 // non-array → []
    assert.deepEqual(ok, { ok: true, resumed: true });                           // success → parsed body

    await signalPrimaryAcceptDone('cmp_x', ['gl_a', 'gl_b']);
    assert.deepEqual(sawBody, { accepted: ['gl_a', 'gl_b'] });
  } finally { globalThis.fetch = origFetch; }
});

test('a terminal 409 (already signaled) surfaces as { error, status:409 }', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 409, text: async () => JSON.stringify({ error: 'already accepted' }) });
  try {
    const r = await signalPrimaryAcceptDone('cmp_x', ['gl_a']);
    assert.equal(r.status, 409);
    assert.match(r.error, /409/);
  } finally { globalThis.fetch = origFetch; }
});
