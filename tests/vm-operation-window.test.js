import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../public/css/dashboard-v0.3.css', import.meta.url), 'utf8');

test('the real campaign card contains one embedded VM browser window', () => {
  for (const id of [
    'stageVm', 'stageVmFresh', 'stageVmFrame', 'stageVmEmpty',
    'stageVmTitle', 'stageVmProof', 'stageVmOpen',
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.doesNotMatch(html, /id="stageOperation"/);
});

test('startup copy never invents a VM browser before one exists', () => {
  assert.match(app, /No VM browser exists yet/);
  assert.match(app, /The campaign has not reached \$\{vm\} yet/);
  assert.match(app, /Waiting for the first browser frame/);
  assert.match(app, /\/api\/campaign\/cloud\/\$\{encodeURIComponent\(campaignId\)\}\/view/);
});

test('dashboard launch and Campaign tab use the same status card', () => {
  assert.match(app, /it\.launching && typeof cloudLaunchStatus === 'function'[\s\S]*?cloudLaunchStatus\(\)/);
  assert.match(app, /const richCard = \(queued && !startupQueued\) \? '' : vjCardSkeleton\(it\.id\)/);
  assert.match(html, /\.sn-strip\.launching:not\(\.sn-collapsed\) \.sn-compact\{display:none;\}/);
});

test('VM browser window inherits the existing lifecycle colour', () => {
  assert.match(css, /\.vj-stage-vm \{[\s\S]*?--op-tone: var\(--vj-tone/);
  assert.match(css, /\.vj-card\.is-starting \{ --vj-tone: var\(--gold\)/);
  assert.match(css, /\.vj-card\.is-monitoring \{ --vj-tone: var\(--blue\)/);
  assert.match(css, /\.vj-card\.is-interrupted,[\s\S]*?--vj-tone: var\(--red\)/);
});
