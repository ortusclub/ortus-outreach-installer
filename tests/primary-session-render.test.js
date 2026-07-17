import { test } from 'node:test';
import assert from 'node:assert/strict';
import { primarySessionBadge } from '../public/js/primary-session-render.mjs';

test('needs_login → visible badge with name + red class', () => {
  const r = primarySessionBadge({ state: 'needs_login', name: 'Antonio', parked: 3 });
  assert.deepEqual(r, { show: true, text: '⚠ Primary needs login — Antonio', cls: 'needs-login' });
});

test('needs_login with no name falls back to a generic label', () => {
  const r = primarySessionBadge({ state: 'needs_login', parked: 1 });
  assert.equal(r.show, true);
  assert.match(r.text, /^⚠ Primary needs login — /);
});

test('live state renders nothing (no green noise)', () => {
  const r = primarySessionBadge({ state: 'live', name: 'Antonio' });
  assert.equal(r.show, false);
});

test('none state renders nothing', () => {
  const r = primarySessionBadge({ state: 'none' });
  assert.equal(r.show, false);
});

test('null / undefined render nothing', () => {
  assert.equal(primarySessionBadge(null).show, false);
  assert.equal(primarySessionBadge(undefined).show, false);
});

test('unknown state renders nothing (defensive default)', () => {
  assert.equal(primarySessionBadge({ state: 'bogus', name: 'X' }).show, false);
});
