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
