import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const APP = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');

function lift(name) {
  const start = APP.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} not found`);
  let p = APP.indexOf('(', start);
  let parameterDepth = 0;
  for (; p < APP.length; p += 1) {
    if (APP[p] === '(') parameterDepth += 1;
    else if (APP[p] === ')') {
      parameterDepth -= 1;
      if (parameterDepth === 0) break;
    }
  }
  const body = APP.indexOf('{', p);
  let depth = 0;
  for (let i = body; i < APP.length; i += 1) {
    if (APP[i] === '{') depth += 1;
    else if (APP[i] === '}') {
      depth -= 1;
      if (depth === 0) return APP.slice(start, i + 1);
    }
  }
  throw new Error(`${name} is unbalanced`);
}

test('Dashboard and Campaign cards use one shared control renderer', () => {
  const dashboard = lift('fillVjCard');
  const campaign = lift('_adaptActiveCardControls');
  assert.match(dashboard, /_renderVjCardControls\(root, status\)/);
  assert.match(campaign, /_renderVjCardControls\(card, status, \{ active: true \}\)/);
});

test('Campaign controls use status data, never the temporary navigation flag', () => {
  const campaign = lift('_adaptActiveCardControls');
  assert.match(campaign, /status && status\._cloud/);
  assert.doesNotMatch(campaign, /_viewingCloudId/);
});

test('the shared renderer owns the matrix, bulk check and sheet actions', () => {
  const renderer = lift('_renderVjCardControls');
  assert.match(renderer, /vjCardControlsFor\(status\)/);
  assert.match(renderer, /_vjControlsHtml\(c, status, options\)/);
  assert.match(renderer, /bb\.setAttribute\('onclick', c\.bulk\.onclick\)/);
  assert.match(renderer, /open sheet[\s\S]*?style\.display = 'none'/i);
});

test('active markup preserves stable Pause and Stop ids and renders Auto checks', () => {
  const html = lift('_vjControlsHtml');
  assert.match(html, /dock-active-pause/);
  assert.match(html, /btn-active-stop/);
  assert.match(html, /c\.monAuto/);
  assert.match(html, /Auto checks/);
});

test('legacy Pause fallback also routes from the card campaign id', () => {
  const start = APP.indexOf('window.dashPauseActive = async function()');
  const end = APP.indexOf('// Resume is deliberately a decision', start);
  const pause = APP.slice(start, end);
  assert.match(pause, /const cloudId = _activeCardCloudId\(\)/);
  assert.match(pause, /pauseCloudCampaignUI\(cloudId, paused\)/);
  assert.doesNotMatch(pause, /pauseCloudCampaignUI\(_viewingCloudId/);
});
