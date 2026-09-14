import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

for (const local of [true, false]) test(`${local ? 'local' : 'GoLogin'} launch reserves before disk await and observes cancellation afterwards`, async () => {
  const file = local ? 'local-launcher.js' : 'gologin-launcher.js';
  const name = local ? 'launchLocalBrowser' : 'launchProfile';
  const source = readFileSync(new URL('../src/' + file, import.meta.url), 'utf8');
  const start = source.indexOf('export async function ' + name + '(');
  const end = source.indexOf('\n}\n', start) + 2;
  let release, entered;
  const disk = new Promise(r => { release = r; });
  const ready = new Promise(r => { entered = r; });
  const context = {
    startupAdmission: { assertRuntimeReady() {} },
    pendingLaunch: false, pendingLaunches: new Set(), closingBrowser: null, activeBrowser: null,
    closingProfiles: new Map(), closedProfileEvidence: new Map(),
    tokenForProfile: async () => 'fixture',
    checkDiskFree: () => { entered(); return disk; },
  };
  const launch = vm.runInNewContext(source.slice(start, end).replace('export ', '') + '\n' + name + ';', context);
  const controller = new AbortController();
  const call = () => local ? launch({ signal: controller.signal }) : launch('fixture', null, { signal: controller.signal });
  const first = call(); await ready;
  await assert.rejects(call(), /already in progress/);
  controller.abort(new Error('test cancelled')); release({ ok: true });
  await assert.rejects(first, /test cancelled/);
});
