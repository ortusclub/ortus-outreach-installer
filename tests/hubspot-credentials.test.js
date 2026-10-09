import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir = mkdtempSync(join(tmpdir(), 'hubspot-credential-test-'));
process.env.ORTUS_DATA_DIR = dir;
delete process.env.HUBSPOT_TOKEN;
const { saveHubSpotCredential, hubspotCredentialStatus, applyHubSpotCredential, requireHubSpotCredential } = await import('../src/hubspot-credentials.js');
test('HubSpot credential persists privately, never appears in status, reloads and removes', () => {
  try {
    assert.deepEqual(hubspotCredentialStatus(), { configured: false });
    let rejected;
    requireHubSpotCredential({}, { status(code) { assert.equal(code,409); return this; }, json(body) { rejected=body; } }, () => assert.fail('must block'));
    assert.equal(rejected.code,'HUBSPOT_CREDENTIAL_REQUIRED');
    assert.match(rejected.error,/Settings/);
    const token = 'test-only-not-a-real-secret';
    assert.deepEqual(saveHubSpotCredential(token), { configured: true });
    assert.equal(statSync(join(dir,'hubspot-credentials.json')).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(join(dir,'hubspot-credentials.json'))).token,token);
    delete process.env.HUBSPOT_TOKEN;
    applyHubSpotCredential();
    assert.equal(process.env.HUBSPOT_TOKEN,token);
    let allowed = false;
    requireHubSpotCredential({}, {}, () => allowed = true);
    assert(allowed);
    assert.throws(() => saveHubSpotCredential('bad token'));
    assert.equal(process.env.HUBSPOT_TOKEN,token);
    saveHubSpotCredential('');
    process.env.HUBSPOT_TOKEN = 'environment-default';
    applyHubSpotCredential();
    assert.deepEqual(hubspotCredentialStatus(), { configured: false });
  } finally { rmSync(dir,{recursive:true,force:true}); delete process.env.HUBSPOT_TOKEN; }
});
test('packaging does not read developer secrets and HubSpot writes require a credential', () => {
 const hook=readFileSync(new URL('../electron/after-pack.cjs',import.meta.url),'utf8');
 assert.doesNotMatch(hook,/HUBSPOT_TOKEN|repoEnv|INJECT_KEYS/);
 const server=readFileSync(new URL('../server.js',import.meta.url),'utf8');
 for (const route of ['preview','import','merge-duplicates','hubspot-options/add']) assert(server.includes(`app.post('/api/magellan/${route}', requireHubSpotCredential,`));
});
