import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickInvitation } from '../src/linkedin/accept-invitation.js';

test('pickInvitation matches the sender by name', () => {
  const candidates = [
    { name: 'Alice Brown', profileUrl: 'https://lnkd/in/alice' },
    { name: 'Patrick Smith', profileUrl: 'https://lnkd/in/patrick' },
  ];
  const r = pickInvitation(candidates, { name: 'Patrick Smith', profileUrl: '' });
  assert.equal(r.index, 1);
  assert.ok(r.reason);
});

test('pickInvitation returns no-match when nobody matches', () => {
  const candidates = [{ name: 'Alice Brown', profileUrl: '' }];
  const r = pickInvitation(candidates, { name: 'Patrick Smith', profileUrl: '' });
  assert.equal(r.index, null);
});

test('pickInvitation prefers an exact profileUrl corroboration when present', () => {
  const candidates = [
    { name: 'Pat S.', profileUrl: 'https://www.linkedin.com/in/patrick-smith' },
    { name: 'Patrick Smith', profileUrl: 'https://www.linkedin.com/in/someone-else' },
  ];
  const r = pickInvitation(candidates, {
    name: 'Patrick Smith', profileUrl: 'https://www.linkedin.com/in/patrick-smith',
  });
  assert.equal(r.index, 0);
  assert.equal(r.reason, 'profile-url');
});

test('pickInvitation accepts nothing on empty candidates', () => {
  assert.equal(pickInvitation([], { name: 'X' }).index, null);
});

test('SAFETY: a short-token name overlap must NOT accept a stranger', () => {
  // "Al Smith" tokens both prefix "Alice Smith-Jones" — the old token-prefix
  // tier would have falsely accepted. Exact-only must reject.
  const r = pickInvitation([{ name: 'Alice Smith-Jones', profileUrl: '' }], { name: 'Al Smith', profileUrl: '' });
  assert.equal(r.index, null);
});

test('SAFETY: a non-exact name with no URL is rejected', () => {
  const r = pickInvitation([{ name: 'Patrick Smith Jr', profileUrl: '' }], { name: 'Patrick Smith', profileUrl: '' });
  assert.equal(r.index, null);
});

test('reason is exact-name when matched purely by name', () => {
  const r = pickInvitation([{ name: 'Patrick Smith', profileUrl: '' }], { name: 'Patrick Smith', profileUrl: '' });
  assert.equal(r.index, 0);
  assert.equal(r.reason, 'exact-name');
});
