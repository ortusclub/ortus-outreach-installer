/**
 * Phase 11.3 Wave 0 — RED test for getConversationsPage helper.
 *
 * Asserts the helper uses the same auth scaffolding as getVoyagerDegree
 * (src/linkedin/helpers.js:112) — JSESSIONID cookie → CSRF token → fetch
 * with csrf-token + x-restli-protocol-version + accept: vnd.linkedin...
 *
 * Will fail until Plan 11.3-02 adds the export to src/linkedin/helpers.js.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getConversationsPage } from '../src/linkedin/helpers.js';

// Mock page that captures the page.evaluate call
function mockPage(evalResult) {
  const calls = [];
  return {
    _calls: calls,
    async evaluate(fn, ...args) {
      // The fn runs in the "browser" context; we emulate by calling it with a stubbed
      // global fetch + cookie + location. Tests capture the URL and headers the fn
      // would have used.
      const fetches = [];
      const stubFetch = async (url, opts) => {
        fetches.push({ url, opts });
        return {
          ok: true,
          status: 200,
          async json() { return evalResult; },
        };
      };
      // The helper uses document.cookie for CSRF — emulate:
      const stubDocument = {
        cookie: 'JSESSIONID="ajax:123abc"',
      };
      // Replace globals ONLY for the duration of this call
      const orig = { fetch: global.fetch, document: global.document };
      global.fetch = stubFetch;
      global.document = stubDocument;
      try {
        const out = await fn(...args);
        calls.push({ fetches });
        return out;
      } finally {
        global.fetch = orig.fetch;
        global.document = orig.document;
      }
    },
  };
}

test('getConversationsPage: calls /voyager/api/messaging/conversations with correct headers', async () => {
  const page = mockPage({ elements: [], paging: { count: 20, start: 0, total: 0 } });
  await getConversationsPage(page, { start: 0, count: 20 });
  assert.equal(page._calls.length, 1);
  const { fetches } = page._calls[0];
  assert.equal(fetches.length, 1);
  assert.match(fetches[0].url, /\/voyager\/api\/messaging\/conversations/);
  assert.match(fetches[0].url, /count=20/);
  assert.match(fetches[0].url, /start=0/);
  const headers = fetches[0].opts.headers;
  assert.match(headers.accept, /application\/vnd\.linkedin/);
  assert.equal(headers['x-restli-protocol-version'], '2.0.0');
  assert.ok(headers['csrf-token'], 'csrf-token header must be set');
});

test('getConversationsPage: returns null on fetch error (graceful fallback)', async () => {
  const page = {
    async evaluate() { throw new Error('simulated evaluate failure'); },
  };
  const result = await getConversationsPage(page, { start: 0, count: 20 });
  assert.equal(result, null);
});

test('getConversationsPage: returns null when no JSESSIONID cookie', async () => {
  // This scenario is handled INSIDE the page.evaluate function — the helper
  // returns null when cookie isn't found. We test by emulating:
  const page = {
    async evaluate(fn) {
      // Run the fn with document.cookie empty
      const origDocument = global.document;
      global.document = { cookie: '' };
      try {
        return await fn({ start: 0, count: 20 });
      } finally {
        global.document = origDocument;
      }
    },
  };
  const result = await getConversationsPage(page, { start: 0, count: 20 });
  assert.equal(result, null);
});
