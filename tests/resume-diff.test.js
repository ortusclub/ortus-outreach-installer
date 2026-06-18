// tests/resume-diff.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSheetDiff } from '../src/resume-diff.js';

const urlOf = (row) => row.url;

test('computeSheetDiff: new URLs are added, sent/identical untouched', () => {
  const prev = [{ url: 'https://linkedin.com/in/a', name: 'A' }];
  const next = [
    { url: 'https://linkedin.com/in/a', name: 'A' },
    { url: 'https://linkedin.com/in/b', name: 'B' },
  ];
  const d = computeSheetDiff(prev, next, urlOf);
  assert.equal(d.addedCount, 1);
  assert.equal(d.added[0].url, 'https://linkedin.com/in/b');
  assert.equal(d.updatedCount, 0);
  assert.equal(d.newTotal, 2);
});

test('computeSheetDiff: same URL with changed cell values is an update', () => {
  const prev = [{ url: 'https://linkedin.com/in/a', title: 'CEO' }];
  const next = [{ url: 'https://linkedin.com/in/a', title: 'Founder' }];
  const d = computeSheetDiff(prev, next, urlOf);
  assert.equal(d.addedCount, 0);
  assert.equal(d.updatedCount, 1);
  assert.equal(d.updatedPending[0].title, 'Founder');
});

test('computeSheetDiff: URL normalization (trailing slash / query / case)', () => {
  const prev = [{ url: 'https://linkedin.com/in/a' }];
  const next = [{ url: 'https://linkedin.com/in/A/?utm=x' }];
  const d = computeSheetDiff(prev, next, urlOf);
  assert.equal(d.addedCount, 0);
  assert.equal(d.updatedCount, 0);
});

test('computeSheetDiff: rows without a URL are ignored', () => {
  const d = computeSheetDiff([], [{ url: '' }, { url: null }], urlOf);
  assert.equal(d.addedCount, 0);
  assert.equal(d.newTotal, 2);
});

import {
  computeAccountDiff, computeSettingsDiff, summarizeResumeChanges,
} from '../src/resume-diff.js';

test('computeAccountDiff: added / benched / reEnabled', () => {
  const prev = { ids: ['p1', 'p2'], benched: ['p2'], names: { p1: 'A', p2: 'B' } };
  const next = { ids: ['p1', 'p2', 'p3'], benched: ['p1'], names: { p1: 'A', p2: 'B', p3: 'C' } };
  const d = computeAccountDiff(prev, next);
  assert.deepEqual(d.added, [{ id: 'p3', name: 'C' }]);
  assert.deepEqual(d.benched, [{ id: 'p1', name: 'A' }]);
  assert.deepEqual(d.reEnabled, [{ id: 'p2', name: 'B' }]);
  assert.deepEqual(d.removed, []);
});

test('computeSettingsDiff: dailyLimit + cadence + templates-changed', () => {
  const snap = { dailyLimit: 50, checkIntervalMinutes: 60, templates: { ccDmBody: 'hi' } };
  const cur = { dailyLimit: 40, checkIntervalMinutes: 60, templates: { ccDmBody: 'yo' } };
  const d = computeSettingsDiff(snap, cur);
  assert.equal(d.find(c => c.key === 'dailyLimit').from, 50);
  assert.equal(d.find(c => c.key === 'dailyLimit').to, 40);
  assert.equal(d.some(c => c.key === 'cadence'), false);
  assert.equal(d.find(c => c.key === 'templates').changed, true);
});

test('summarizeResumeChanges: isEmpty true when nothing changed', () => {
  const empty = summarizeResumeChanges({
    sheetDiff: { added: [], updatedPending: [], addedCount: 0, updatedCount: 0, newTotal: 5 },
    accountDiff: { added: [], removed: [], benched: [], reEnabled: [] },
    settingsDiff: [],
  });
  assert.equal(empty.isEmpty, true);
});

test('summarizeResumeChanges: isEmpty false when any group has a change', () => {
  const s = summarizeResumeChanges({
    sheetDiff: { added: [{}], updatedPending: [], addedCount: 1, updatedCount: 0, newTotal: 6 },
    accountDiff: { added: [], removed: [], benched: [], reEnabled: [] },
    settingsDiff: [],
  });
  assert.equal(s.isEmpty, false);
  assert.equal(s.sheet.addedCount, 1);
});
