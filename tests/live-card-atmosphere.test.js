import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../public/css/dashboard-v0.3.css', import.meta.url), 'utf8');

test('builder and expanded dashboard cards share one appearance contract', () => {
  assert.match(app, /function applyVjCardAppearance\(/);
  assert.match(app, /function fillVjCard[\s\S]*?applyVjCardAppearance\(root, status, f\)/);
  assert.match(app, /window\.renderActiveCard[\s\S]*?applyVjCardAppearance\(card, status\)/);
});
test('appearance contract clears stale classes and maps every lifecycle family', () => {
  for (const state of [
    'is-monitor', 'is-monitoring', 'is-waiting', 'is-interrupted', 'is-error',
    'is-queued', 'is-starting', 'is-paused', 'is-done', 'is-local',
  ]) assert.match(app, new RegExp(`['\"]${state}['\"]`), state);
  assert.match(app, /root\.classList\.remove\('is-monitor',[\s\S]*?'is-local'\)/);
});

test('card, stage and banner primitives all carry the approved state gradient', () => {
  assert.match(css, /\.vj-card\s*\{[\s\S]*?linear-gradient\(115deg/);
  assert.match(css, /\.vj-stage,\s*\nbody\[data-dashboard='v3'\] \.vj-live\s*\{[\s\S]*?linear-gradient\(90deg/);
  for (const state of [
    'is-monitor', 'is-preflight', 'is-queued', 'is-starting', 'is-waiting',
    'is-paused', 'is-done', 'is-interrupted', 'is-error', 'is-local',
    'is-checking', 'is-sending', 'is-delayed', 'is-handover',
  ]) assert.match(css, new RegExp(`\\.${state}`), state);
});

test('terminal cards keep their log and render a static outcome stage', () => {
  assert.match(app, /const terminal = !canonicalOwned && status && status\.state === 'done' \? terminalPresentation\(status\) : null/);
  assert.match(app, /const phase = canonicalOwned\s*\? String\(\(ca && ca\.phase\) \|\| 'starting'\)/);
  assert.match(app, /terminal \? 'done'/);
  assert.match(app, /phase !== 'done'/);
  assert.match(app, /const logEl = root\.querySelector\('\[data-f="active-log"\]'\)/);
  assert.match(css, /\.vj-card\.is-stopped \.vj-stage\.is-done/);
});
