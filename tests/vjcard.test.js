import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statusFromItem, vjCardFields, vjCardControlsFor } from '../public/js/vjcard.mjs';

// ── statusFromItem ──
test('statusFromItem: cloud monitoring item → monitoring state, cloud flag', () => {
  const s = statusFromItem({ where: 'cloud', id: 'c1', bucket: 'running', monitoring: true, sent: 3, total: 4, accounts: 1, nextCheckAt: 'x', checkIntervalMinutes: 30, autoChecksEnabled: false });
  assert.equal(s._cloud, true);
  assert.equal(s.state, 'monitoring');
  assert.equal(s.running, false);
  assert.equal(s.totalProcessed, 3);
  assert.equal(s.totalTargets, 4);
  assert.equal(s.checkIntervalMinutes, 30);
  assert.equal(s.autoChecksEnabled, false);
});
test('statusFromItem: running local item → running, no state', () => {
  const s = statusFromItem({ where: 'local', id: 'local-active', bucket: 'running', sent: 5, total: 10, accounts: 2, paused: true });
  assert.equal(s._cloud, false);
  assert.equal(s.running, true);
  assert.equal(s.state, undefined);
  assert.equal(s.paused, true);
});
test('statusFromItem: done + queued map their states', () => {
  assert.equal(statusFromItem({ bucket: 'done' }).state, 'done');
  assert.equal(statusFromItem({ bucket: 'queued' }).state, 'queued');
});

// ── vjCardFields ──
test('vjCardFields: pct/accounts/accepted for a running local campaign', () => {
  const f = vjCardFields(statusFromItem({ where: 'local', bucket: 'running', sent: 3, total: 4, accounts: 2 }));
  assert.equal(f.pct, 75);
  assert.equal(f.accountsCount, 2);
  assert.equal(f.accepted, '—'); // board item carries no accepted → dash
  assert.equal(f.eyebrow, 'Running');
  assert.equal(f.isMonitor, false);
});
test('vjCardFields: monitoring eyebrow + zero-total guard', () => {
  const f = vjCardFields(statusFromItem({ where: 'cloud', bucket: 'running', monitoring: true, sent: 0, total: 0 }));
  assert.equal(f.isMonitor, true);
  assert.equal(f.eyebrow, 'Monitoring');
  assert.equal(f.pct, 0); // no divide-by-zero
});
test('vjCardFields: paused running reads Paused', () => {
  const f = vjCardFields(statusFromItem({ where: 'local', bucket: 'running', paused: true, sent: 1, total: 2 }));
  assert.equal(f.eyebrow, 'Paused');
});
test('vjCardFields: done reads Finished', () => {
  assert.equal(vjCardFields(statusFromItem({ bucket: 'done', sent: 9, total: 9 })).eyebrow, 'Finished');
});

// ── vjCardControlsFor: the matrix ──
test('controls: running local → pause/stop/restart/copy + bulk run-check, open=viewRunningCampaign', () => {
  const c = vjCardControlsFor(statusFromItem({ where: 'local', id: 'local-active', bucket: 'running', sent: 1, total: 2 }));
  assert.match(c.open.onclick, /viewRunningCampaign/);
  assert.ok(c.pause && c.stop && c.restart && c.copy);
  assert.match(c.bulk.onclick, /dashRunCheck/);
});
test('controls: running cloud → stop + Show, no pause, no bulk, open=openCloudLive', () => {
  const c = vjCardControlsFor(statusFromItem({ where: 'cloud', id: 'c1', bucket: 'running' }));
  assert.match(c.open.onclick, /openCloudLive\('c1'\)/);
  assert.equal(c.pause, null);
  assert.equal(c.bulk, null);
  assert.match(c.stop.onclick, /stopCloudCampaignUI\('c1'\)/);
  assert.ok(c.extra.find((e) => e.kind === 'show'));
});
test('controls: monitoring cloud → check-now bulk + auto toggle + stop monitoring', () => {
  const c = vjCardControlsFor(statusFromItem({ where: 'cloud', id: 'c9', bucket: 'running', monitoring: true, autoChecksEnabled: true }));
  assert.match(c.bulk.onclick, /cloudCheckNow\('c9'\)/);
  assert.ok(c.monAuto && c.monAuto.checked === true);
  assert.match(c.monAuto.onclick, /setCloudAutoChecks\('c9'/);
  assert.match(c.stop.tip, /monitoring/i);
  assert.equal(c.pause, null);
});
test('controls: monitoring local → dashRunCheck bulk + pause + stop', () => {
  const c = vjCardControlsFor(statusFromItem({ where: 'local', id: 'local-active', bucket: 'running', monitoring: true }));
  assert.match(c.bulk.onclick, /dashRunCheck/);
  assert.ok(c.pause);
  assert.ok(c.stop);
  assert.equal(c.monAuto, null);
});
test('controls: done → duplicate + dismiss, no bulk/stop/pause', () => {
  const cloud = vjCardControlsFor(statusFromItem({ where: 'cloud', id: 'cD', bucket: 'done' }));
  assert.equal(cloud.bulk, null);
  assert.equal(cloud.stop, null);
  assert.ok(cloud.extra.find((e) => e.kind === 'dup'));
  assert.ok(cloud.extra.find((e) => e.kind === 'dismiss' && /dismissCloudDone/.test(e.onclick)));
  const local = vjCardControlsFor(statusFromItem({ where: 'local', id: 'h1', bucket: 'done', hist: true }));
  assert.ok(local.extra.find((e) => e.kind === 'debrief'));
});
test('controls: queued → cancel + open routes to edit/viewCloud', () => {
  const local = vjCardControlsFor(statusFromItem({ where: 'local', id: 'q1', rawId: 'r1', bucket: 'queued' }));
  assert.match(local.open.onclick, /editQueuedCampaign.*r1/);
  assert.ok(local.extra.find((e) => e.kind === 'cancel'));
  const cloud = vjCardControlsFor(statusFromItem({ where: 'cloud', id: 'qc', bucket: 'queued' }));
  assert.match(cloud.open.onclick, /viewCloudCampaign\('qc'\)/);
});
