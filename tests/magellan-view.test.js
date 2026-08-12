import test from 'node:test';
import assert from 'node:assert/strict';
import { magellanPct, selectionSummary } from '../public/js/magellan-view.mjs';

test('no total means no percentage', () => {
  assert.equal(magellanPct({}), 0);
  assert.equal(magellanPct({ done: 3, total: 0 }), 0);
});

test('whole accounts when nothing is mid-flight', () => {
  assert.equal(magellanPct({ done: 10, total: 12 }), 83);
});

test('a check counts its in-account fraction as the whole slice', () => {
  // 10 of 12 accounts done, and 50% through the 11th.
  assert.equal(magellanPct({ done: 10, total: 12, current: { stage: 'check', count: 50, total: 100 } }), 88);
});

test('reading the list is the front half of an account', () => {
  assert.equal(magellanPct({ done: 10, total: 12, current: { stage: 'list', count: 50, total: 100 } }), 85);
});

test('looking up IDs is the back half', () => {
  assert.equal(magellanPct({ done: 10, total: 12, current: { stage: 'ids', count: 50, total: 100 } }), 90);
});

test('it never exceeds 100', () => {
  assert.equal(magellanPct({ done: 12, total: 12, current: { stage: 'check', count: 500, total: 100 } }), 100);
});

test('the selection splits into what can go in and what cannot', () => {
  const s = selectionSummary([
    { account: 'a@o.com', importable: true },
    { account: 'b@o.com', importable: true },
    { account: 'jemely.butron@ortus.solutions', importable: false },
  ]);
  assert.equal(s.total, 3);
  assert.equal(s.usable, 2);
  assert.deepEqual(s.blocked, ['jemely.butron@ortus.solutions']);
  assert.equal(s.known, true);
});

test('one unknown account makes the whole split unknown — it never guesses', () => {
  const s = selectionSummary([
    { account: 'a@o.com', importable: true },
    { account: 'b@o.com', importable: null },
  ]);
  assert.equal(s.known, false);
  assert.deepEqual(s.blocked, []);
  assert.equal(s.usable, 2, 'with nothing known to be blocked, all of them are the honest count');
});

test('an empty selection is known and empty', () => {
  assert.deepEqual(selectionSummary([]), { total: 0, usable: 0, blocked: [], known: true });
});
