// tests/campaigns-client-view-stream.test.js
//
// Regression: openCampaignViewStream must surface the engine's JSON error body
// (e.g. {error:"no active session"}) on a non-OK response, NOT a bare
// "HTTP 404". The viewer's calm idle state keys on the "no active session"
// string; losing it makes the viewer render a scary red "(HTTP 404)" instead.
//
// The prod bug was ordering: controller.abort() ran BEFORE await res.json(),
// and a real fetch body errors out once its request signal is aborted — so the
// read lost the body. These stubs make json() reject when the signal is already
// aborted, faithfully reproducing that behavior.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openCampaignViewStream } from '../src/campaigns-client.js';

function stubJsonBodyThatErrorsOnceAborted(status, body) {
  return async (_url, opts) => {
    const signal = opts?.signal;
    return {
      ok: false,
      status,
      headers: { get: () => 'application/json; charset=utf-8' },
      json: async () => {
        // Mirror real fetch: reading an aborted body rejects.
        if (signal && signal.aborted) throw new Error('The operation was aborted');
        return body;
      },
    };
  };
}

test('a 404 with a JSON error body surfaces the engine reason, not "HTTP 404"', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = stubJsonBodyThatErrorsOnceAborted(404, { error: 'no active session' });
  try {
    const r = await openCampaignViewStream('cmp_x');
    assert.equal(r.ok, false);
    assert.equal(r.status, 404);
    assert.equal(r.error, 'no active session'); // was "HTTP 404" before the abort-ordering fix
  } finally { globalThis.fetch = origFetch; }
});

test('falls back to "HTTP <status>" when the error body has no reason', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = stubJsonBodyThatErrorsOnceAborted(503, {});
  try {
    const r = await openCampaignViewStream('cmp_x');
    assert.equal(r.ok, false);
    assert.equal(r.status, 503);
    assert.equal(r.error, 'HTTP 503');
  } finally { globalThis.fetch = origFetch; }
});
