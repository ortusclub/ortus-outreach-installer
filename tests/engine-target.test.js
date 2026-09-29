import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveEngine, PROD_URL, DEV_URL } from '../src/engine-target.js';

test('no override, prod choice → prod default', () => {
  const r = resolveEngine({}, { engine: 'prod' });
  assert.equal(r.url, PROD_URL);
  assert.equal(r.environment, 'production');
  assert.equal(r.source, 'default');
});

test('dev choice → fixed dev URL + shared token, development', () => {
  const r = resolveEngine({}, { engine: 'dev' });
  assert.equal(r.url, DEV_URL);
  assert.equal(r.environment, 'development');
  assert.equal(r.source, 'stored');
  assert.ok(r.token, 'dev reuses the shared token');
});

test('SCRAPER_ENGINE_URL env override beats the stored dev choice', () => {
  const r = resolveEngine({ SCRAPER_ENGINE_URL: PROD_URL }, { engine: 'dev' });
  assert.equal(r.url, PROD_URL);
  assert.equal(r.environment, 'production');
  assert.equal(r.source, 'env');
});

test('env override to a non-prod URL reads as development, strips trailing slashes', () => {
  const r = resolveEngine({ SCRAPER_ENGINE_URL: 'http://localhost:3000///' }, { engine: 'prod' });
  assert.equal(r.url, 'http://localhost:3000');
  assert.equal(r.environment, 'development');
  assert.equal(r.source, 'env');
});

test('DEV_URL is the fixed dev engine address', () => {
  assert.equal(DEV_URL, 'https://dev-scraper.ortusclub.com');
});
