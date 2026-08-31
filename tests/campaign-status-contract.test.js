import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isCampaignStatusSnapshot,
  overlayCampaignStatus,
  selectCampaignStatusSnapshot,
} from '../public/js/campaign-status-contract.mjs';

const snapshot = (overrides = {}) => ({
  contractVersion: 1,
  campaignId: 'pilot',
  campaignName: 'SAS EMEA VIE - 26.08 ANTONIO',
  sequence: 10,
  observedAt: 100,
  lifecycle: 'running',
  activity: 'sending',
  runtime: 'vm',
  headline: 'Working on Benjamin Lombardo',
  detail: 'Checking connection status',
  safety: '17 pending leads remain safe',
  currentAccount: 'riccardo',
  currentLead: 'Benjamin Lombardo',
  progress: { completed: 107, pending: 17, batchDone: 2, batchSize: 8, accountsChecked: 0, accountsExpected: 3 },
  next: { checkAt: null, resumeAt: null, action: '' },
  ...overrides,
});

test('validates the versioned engine snapshot', () => {
  assert.equal(isCampaignStatusSnapshot(snapshot()), true);
  assert.equal(isCampaignStatusSnapshot({ ...snapshot(), contractVersion: 2 }), false);
});

test('a stale response cannot repaint a newer lead', () => {
  const oldBenjamin = snapshot();
  const currentKevin = snapshot({ sequence: 11, observedAt: 110, headline: 'Working on Kevin Bialka', currentLead: 'Kevin Bialka' });
  assert.equal(selectCampaignStatusSnapshot(oldBenjamin, currentKevin), currentKevin);
  assert.equal(selectCampaignStatusSnapshot(currentKevin, oldBenjamin), currentKevin);
});

test('observedAt orders snapshots that share a durable sequence', () => {
  const first = snapshot({ observedAt: 100 });
  const second = snapshot({ observedAt: 101, headline: 'Profile ready' });
  assert.equal(selectCampaignStatusSnapshot(first, second), second);
  assert.equal(selectCampaignStatusSnapshot(second, first), second);
});

test('visible audit logs cannot overwrite the canonical headline', () => {
  const legacy = { logs: [{ line: 'Benjamin Lombardo · introduced' }], currentAction: { label: 'Benjamin Lombardo · introduced' } };
  const current = snapshot({ sequence: 11, headline: 'Working on Kevin Bialka', currentLead: 'Kevin Bialka' });
  const view = overlayCampaignStatus(legacy, current);
  assert.equal(view.currentAction.label, 'Working on Kevin Bialka');
  assert.equal(view.logs, legacy.logs);
});

test('VM and This Mac use the same presentation contract', () => {
  const vm = overlayCampaignStatus({}, snapshot({ runtime: 'vm' }));
  const local = overlayCampaignStatus({}, snapshot({ runtime: 'local' }));
  assert.equal(vm.currentAction.label, local.currentAction.label);
  assert.equal(vm.currentAction.phase, local.currentAction.phase);
  assert.equal(vm.runsOn, 'vm');
  assert.equal(local.runsOn, 'local');
});

test('monitoring is blue-state waiting and not active sending', () => {
  const view = overlayCampaignStatus({}, snapshot({
    lifecycle: 'monitoring', activity: 'waiting', headline: 'Waiting for the next acceptance check',
    next: { checkAt: '2026-08-27T14:13:00Z', resumeAt: null, action: '' },
  }));
  assert.equal(view.state, 'monitoring');
  assert.equal(view.monitoring, true);
  assert.equal(view.currentAction.phase, 'monitoring');
  assert.equal(view.live, false);
});

test('checking remains monitoring lifecycle but owns the live workflow', () => {
  const view = overlayCampaignStatus({}, snapshot({
    lifecycle: 'monitoring', activity: 'checking', headline: 'Reading recent connections',
    currentAccount: 'damiano', currentLead: '',
    progress: { completed: 95, pending: 253, batchDone: 0, batchSize: 0, accountsChecked: 1, accountsExpected: 3 },
  }));
  assert.equal(view.monitoring, true);
  assert.equal(view.monitoringCheckInProgress, true);
  assert.equal(view.currentAction.phase, 'checking');
  assert.equal(view.currentAction.account, 'damiano');
});

test('pause, stop, and completion are explicit terminal presentations', () => {
  const paused = overlayCampaignStatus({}, snapshot({ lifecycle: 'paused', activity: 'paused', headline: 'Campaign paused safely' }));
  const stopped = overlayCampaignStatus({}, snapshot({ lifecycle: 'stopped', activity: 'idle', headline: 'Campaign stopped' }));
  const done = overlayCampaignStatus({}, snapshot({ lifecycle: 'done', activity: 'idle', headline: 'Campaign complete' }));
  assert.equal(paused.paused, true);
  assert.equal(paused.currentAction.phase, 'paused');
  assert.equal(stopped.running, false);
  assert.equal(stopped.currentAction.phase, 'done');
  assert.equal(done.running, false);
  assert.equal(done.currentAction.label, 'Campaign complete');
});

test('a browser-close revision clears the last lead instead of pinning it', () => {
  const liveLead = snapshot({ sequence: 20, observedAt: 200, currentLead: 'Kevin Bialka', headline: 'Working on Kevin Bialka' });
  const betweenAccounts = snapshot({
    sequence: 21, observedAt: 201, activity: 'starting', currentAccount: '', currentLead: '',
    headline: 'Sending is active', detail: 'Waiting for the next verified engine update.',
  });
  const selected = selectCampaignStatusSnapshot(liveLead, betweenAccounts);
  const view = overlayCampaignStatus({}, selected);
  assert.equal(view.currentAction.label, 'Sending is active');
  assert.equal(view.currentAction.lead, '');
});

test('invalid or absent snapshots preserve the legacy fallback', () => {
  const legacy = { state: 'monitoring', currentAction: { label: 'legacy' } };
  assert.equal(overlayCampaignStatus(legacy, null), legacy);
  assert.equal(selectCampaignStatusSnapshot(null, null), null);
});
