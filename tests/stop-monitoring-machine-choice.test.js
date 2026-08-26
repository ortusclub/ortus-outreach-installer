import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');

function functionBody(name, nextName) {
  const start = src.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `${name} exists`);
  const end = src.indexOf(`async function ${nextName}(`, start + 1);
  assert.notEqual(end, -1, `${nextName} follows ${name}`);
  return src.slice(start, end);
}

test('cloud stop-and-monitor asks for machine after the tab/account scope', () => {
  const fn = functionBody('_finishStopAndKeepMonitoring', 'stopEverything');
  assert.match(fn, /_checkWhereHandler\s*=\s*chooseMachine/);
  assert.match(fn, /Where should monitoring run\?/);
  assert.match(fn, /checks connections and sends introduction messages/);
});

test('selected monitoring machine starts an immediate destination check', () => {
  const fn = functionBody('_finishStopAndKeepMonitoring', 'stopEverything');
  assert.match(fn, /campaignHandover\(target\.id, 'local', null, 'monitoring'\)/);
  assert.match(fn, /cloudCheckNow\(String\(target\.id\), null, scope\)/);
  assert.ok(fn.indexOf('_doStopCloud') < fn.indexOf("where === 'local'"),
    'sending is stopped and monitoring is armed before ownership moves');
});

test('older cached shells safely default monitoring to the existing VM', () => {
  const fn = functionBody('_finishStopAndKeepMonitoring', 'stopEverything');
  assert.match(fn, /if \(!whereModal\)[\s\S]*?chooseMachine\('vm'\)/);
});

test('machine selection proceeds only after the VM confirms the stop', () => {
  const stop = functionBody('_doStopCloud', 'pauseCloudCampaignUI');
  assert.match(stop, /catch \(e\)[\s\S]*?return false/);
  assert.match(stop, /renderCampaignsBoard[\s\S]*?return true/);
  const finish = functionBody('_finishStopAndKeepMonitoring', 'stopEverything');
  assert.match(finish, /const stopped = await _doStopCloud[\s\S]*?if \(!stopped\) return/);
});
