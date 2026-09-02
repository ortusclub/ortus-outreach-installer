import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchSoOData, resetSoOStatusCacheForTests } from '../src/soo.js';

test('development app reads SoO from its configured engine before Apps Script', async () => {
  resetSoOStatusCacheForTests();
  const previousUrl = process.env.SCRAPER_ENGINE_URL;
  const previousToken = process.env.SCRAPER_ENGINE_TOKEN;
  process.env.SCRAPER_ENGINE_URL = 'http://dev-engine.test';
  process.env.SCRAPER_ENGINE_TOKEN = 'test-token';
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      json: async () => ({ accounts: [{ email: 'salesnav@example.com' }], total: 1 }),
    };
  };
  try {
    const result = await fetchSoOData({ attempts: 1 });
    assert.equal(result.total, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://dev-engine.test/api/soo-status');
    assert.equal(calls[0].options.headers.Authorization, 'Bearer test-token');
  } finally {
    if (previousUrl === undefined) delete process.env.SCRAPER_ENGINE_URL;
    else process.env.SCRAPER_ENGINE_URL = previousUrl;
    if (previousToken === undefined) delete process.env.SCRAPER_ENGINE_TOKEN;
    else process.env.SCRAPER_ENGINE_TOKEN = previousToken;
    resetSoOStatusCacheForTests();
  }
});
