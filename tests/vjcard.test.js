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
// Regression: statusFromItem is a WHITELIST, so a field the card reads but this
// function drops is silently always-undefined. _fgFinishedNote returns null the
// moment `bucket` is missing, which killed the "ran out of invite credits" line
// on every board card; the pills need benchAccounts and the chip needs dupes.
test('statusFromItem: carries the fields the finished-FG note and dupe chip read', () => {
  const accounts = [{ profileId: 'p1', credits: { available: 0, allowance: 30, refill: 'August 31, 2026' } }];
  const s = statusFromItem({ where: 'cloud', bucket: 'done', isFG: true, benchAccounts: accounts, dupes: 2 });
  assert.equal(s.bucket, 'done');
  assert.deepEqual(s.benchAccounts, accounts);
  assert.equal(s.dupes, 2);
});
test('statusFromItem: absent benchAccounts/dupes are null and 0, never undefined', () => {
  const s = statusFromItem({ where: 'cloud', bucket: 'done' });
  assert.equal(s.benchAccounts, null);
  assert.equal(s.dupes, 0);
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
// The expanded strip's OPEN must use the SAME handler as the collapsed strip's
// footer (openRunningCampaignReadOnly) — it is the only one that binds card #2's
// Live Status to the campaign and sets the Cloud VM run target.
test('controls: running cloud → stop + Show, no pause, no bulk, open=openRunningCampaignReadOnly', () => {
  const c = vjCardControlsFor(statusFromItem({ where: 'cloud', id: 'c1', bucket: 'running' }));
  assert.match(c.open.onclick, /openRunningCampaignReadOnly\('c1'\)/);
  assert.equal(c.pause, null);
  assert.equal(c.bulk, null);
  assert.match(c.stop.onclick, /stopCloudCampaignUI\('c1'\)/);
  assert.ok(c.extra.find((e) => e.kind === 'show'));
});
test('controls: monitoring cloud → check-now bulk + auto toggle + stop monitoring', () => {
  const c = vjCardControlsFor(statusFromItem({ where: 'cloud', id: 'c9', bucket: 'running', monitoring: true, autoChecksEnabled: true }));
  // Same OPEN handler as a sending cloud campaign — monitoring is still live, so
  // it must bind card #2, not drop into the cockpit view.
  assert.match(c.open.onclick, /openRunningCampaignReadOnly\('c9'\)/);
  // `this` is passed so the button disables while the check runs. cloudCheckNow
  // itself routes to the local check when the campaign has been handed to this
  // Mac — the ownership gate lives in that function, not in this onclick.
  assert.match(c.bulk.onclick, /cloudCheckNow\('c9',this\)/);
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
test('controls: done → duplicate + delete, no bulk/stop/pause', () => {
  const cloud = vjCardControlsFor(statusFromItem({ where: 'cloud', id: 'cD', bucket: 'done' }));
  assert.equal(cloud.bulk, null);
  assert.equal(cloud.stop, null);
  assert.ok(cloud.extra.find((e) => e.kind === 'dup'));
  assert.ok(cloud.extra.find((e) => e.kind === 'delete' && /deleteBoardCampaign/.test(e.onclick)));
  const local = vjCardControlsFor(statusFromItem({ where: 'local', id: 'h1', bucket: 'done', hist: true }));
  assert.ok(local.extra.find((e) => e.kind === 'debrief'));
});
test('controls: a nasty local done id (quote / angle brackets) is escaped in onclicks', () => {
  const c = vjCardControlsFor(statusFromItem({ where: 'local', id: "h-O'Brien <b>Q3</b>", bucket: 'done', hist: true }));
  const del = c.extra.find((e) => e.kind === 'delete');
  // no raw apostrophe that would terminate the JS string, no raw angle brackets
  assert.ok(!/deleteBoardCampaign\('h-O'Brien/.test(del.onclick), 'apostrophe must be JS-escaped');
  assert.match(del.onclick, /O\\'Brien/);
  assert.ok(!del.onclick.includes('<b>'), 'angle brackets must be HTML-escaped');
  assert.match(del.onclick, /&lt;b&gt;/);
});

test('controls: queued → cancel + open routes to edit/viewCloud', () => {
  const local = vjCardControlsFor(statusFromItem({ where: 'local', id: 'q1', rawId: 'r1', bucket: 'queued' }));
  assert.match(local.open.onclick, /editQueuedCampaign.*r1/);
  assert.ok(local.extra.find((e) => e.kind === 'cancel'));
  const cloud = vjCardControlsFor(statusFromItem({ where: 'cloud', id: 'qc', bucket: 'queued' }));
  assert.match(cloud.open.onclick, /viewCloudCampaign\('qc'\)/);
});

test('a cloud monitoring campaign with unsent leads offers Resume sending', () => {
  const c = vjCardControlsFor({
    _cloud: true, id: 'c1', state: 'monitoring', pending: 793,
  });
  const resume = c.extra.find((x) => x.kind === 'play');
  assert.ok(resume, 'a campaign that stopped sending early must offer a way back');
  assert.match(resume.onclick, /restartCloudCampaignUI\('c1', ?false\)/,
    'continue where it left off — never restart from the beginning');
});

test('a cloud monitoring campaign that FINISHED sending offers no Resume', () => {
  const c = vjCardControlsFor({
    _cloud: true, id: 'c1', state: 'monitoring', pending: 0,
  });
  assert.equal(c.extra.find((x) => x.kind === 'play'), undefined,
    'nothing left to send — the button would re-open leads that are already done');
});

test('Stop monitoring and Run check now survive on the monitoring card', () => {
  const c = vjCardControlsFor({
    _cloud: true, id: 'c1', state: 'monitoring', pending: 793,
  });
  assert.ok(c.stop, 'Stop monitoring must not be displaced');
  assert.ok(c.bulk, 'Run check now must not be displaced');
});

test('statusFromItem carries pending through to the card', () => {
  const s = statusFromItem({ where: 'cloud', id: 'c1', monitoring: true, pending: 793 });
  assert.equal(s.pending, 793,
    'without this the control matrix cannot tell a stalled campaign from a finished one');
});
