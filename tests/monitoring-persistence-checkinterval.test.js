import { test } from 'node:test';
import assert from 'node:assert';
import { extractMonitoringSlice, MONITORING_FIELDS } from '../src/monitoring-persistence.js';

test('extractMonitoringSlice round-trips checkIntervalMinutes', () => {
  const campaign = {
    id: 'c1',
    name: 'test',
    state: 'monitoring',
    mode: 'connect_and_introduce',
    checkIntervalMinutes: 30,
    nextCheckAt: '2026-05-15T10:00:00.000Z',
  };
  const slice = extractMonitoringSlice(campaign);
  assert.equal(slice.checkIntervalMinutes, 30);
  assert.ok(MONITORING_FIELDS.includes('checkIntervalMinutes'));
});

test('extractMonitoringSlice omits checkIntervalMinutes when undefined', () => {
  const campaign = { id: 'c1', state: 'monitoring' };
  const slice = extractMonitoringSlice(campaign);
  assert.equal(slice.checkIntervalMinutes, undefined);
});
