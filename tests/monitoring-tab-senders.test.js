import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveMonitoringTabSenders } from '../src/monitoring-tab-senders.js';
import { monitoringProfilesForRun } from '../src/campaign-state-transitions.js';

test('explicit keep-monitoring schedules selected accounts even when this run sent nothing', () => {
  assert.deepEqual(monitoringProfilesForRun(['local-browser'], new Set(), true), ['local-browser']);
  assert.deepEqual(monitoringProfilesForRun(['local-browser'], new Set(), false), []);
  assert.deepEqual(monitoringProfilesForRun(['local-browser', 'go-2'], new Set(['go-2']), true), ['go-2', 'local-browser']);
});

test('tab monitoring includes older senders and the local browser once each', () => {
  const rows = [
    { Sender: 'You' }, { Sender: 'You' },
    { Sender: 'linked@ortusclub.com' },
    { Sender: 'Local Browser' },
    { Sender: 'missing@example.com' },
  ];
  const profiles = [{ id: 'go-1', name: 'linked@ortusclub.com' }];
  const result = resolveMonitoringTabSenders(rows, profiles);
  assert.deepEqual(result.ids, ['local-browser', 'go-1']);
  assert.deepEqual(result.names, { 'local-browser': 'You', 'go-1': 'linked@ortusclub.com' });
  assert.deepEqual(result.unresolved, ['missing@example.com']);
});

test('tab monitoring accepts the legacy Account Used column', () => {
  const result = resolveMonitoringTabSenders([{ 'Account Used': 'local-browser - manual' }], []);
  assert.deepEqual(result.ids, ['local-browser']);
});

test('tab monitoring refuses ambiguous sender names across workspaces', () => {
  const result = resolveMonitoringTabSenders([{ Sender: 'shared@example.com' }], [
    { id: 'a', name: 'shared@example.com' }, { id: 'b', name: 'shared@example.com' },
  ]);
  assert.deepEqual(result.ids, []);
  assert.deepEqual(result.unresolved, ['shared@example.com']);
});
