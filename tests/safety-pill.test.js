// The pending-lead count is the one number on the live card that decides
// whether the operator has to act, and it was set in .7rem mono inside a pill
// the eye skips (operator, 2026-08-28, looking at "92 pending leads remain
// safely queued · sending is stopped"). The card now leads the pill with that
// number and tints it gold — this is the split that makes both possible.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitSafetyCount } from '../public/js/live-activity.mjs';

test('the leading count comes out of the sentence', () => {
  const r = splitSafetyCount('92 pending leads remain safely queued · sending is stopped');
  assert.equal(r.count, '92');
  assert.equal(r.rest, 'pending leads remain safely queued · sending is stopped');
  assert.equal(r.pending, true);
});

test('zero is not pending — the pill stays quiet when there is no work left', () => {
  const r = splitSafetyCount('0 pending leads remain safely queued · sending is complete');
  assert.equal(r.count, '0');
  assert.equal(r.pending, false);
});

test('the singular wording splits the same way', () => {
  assert.deepEqual(splitSafetyCount('1 lead remains safely queued'),
    { count: '1', rest: 'lead remains safely queued', pending: true });
});

test('a sentence that does not start with a number is left alone', () => {
  const r = splitSafetyCount('Nothing is queued');
  assert.equal(r.count, null);
  assert.equal(r.rest, 'Nothing is queued');
  assert.equal(r.pending, false);
});

test('a missing string never claims work is waiting', () => {
  for (const v of [undefined, null, '']) {
    const r = splitSafetyCount(v);
    assert.equal(r.count, null);
    assert.equal(r.pending, false);
    assert.equal(r.rest, '');
  }
});
