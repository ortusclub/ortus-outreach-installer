import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import policy from '../src/gologin-request-policy.cjs';
import { pacingTarget, setupPacing } from '../src/gologin-pacing-setup.js';
import { previewUserDataDir } from '../electron/preview-data-dir.mjs';

const preview = (pr, port) => ({
  ORTUS_ENGINE_ENVIRONMENT: 'preview', ORTUS_PREVIEW_PR: pr,
  SCRAPER_ENGINE_URL: `http://127.0.0.1:${port}`,
});

test('pacing accepts only the matching isolated preview tunnel', () => {
  assert.equal(pacingTarget(preview('19', '3119')).namespace, 'preview-pr-19');
  assert.equal(pacingTarget(preview('40', '3140')).namespace, 'preview-pr-40');
  for (const target of [
    preview('40', '3119'), preview('19', '3140'), preview('40', '3001'),
    { ...preview('40', '3140'), ORTUS_ENGINE_ENVIRONMENT: 'development' },
    { ...preview('40', '3140'), SCRAPER_ENGINE_URL: 'https://scraper.ortusclub.com' },
  ]) assert.throws(() => pacingTarget(target), /isolated PR-19:3119 or DEV-40:3140/);
});

test('DEV-40 setup admits the matching coordinator and dispatches one GoLogin request', async () => {
  const saved = { ...process.env };
  const originalFetch = global.fetch;
  const sent = [];
  try {
    Object.assign(process.env, preview('40', '3140'), {
      GOLOGIN_REQUEST_PACING: '1', GOLOGIN_API_TOKEN: 'fixture-token',
    });
    global.fetch = async url => {
      sent.push(String(url));
      return sent.length === 1
        ? { ok: true, json: async () => ({ namespace: 'preview-pr-40', scope: 'pilot-fleet', allowed: true }) }
        : { ok: true, status: 200 };
    };
    setupPacing();
    await policy.pacedFetch('https://api.gologin.com/browser/v2', {
      headers: { Authorization: 'Bearer fixture-token' },
    });
    assert.deepEqual(sent, [
      'http://127.0.0.1:3140/api/gologin/admission/reserve',
      'https://api.gologin.com/browser/v2',
    ]);
  } finally {
    policy.configureAdmission(null);
    global.fetch = originalFetch;
    for (const key of ['GOLOGIN_REQUEST_PACING', 'ORTUS_ENGINE_ENVIRONMENT', 'ORTUS_PREVIEW_PR', 'SCRAPER_ENGINE_URL', 'GOLOGIN_API_TOKEN']) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  }
});

test('Sam launcher selects a separate local profile from the installed app', () => {
  assert.equal(previewUserDataDir('/profiles', {
    ...preview('40', '3140'), ORTUS_PREVIEW_ISOLATED_DATA: '1',
  }), '/profiles/Ortus PR-40 Stage3 Preview');
  const launcher = readFileSync(new URL('../scripts/electron-sam-dev40.sh', import.meta.url), 'utf8');
  assert.match(launcher, /^export ORTUS_PREVIEW_ISOLATED_DATA=1$/m);
});
