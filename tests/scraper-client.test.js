import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  isScraperConfigured,
  startScrape,
  pauseScrape,
  stopScrape,
  getJobs,
  engineHealth,
} from '../src/scraper-client.js';

const realFetch = globalThis.fetch;
const ENV_URL = process.env.SCRAPER_ENGINE_URL;
const ENV_TOKEN = process.env.SCRAPER_ENGINE_TOKEN;

// Record calls and reply with a scripted response.
function mockFetch(impl) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url, opts });
    const r = impl ? impl(url, opts, calls.length) : { ok: true, status: 200, body: '{}' };
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      text: async () => r.body ?? '{}',
    };
  };
  return calls;
}

beforeEach(() => {
  process.env.SCRAPER_ENGINE_URL = 'https://scraper.example.com/';
  process.env.SCRAPER_ENGINE_TOKEN = 'tok-123';
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (ENV_URL === undefined) delete process.env.SCRAPER_ENGINE_URL;
  else process.env.SCRAPER_ENGINE_URL = ENV_URL;
  if (ENV_TOKEN === undefined) delete process.env.SCRAPER_ENGINE_TOKEN;
  else process.env.SCRAPER_ENGINE_TOKEN = ENV_TOKEN;
});

test('always configured — cloud engine is the baked-in default', () => {
  assert.equal(isScraperConfigured(), true);
  delete process.env.SCRAPER_ENGINE_URL; // no env → still configured via default
  assert.equal(isScraperConfigured(), true);
});

test('falls back to the cloud engine when no env override', async () => {
  delete process.env.SCRAPER_ENGINE_URL;
  delete process.env.SCRAPER_ENGINE_TOKEN;
  const calls = mockFetch(() => ({ ok: true, body: '{"jobs":[]}' }));
  await getJobs();
  assert.match(calls[0].url, /^https:\/\/scraper\.ortusclub\.com\/api\/jobs/);
  // the baked-in bearer token is sent automatically
  assert.ok(calls[0].opts.headers['Authorization'].startsWith('Bearer '));
});

test('startScrape validates required fields without hitting the network', async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; return { ok: true, status: 200, text: async () => '{}' }; };
  assert.match((await startScrape({ sheetUrl: 's', profileId: 'p' })).error, /searchUrls/);
  assert.match((await startScrape({ searchUrls: 'u', profileId: 'p' })).error, /sheetUrl/);
  assert.match((await startScrape({ searchUrls: 'u', sheetUrl: 's' })).error, /profileId/);
  assert.equal(called, false, 'no fetch on validation failure');
});

test('single URL → POST /api/scrape/single with auth + trimmed base URL', async () => {
  const calls = mockFetch(() => ({ ok: true, body: JSON.stringify({ jobId: 'j1' }) }));
  const res = await startScrape({
    searchUrls: '  https://linkedin.com/sales/search?x=1  ',
    sheetUrl: 'https://docs.google.com/sheet',
    profileId: '665abc',
    tabName: 'Batch A',
  });
  assert.equal(res.jobId, 'j1');
  assert.equal(calls.length, 1);
  // No double slash between base and path.
  assert.equal(calls[0].url, 'https://scraper.example.com/api/scrape/single');
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.headers['Authorization'], 'Bearer tok-123');
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.searchUrl, 'https://linkedin.com/sales/search?x=1'); // trimmed
  assert.equal(body.profileId, '665abc');
  assert.equal(body.tabName, 'Batch A');
});

test('multiple URLs → POST /api/scrape/batch', async () => {
  const calls = mockFetch(() => ({ ok: true, body: '{"batchId":"b1"}' }));
  const res = await startScrape({
    searchUrls: ['https://a', '', '  https://b  '],
    sheetUrl: 'https://sheet',
    profileId: 'p1',
  });
  assert.equal(res.batchId, 'b1');
  assert.equal(calls[0].url, 'https://scraper.example.com/api/scrape/batch');
  const body = JSON.parse(calls[0].opts.body);
  assert.deepEqual(body.searchUrls, ['https://a', 'https://b']); // blanks dropped, trimmed
});

test('startScrape does NOT retry (avoids duplicate jobs)', async () => {
  const calls = mockFetch(() => ({ ok: false, status: 500, body: '{"error":"boom"}' }));
  const res = await startScrape({ searchUrls: 'u', sheetUrl: 's', profileId: 'p' });
  assert.match(res.error, /boom|HTTP 500/);
  assert.equal(calls.length, 1, 'single attempt only');
});

test('idempotent control calls retry transient 5xx then return last error', async () => {
  const calls = mockFetch(() => ({ ok: false, status: 503, body: '{"error":"unavailable"}' }));
  const res = await pauseScrape('p1');
  assert.ok(res.error);
  assert.equal(calls.length, 3, 'retried up to maxAttempts');
});

test('idempotent control calls do NOT retry permanent 4xx', async () => {
  const calls = mockFetch(() => ({ ok: false, status: 404, body: '{"error":"no such job"}' }));
  const res = await stopScrape('p1');
  assert.match(res.error, /no such job/);
  assert.equal(calls.length, 1, 'no retry on 4xx');
});

test('engineHealth issues a single GET', async () => {
  const calls = mockFetch(() => ({ ok: true, body: '{"ok":true}' }));
  const res = await engineHealth();
  assert.equal(res.ok, true);
  assert.equal(calls[0].opts.method, 'GET');
  assert.equal(calls[0].url, 'https://scraper.example.com/api/health');
});
