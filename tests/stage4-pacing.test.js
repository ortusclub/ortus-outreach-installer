import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import policy from '../src/gologin-request-policy.cjs';
import clientModule from '../src/gologin-admission-client.cjs';
import { guardSdkStartup } from '../src/sdk-startup-control.js';
const require = createRequire(import.meta.url);
const sdkEntry = require.resolve('gologin');
const requests = createRequire(sdkEntry)('requestretry');
const Base = requests.Request, original = Base.request, originalFetch = global.fetch;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
afterEach(() => { policy.configureAdmission(null); Base.request = original; global.fetch = originalFetch; });

test('desktop real startup guard cancels a queued SDK request before HTTP or browser spawn', async () => {
  policy.installSdkRequestPolicy();
  let dispatched = 0, spawned = 0;
  Base.request = () => { dispatched++; assert.fail('HTTP must not start'); };
  const entered = deferred(), release = deferred();
  policy.configureAdmission(clientModule.createAdmissionClient({ workspaceForToken: () => 'ortus', cooldown: async () => {},
    reserve: () => { entered.resolve(); return release.promise; } }));
  const { makeRequest } = await import(pathToFileURL(path.join(path.dirname(sdkEntry), 'utils/http.js')).href);
  const sdk = { access_token: 'fixture', async start() {
    await makeRequest('https://api.gologin.com/browser/example', {}, { token: 'fixture' });
    return this.spawnBrowser();
  }, async spawnBrowser() { spawned++; } };
  const control = guardSdkStartup(sdk);
  const rejected = assert.rejects(control.promise, /operator stop/);
  await entered.promise; control.cancel(new Error('operator stop')); await rejected;
  release.resolve({ allowed: true }); await assert.rejects(control.source);
  assert.equal(dispatched, 0); assert.equal(spawned, 0); control.detach();
});
test('desktop setup refuses production fallback and checks PR-19 coordinator identity', async () => {
  const saved = { ...process.env };
  try {
    const { setupPacing } = await import('../src/gologin-pacing-setup.js');
    process.env.GOLOGIN_REQUEST_PACING = '1'; delete process.env.SCRAPER_ENGINE_URL;
    assert.throws(setupPacing, /isolated PR-19/);
    process.env.SCRAPER_ENGINE_URL = 'https://scraper.ortusclub.com';
    assert.throws(setupPacing, /isolated PR-19/);
    process.env.SCRAPER_ENGINE_URL = 'http://127.0.0.1:3119';
    process.env.GOLOGIN_API_TOKEN = 'fixture-token';
    const sent = [];
    global.fetch = async (url, options) => {
      sent.push({ url: String(url), body: options.body });
      return { ok: true, json: async () => ({ namespace: 'production', scope: 'pilot-fleet', allowed: true }) };
    };
    setupPacing();
    await assert.rejects(policy.pacedFetch('https://api.gologin.com/browser/v2', {
      headers: { Authorization: 'Bearer fixture-token' },
    }), /coordinator unavailable/);
    assert.equal(sent.length, 1);
    assert.ok(sent[0].url.startsWith('http://127.0.0.1:3119/api/gologin/admission/'));
    assert.ok(!sent[0].body.includes('fixture-token'));
  } finally {
    for (const key of ['GOLOGIN_REQUEST_PACING', 'SCRAPER_ENGINE_URL', 'GOLOGIN_API_TOKEN']) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  }
});
