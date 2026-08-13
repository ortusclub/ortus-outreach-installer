// tests/fg-postfg-retry.test.js
// postFg must retry a TRANSIENT non-JSON response (Apps Script's intermittent
// HTML error page from its one-time redirect URL) and succeed on a later attempt,
// but must NOT retry a login page (a deployment problem).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { postFg } from '../src/connections/fg-sync.js';

// Minimal fake Response: a 200 with a body string. fetch follows Apps Script's
// 302 itself now, so what postFg sees is always the final response.
function res(body) { return { status: 200, headers: { get: () => null }, text: async () => body }; }

test('postFg retries a transient non-JSON response and then succeeds', async () => {
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    // First attempt: Apps Script's transient HTML error page. Second: real JSON.
    return calls === 1 ? res('<!DOCTYPE html><html>Pagina non trovata</html>') : res('{"queued":3}');
  };
  try {
    const out = await postFg({ action: 'fgQueue', rows: [] }, { attempts: 3, sleep: async () => {} });
    assert.deepEqual(out, { queued: 3 });
    assert.equal(calls, 2, 'should have retried exactly once before succeeding');
  } finally {
    globalThis.fetch = orig;
  }
});

test('postFg does NOT retry a login page (non-transient deployment problem)', async () => {
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return res('<html>Sign in to continue to accounts.google.com</html>'); };
  try {
    const out = await postFg({ action: 'fgState' }, { attempts: 3, sleep: async () => {} });
    assert.match(out.error, /login page/i);
    assert.equal(calls, 1, 'a login page must not be retried');
  } finally {
    globalThis.fetch = orig;
  }
});

test('postFg gives up after all attempts on a persistent transient failure', async () => {
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return res('<!DOCTYPE html>nope'); };
  try {
    const out = await postFg({ action: 'fgState' }, { attempts: 3, sleep: async () => {} });
    // The status and the size are in the message: "200 with 12 bytes" is a
    // Google flap, "404 with 7,870 bytes" is the echo URL missing. A bare
    // "non-JSON" made those look like the same failure for a day.
    assert.match(out.error, /answered 200 with \d+ bytes that are not JSON/i);
    assert.equal(calls, 3, 'should try the full attempt budget');
  } finally {
    globalThis.fetch = orig;
  }
});
