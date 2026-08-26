import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('compact strip treats monitoring as a lifecycle on either machine', () => {
  assert.match(app, /it\.monitoring \|\| it\.monitoringPhase \|\| it\.engineStatus === 'monitoring'/);
  assert.match(app, /monitoring: s\.state === 'monitoring'/);
  assert.match(app, /monitoring\s*\?\s*'Monitoring'/);
});

test('local monitoring uses monitoring controls and blue presentation', () => {
  assert.match(app, /monitoring\s*\?\s*_dib\(V3_SVG_STOP, 'Stop monitoring'/);
  assert.match(html, /\.sn-strip\.monitoring::before[^}]+background:var\(--blue\)/);
  assert.match(html, /\.sn-strip\.monitoring \.sn-status\{color:var\(--blue\)/);
});

test('approved compact option uses quiet lifecycle gradients without boxed facts', () => {
  assert.match(html, /\.sn-strip\.sn-collapsed\.run\{[^}]+linear-gradient/);
  assert.match(html, /\.sn-strip\.sn-collapsed\.monitoring\{[^}]+linear-gradient/);
  assert.doesNotMatch(html, /\.sn-strip\.sn-collapsed \.sn-flow\{[^}]+border:/);
});
