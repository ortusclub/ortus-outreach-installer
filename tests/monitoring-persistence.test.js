import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { extractMonitoringSlice, MONITORING_FIELDS } from '../src/monitoring-persistence.js';

test('extractMonitoringSlice returns only the persistable fields', () => {
  const campaign = {
    id: 'c1',
    name: 'Test',
    state: 'monitoring',
    mode: 'connect_and_introduce',
    sheetUrl: 'https://sheet',
    linkedinColumn: 'URLS',
    profileIds: ['p1', 'p2'],
    profileNames: ['marife', 'ayush'],
    participatingProfileIds: ['p1', 'p2'],
    sendingEndedAt: '2026-05-13T01:00:00Z',
    monitoringUntil: '2026-05-20T01:00:00Z',
    nextCheckAt: '2026-05-13T07:00:00Z',
    logs: ['line1'],
    templates: { primaryName: 'Sam' },
    // unrelated fields that should NOT be in the slice
    workers: [{ /* huge object */ }],
    browser: { /* lol no */ },
    currentAction: 'something',
    _internalState: 'private',
  };
  const slice = extractMonitoringSlice(campaign);
  assert.equal(slice.state, 'monitoring');
  assert.equal(slice.workers, undefined);
  assert.equal(slice.browser, undefined);
  assert.equal(slice.currentAction, undefined);
  assert.equal(slice._internalState, undefined);
  // All MONITORING_FIELDS that were present should appear
  for (const k of MONITORING_FIELDS) {
    if (campaign[k] !== undefined) {
      assert.deepEqual(slice[k], campaign[k], `missing or wrong: ${k}`);
    }
  }
});

test('extractMonitoringSlice returns null for null campaign', () => {
  assert.equal(extractMonitoringSlice(null), null);
});

test('extractMonitoringSlice omits keys that are undefined on the source', () => {
  const campaign = {
    id: 'c1',
    state: 'monitoring',
    mode: 'connect_and_introduce',
  };
  const slice = extractMonitoringSlice(campaign);
  assert.equal(Object.prototype.hasOwnProperty.call(slice, 'sheetUrl'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(slice, 'sendingEndedAt'), false);
});
