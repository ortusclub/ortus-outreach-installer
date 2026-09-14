import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('local closer retains unknown browser and clears it only after exit evidence', async () => {
  const source = readFileSync(new URL('../src/local-launcher.js', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('export async function closeLocalBrowser()')).replace('export ', '');
  let confirmed = false;
  const context = vm.createContext({
    activeBrowser: { close: async () => {}, process: () => ({ pid: 123 }) },
    closingBrowser: null, lastCloseEvidence: { browserClosed: false }, console: { log() {}, warn() {} },
    confirmOwnedProcessExit: async () => ({ browserClosed: confirmed }),
  });
  const close = vm.runInContext(body + '\ncloseLocalBrowser;', context);
  assert.equal((await close()).browserClosed, false);
  assert.notEqual(context.activeBrowser, null);
  confirmed = true;
  assert.equal((await close()).browserClosed, true);
  assert.equal(context.activeBrowser, null);
});

test('GoLogin closer retains profile ownership until explicit exit evidence', async () => {
  const source = readFileSync(new URL('../src/gologin-launcher.js', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('export async function closeProfile('), source.indexOf('export async function closeAllProfiles(')).replace('export ', '');
  let confirmed = false;
  const activeProfiles = new Map([['fixture', { killBrowser() {}, processSpawned: { pid: 123 }, stopAndCommit: async () => {} }]]);
  const close = vm.runInNewContext(body + '\ncloseProfile;', {
    activeProfiles, activeSessions: new Map(), spawnedPids: new Map(), closingProfiles: new Map(), closedProfileEvidence: new Map(),
    confirmOwnedProcessExit: async () => ({ browserClosed: confirmed }), console: { warn() {} },
  });
  assert.equal((await close('fixture')).browserClosed, false);
  assert.equal(activeProfiles.has('fixture'), true);
  confirmed = true;
  assert.equal((await close('fixture')).browserClosed, true);
  assert.equal(activeProfiles.has('fixture'), false);
});
