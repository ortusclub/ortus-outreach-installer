import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickInvitation, isAcceptLabel } from '../src/linkedin/accept-invitation.js';

test('isAcceptLabel matches accept verbs across locales', () => {
  assert.equal(isAcceptLabel('Accept'), true);                                   // EN
  assert.equal(isAcceptLabel('Kontaktanfrage von Tony Otto annehmen'), true);    // DE (the live bug)
  assert.equal(isAcceptLabel('Accetta'), true);                                  // IT
  assert.equal(isAcceptLabel('Accepter'), true);                                 // FR
  assert.equal(isAcceptLabel('Aceptar'), true);                                  // ES
  assert.equal(isAcceptLabel('Aceitar'), true);                                  // PT
  assert.equal(isAcceptLabel('Tanggapin'), true);                                // TL (Tagalog/Filipino)
  assert.equal(isAcceptLabel('Tanggapin ang imbitasyon ni Juan Dela Cruz'), true); // TL aria-label form
});

test('isAcceptLabel rejects ignore/decline verbs — never clicks Ignore', () => {
  assert.equal(isAcceptLabel('Kontaktanfrage von Tony Otto ignorieren'), false); // DE ignore
  assert.equal(isAcceptLabel('Ignore'), false);
  assert.equal(isAcceptLabel('Rifiuta'), false);                                 // IT decline
  assert.equal(isAcceptLabel('Rechazar'), false);                               // ES decline
  assert.equal(isAcceptLabel('Huwag pansinin'), false);                          // TL ignore
  assert.equal(isAcceptLabel('Balewalain'), false);                             // TL ignore (alt)
  assert.equal(isAcceptLabel('Tanggihan'), false);                             // TL decline — must NEVER accept (look-alike of Tanggapin)
  assert.equal(isAcceptLabel(''), false);
  assert.equal(isAcceptLabel(null), false);
});

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
