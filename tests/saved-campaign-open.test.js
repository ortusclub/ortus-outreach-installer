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

test('saved settings mapping keeps fields added after the original mapper', () => {
  const start = app.indexOf('function _configFromSettings(mode, s)');
  const end = app.indexOf('// A local history row has no live runtime', start);
  const body = app.slice(start, end);
  assert.match(body, /\.\.\.s/);
});
