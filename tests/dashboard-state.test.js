import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickDefaultTab,
  computeCrossTabQualifier,
  addToSelection,
  removeFromSelection,
  toggleInSelection,
} from '../src/dashboard-state.js';

test('pickDefaultTab: returns "monitoring" when monitoring has entries', () => {
  const counts = { active: 0, monitoring: 3, queued: 0, schedules: 0, drafts: 0, past: 5, all: 8 };
  assert.equal(pickDefaultTab(counts), 'monitoring');
});

test('pickDefaultTab: returns "active" when monitoring empty but active populated', () => {
  const counts = { active: 1, monitoring: 0, queued: 0, schedules: 0, drafts: 0, past: 5, all: 6 };
  assert.equal(pickDefaultTab(counts), 'active');
});

test('pickDefaultTab: returns "all" when both monitoring and active empty', () => {
  const counts = { active: 0, monitoring: 0, queued: 2, schedules: 0, drafts: 1, past: 5, all: 8 };
  assert.equal(pickDefaultTab(counts), 'all');
});

test('pickDefaultTab: respects persisted tab when provided and that tab has rows', () => {
  const counts = { active: 0, monitoring: 3, queued: 0, schedules: 0, drafts: 0, past: 5, all: 8 };
  assert.equal(pickDefaultTab(counts, 'past'), 'past');
});

test('pickDefaultTab: falls back from persisted-but-empty tab to monitoring default', () => {
  const counts = { active: 0, monitoring: 3, queued: 0, schedules: 0, drafts: 0, past: 0, all: 3 };
  assert.equal(pickDefaultTab(counts, 'past'), 'monitoring');
});

test('computeCrossTabQualifier: returns empty when all selected ids are in active tab', () => {
  const selection = new Set(['m1', 'm2']);
  const idsByTab = { active: ['a1'], monitoring: ['m1', 'm2', 'm3'], past: ['p1'] };
  const result = computeCrossTabQualifier(selection, 'monitoring', idsByTab);
  assert.equal(result, '');
});

test('computeCrossTabQualifier: reports count when selection spans tabs', () => {
  const selection = new Set(['m1', 'p1', 'p2']);
  const idsByTab = { active: ['a1'], monitoring: ['m1', 'm2'], past: ['p1', 'p2'] };
  const result = computeCrossTabQualifier(selection, 'monitoring', idsByTab);
  assert.equal(result, '· 2 IN OTHER TABS');
});

test('computeCrossTabQualifier: works when active tab has zero selected', () => {
  const selection = new Set(['p1', 'p2']);
  const idsByTab = { active: ['a1'], monitoring: ['m1'], past: ['p1', 'p2'] };
  const result = computeCrossTabQualifier(selection, 'monitoring', idsByTab);
  assert.equal(result, '· 2 IN OTHER TABS');
});

test('addToSelection: adds an id (returns new Set, leaves input unchanged)', () => {
  const input = new Set(['a']);
  const out = addToSelection(input, 'b');
  assert.deepEqual([...out], ['a', 'b']);
  assert.deepEqual([...input], ['a']);
});

test('removeFromSelection: removes an id', () => {
  const input = new Set(['a', 'b']);
  const out = removeFromSelection(input, 'a');
  assert.deepEqual([...out], ['b']);
});

test('toggleInSelection: adds when absent, removes when present', () => {
  let s = new Set();
  s = toggleInSelection(s, 'x');
  assert.deepEqual([...s], ['x']);
  s = toggleInSelection(s, 'x');
  assert.deepEqual([...s], []);
});
