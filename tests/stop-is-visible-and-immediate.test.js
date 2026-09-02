import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const APP = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
const HTML = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../public/css/dashboard-v0.3.css', import.meta.url), 'utf8');
const CLIENT = readFileSync(new URL('../src/campaigns-client.js', import.meta.url), 'utf8');
const SERVER = readFileSync(new URL('../server.js', import.meta.url), 'utf8');

// ── 1. The log says it the moment you click ────────────────────────────────
test('the stop is logged BEFORE the engine call, not after it', () => {
  const fn = APP.slice(APP.indexOf('async function _doStopCloud('));
  const logAt = fn.indexOf('Stop requested —');
  const callAt = fn.indexOf('_cloudMutationRequest');
  assert.ok(logAt > -1, 'the click writes a log line');
  assert.ok(logAt < callAt, 'the log line must come before the engine call, which retries for up to a minute');
});

test('a stop the VM never confirms survives in the log, not just a toast', () => {
  assert.match(APP, /The VM did not confirm the stop/);
});

test('the server records the stop and its outcome', () => {
  assert.match(SERVER, /\[cloud\] stop requested for/);
  assert.match(SERVER, /was NOT accepted by the VM/);
  assert.match(SERVER, /accepted by the VM/);
});

// ── 2. The card goes slate while stopping ──────────────────────────────────
test('the card carries is-stopping while the stop is in flight', () => {
  assert.match(APP, /root\.classList\.toggle\('is-stopping', stopping && !done\)/);
  assert.match(APP, /'is-done', 'is-stopped', 'is-stopping', 'is-resuming', 'is-local'/);
});

test('stopping is read from every shape the row can carry it in', () => {
  const m = APP.match(/const stopping = [\s\S]*?;\n/);
  assert.ok(m, 'stopping is computed');
  for (const k of ['status.stopping', "state === 'stopping'", "state === 'pausing'", "phase === 'stopping'"]) {
    assert.ok(m[0].includes(k), `stopping considers ${k}`);
  }
});

test('slate is defined in BOTH themes — light mode was the whole point', () => {
  assert.match(CSS, /--stop: #5B6577;/);   // light
  assert.match(CSS, /--stop: #9AA4B8;/);   // dark
});

test('slate is not red, gold or blue — those already mean other things', () => {
  const stop = ['#5B6577', '#9AA4B8'];
  for (const taken of ['#f85149', '#F7BE68', '#4a7bb8', '#6ea3d4', '#e35ea0']) {
    assert.ok(!stop.includes(taken), `${taken} is already in use`);
  }
});

test('every green surface on the card turns slate while stopping', () => {
  for (const sel of [
    /\.vj-card\.is-stopping::before \{ background: var\(--stop\)/,          // left rail
    /\.vj-card\.is-stopping \.vj-eyebrow \.vj-tag \.dot \{ background: var\(--stop\)/, // dot
    /\.vj-card\.is-stopping \.vj-hbar > i \{ background: var\(--stop\)/,     // progress bar
  ]) assert.match(CSS, sel);
  assert.match(CSS, /\.vj-card\.is-stopping \.vj-stage-verb \{ color: var\(--stop\)/);
});

// ── 3. Keep-monitoring can finally stop immediately ────────────────────────
test('the keep-monitoring caller asks for an immediate stop', () => {
  assert.match(APP, /_doStopCloud\(target\.id, \{ keepMonitoring: true, scope, immediate: true \}\)/);
});

test('every app stop query is immediate; finishCurrent is gone', () => {
  const fn = APP.slice(APP.indexOf('async function _doStopCloud('), APP.indexOf('// Pause / Resume a cloud campaign'));
  assert.match(fn, /&immediate=1/);
  assert.match(fn, /'\?immediate=1'/);
  assert.doesNotMatch(fn, /finishCurrent/);
});

test('the node client forces immediate for every stop shape', () => {
  const fn = CLIENT.slice(CLIENT.indexOf('export function stopCloudCampaign'), CLIENT.indexOf('export function resumeCloudCampaign'));
  assert.match(fn, /immediate = true/);
  assert.doesNotMatch(fn, /finishCurrent/);
});

test('the click owns and repaints both cards before the network call', () => {
  const fn = APP.slice(APP.indexOf('async function _doStopCloud('), APP.indexOf('// Pause / Resume a cloud campaign'));
  assert.ok(fn.indexOf('_markCloudStopping(id, true)') < fn.indexOf('_cloudMutationRequest'));
  assert.match(APP, /const _stoppingCloudIds = new Set\(\)/);
  assert.match(APP, /button\.disabled = true/);
});

test('a duplicate click cannot send or log a second stop', () => {
  const fn = APP.slice(APP.indexOf('async function _doStopCloud('), APP.indexOf('// Pause / Resume a cloud campaign'));
  assert.ok(fn.indexOf('_stoppingCloudIds.has') < fn.indexOf('_pushCloudEventNow'));
  assert.ok(fn.indexOf('_stoppingCloudIds.has') < fn.indexOf('_cloudMutationRequest'));
});

test('the legacy stop dialog cannot offer to finish the current lead', () => {
  assert.doesNotMatch(HTML, /confirmStopCampaignNow\(false\)|Wait up to<br>15 seconds/);
});

test('local immediate stop never awaits background schedule cleanup', () => {
  const route = SERVER.slice(SERVER.indexOf("app.post('/api/campaign/stop'"), SERVER.indexOf("app.post('/api/campaign/restore'"));
  assert.match(route, /if \(immediate\)/);
  const immediateBranch = route.slice(route.indexOf('if (immediate)'), route.indexOf('} else {', route.indexOf('if (immediate)')));
  assert.doesNotMatch(immediateBranch, /await stopCampaignBackgroundTracking/);
});
