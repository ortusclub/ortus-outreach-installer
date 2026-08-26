import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');

test('local to VM follows the newly dispatched cloud campaign id', () => {
  assert.match(src, /const targetId = String\(d\.id \|\| id\)/);
  assert.match(src, /_viewingCloudId = targetId/);
  assert.match(src, /_refreshCloudActiveStatus\(targetId\)/);
});

test('handover holds the last truthful source card through the ownership gap', () => {
  assert.match(src, /let _whHold = null/);
  assert.match(src, /status = \{ \.\.\._whHold, running: true \}/);
});

test('VM to local handover restarts the local status recorder', () => {
  assert.match(src, /stopViewingCloudCampaign\(\);[\s\S]{0,900}startPolling\(\)/);
});

test('active handover keeps Live Status expanded', () => {
  assert.match(src, /liveStatusForcedOpen = true;\s*_whBusy =/);
  assert.match(src, /cloudOperational \|\| _whBusy/);
  assert.match(src, /sec\.classList\.remove\('collapsed'\)/);
});

test('a queued VM campaign keeps the location switch and a warming activity stage', () => {
  assert.match(src, /const queued = !!status\.queued \|\| status\.state === 'queued'/);
  assert.match(src, /!running && !monitoring && !waiting && !queued/);
  assert.match(src, /label: c\.status === 'scheduled' \? 'Waiting for the scheduled start' : 'Starting the cloud machine'/);
  assert.match(src, /state: isMon \? 'monitoring' : \(isQueued \? 'queued' : undefined\)/);
});

test('successful handover ownership overrides the slower board cache immediately', () => {
  assert.match(src, /const _handoverOwner = new Map\(\)/);
  assert.match(src, /_handoverOwner\.set\(targetId, to === 'local' \? 'local' : 'vm'\)/);
  assert.match(src, /if \(_handoverOwner\.has\(String\(id\)\)\)/);
});

test('every machine switch starts an acceptance check on the destination', () => {
  assert.match(src, /async function _startHandoverCheck\(id, to, phase, response\)/);
  assert.match(src, /fetch\('\/api\/monitoring\/check-now', \{ method: 'POST' \}\)/);
  assert.match(src, /cloudCheckLocal\(targetId, null, 'campaign'\)/);
  assert.match(src, /cloudCheckNow\(targetId, null, 'campaign'\)/);
  assert.match(src, /await _startHandoverCheck\(targetId, to, phase, d\)/);
});

test('the switch confirmation tells the operator about the automatic check', () => {
  assert.match(src, /An acceptance check starts automatically on this Mac as soon as the move completes/);
  assert.match(src, /An acceptance check starts automatically on the VM as soon as the move completes/);
});

test('handover transition cannot display either completion UI', () => {
  assert.match(src, /const handoverStop = String\(s\.stopReason \|\| ''\)\.startsWith\('handover-'\)/);
  assert.match(src, /!!s\.endNotice && !handoverStop && !_whBusy && !_hoMove/);
  assert.match(src, /if \(_whBusy \|\| _hoMove \|\| String\(status\?\.stopReason \|\| ''\)\.startsWith\('handover-'\)\) return;/);
});

test('resume decision is single-flight and disables its initiating control', () => {
  assert.match(src, /const _resumeDecisionInFlight = new Set\(\)/);
  assert.match(src, /if \(_resumeDecisionInFlight\.has\(resumeKey\)\) return;/);
  assert.match(src, /btn\.disabled = true/);
});
