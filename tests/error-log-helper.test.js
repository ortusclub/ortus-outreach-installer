import { test } from 'node:test';
import assert from 'node:assert/strict';

// Test target: the cap-and-trim behavior the helper must enforce.
// We test the pure logic: given an existing array + a new entry + a cap,
// produce the right output array. The disk-write side is covered by the
// integration smoke test (manual browser verification).

function appendCapped(existing, entry, cap) {
  const next = [...existing, entry];
  if (next.length > cap) next.splice(0, next.length - cap);
  return next;
}

test('appendCapped under cap returns appended', () => {
  const out = appendCapped([{ a: 1 }, { a: 2 }], { a: 3 }, 5);
  assert.equal(out.length, 3);
  assert.equal(out[2].a, 3);
});

test('appendCapped at cap drops oldest', () => {
  const out = appendCapped([{ a: 1 }, { a: 2 }, { a: 3 }], { a: 4 }, 3);
  assert.equal(out.length, 3);
  assert.equal(out[0].a, 2);
  assert.equal(out[2].a, 4);
});

test('appendCapped well over cap drops to exactly cap entries', () => {
  const existing = Array.from({ length: 600 }, (_, i) => ({ i }));
  const out = appendCapped(existing, { i: 600 }, 500);
  assert.equal(out.length, 500);
  // First retained entry should be index 101 (we dropped 0..100, kept 101..600)
  assert.equal(out[0].i, 101);
  assert.equal(out[499].i, 600);
});
