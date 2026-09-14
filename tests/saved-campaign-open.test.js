import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
const card = fs.readFileSync(new URL('../public/js/vjcard.mjs', import.meta.url), 'utf8');

test('local historical Open is campaign-specific and never uses the blank new-campaign route', () => {
  assert.match(app, /onclick="openLocalHistoryCampaign\('\$\{escHtml\(it\.id\)\}'\)"/);
  assert.match(app, /async function openLocalHistoryCampaign\(id\)/);
  assert.match(app, /fetch\(`\/api\/history\/\$\{encodeURIComponent\(it\.histIdx\)\}\/log`\)/);
  assert.match(app, /_viewingLocalHistoryStatus = status/);
  assert.match(card, /done && s\.hist \? `openLocalHistoryCampaign\('\$\{id\}'\)`/);
});

test('opening a draft applies its complete saved config', () => {
  const start = app.indexOf('async function editDraft(id)');
  const end = app.indexOf('window.editDraft = editDraft;', start);
  const body = app.slice(start, end);
  assert.match(body, /draft\.config/);
  assert.match(body, /applyPresetConfig\(draft\.config\)/);
});

test('older history entries restore settings snapshots when config is absent', () => {
  const start = app.indexOf('async function editPastCampaign(idx)');
  const end = app.indexOf('window.editPastCampaign = editPastCampaign;', start);
  const body = app.slice(start, end);
  assert.match(body, /entry\.config \|\| entry\.settings/);
  assert.match(body, /_configFromSettings\(entry\.mode, entry\.settings\)/);
});

test('unchanged dashboard markup still retries historical log hydration', () => {
  const earlyReturn = app.match(/if \(board\.dataset\.rendered === '1' && final === _lastBoardHtml\) \{([\s\S]*?)\n  \}/);
  assert.ok(earlyReturn, 'dashboard anti-jank branch is missing');
  assert.match(earlyReturn[1], /_fillHistLogBoxes\(board\)/);
  assert.match(earlyReturn[1], /_fillVjCards\(board\)/);
  assert.match(earlyReturn[1], /return;/);
});

test('expanding a Dashboard card hydrates its historical log immediately', () => {
  const start = app.indexOf('// Fold / unfold a finished-or-running strip');
  const end = app.indexOf('// Dismiss a done strip', start);
  const body = app.slice(start, end);
  assert.match(body, /Promise\.resolve\(renderCampaignsBoard\(\)\)\.then/);
  assert.match(body, /_fillHistLogBoxes\(board\)/);
});

test('historical log recovery hydrates the shared item used by the detailed Dashboard card', () => {
  const start = app.indexOf('function _fillHistLogBoxes(board)');
  const end = app.indexOf('// Bulk-dismiss every Done strip', start);
  const body = app.slice(start, end);
  assert.match(body, /_histLogLinesCache\.set\(idx, recoveredLines\)/);
  assert.match(body, /it\.logs = recoveredLines/);
  assert.match(body, /_fillVjCards\(board\)/);
});

test('dashboard campaign timestamps use one formatter in compact and detailed cards', () => {
  assert.match(app, /function _campaignTimestamp\(it\)/);
  assert.match(app, /label = 'Ended'/);
  assert.match(app, /label = 'Scheduled'/);
  assert.match(app, /\$\{_campaignTimestampHtml\(it\)\}/);
  const fillStart = app.indexOf('function _fillVjCards(board)');
  const fillEnd = app.indexOf('function renderUnifiedStrip(it)', fillStart);
  assert.match(app.slice(fillStart, fillEnd), /_campaignTimestamp\(it\)/);
});

test('saved settings mapping keeps fields added after the original mapper', () => {
  const start = app.indexOf('function _configFromSettings(mode, s)');
  const end = app.indexOf('// A local history row has no live runtime', start);
  const body = app.slice(start, end);
  assert.match(body, /\.\.\.s/);
});
