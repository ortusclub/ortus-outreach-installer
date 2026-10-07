// Opening a cloud campaign from the engine's copy must restore the run target.
//
// Bug: the dashboard badge reads the engine's `runs_on` (so a VM campaign shows
// "VM"), but OPENing it rebuilt the wizard via _wizardConfigFromCloudCampaign(),
// which never carried the run target. The restore then read `config.runTarget`,
// found nothing, and defaulted to "This Machine" — so a reopened done / other-
// operator VM campaign came back local, and a re-run would launch on the wrong side.
//
// _wizardConfigFromCloudCampaign is a pure function inside app.js; extract its
// source and run it in a vm context (the repo's pattern for app.js helpers).

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
const a = app.indexOf('function _wizardConfigFromCloudCampaign(cc) {');
const b = app.indexOf('window._wizardConfigFromCloudCampaign', a);
assert.ok(a >= 0 && b > a, 'located _wizardConfigFromCloudCampaign in app.js');

const context = vm.createContext({});
vm.runInContext(app.slice(a, b) + ';this.fn = _wizardConfigFromCloudCampaign;', context);
const fromCloud = context.fn;

test('a VM campaign (runs_on: "vm") opens as Cloud VM', () => {
  const cfg = fromCloud({ runs_on: 'vm', mode: 'message_only', config: {} });
  assert.equal(cfg.runTarget, 'cloud');
});

test('a local campaign (runs_on: "local") opens as This Machine', () => {
  const cfg = fromCloud({ runs_on: 'local', mode: 'message_only', config: {} });
  assert.equal(cfg.runTarget, 'local');
});

test('an absent runs_on defaults to Cloud VM (pre-handover campaigns are VM)', () => {
  const cfg = fromCloud({ mode: 'message_only', config: {} });
  assert.equal(cfg.runTarget, 'cloud');
});

test('a runTarget already saved in the config jsonb wins over runs_on', () => {
  // The local launch-config snapshot carries the authoritative runTarget; honor it.
  const cfg = fromCloud({ runs_on: 'vm', mode: 'message_only', config: { runTarget: 'local' } });
  assert.equal(cfg.runTarget, 'local');
});

test('null campaign still returns null (unchanged)', () => {
  assert.equal(fromCloud(null), null);
});
