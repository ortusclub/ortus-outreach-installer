import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inviteAriaMatchesLeadName, leadNameFromTitle } from '../src/linkedin/helpers.js';

// v2.113.x — wrong-person send guard. A LinkedIn profile page carries many
// "Invite <name> to connect" buttons (the lead's own, plus "People you may
// know" / "More profiles for you" recommendations). The connect flow must only
// click the LEAD's own button. This helper decides whether a given aria-label
// refers to the intended lead, so a note for "Mary" can never fire on a
// recommended "Dr David Foo" (the 2026-06-22 incident).

test('matches the lead\'s own invite label', () => {
  assert.equal(inviteAriaMatchesLeadName('Invite Mary Kathleen L. to connect', 'Mary'), true);
});

test('rejects a different person — the David Foo wrong-send', () => {
  assert.equal(inviteAriaMatchesLeadName('Invite Dr David Foo to connect', 'Mary'), false);
});

test('word-boundary: "mary" must NOT match "Rosemary"', () => {
  assert.equal(inviteAriaMatchesLeadName('Invite Rosemary Tan to connect', 'mary'), false);
});

test('case-insensitive', () => {
  assert.equal(inviteAriaMatchesLeadName('INVITE MARY TO CONNECT', 'mary'), true);
});

test('first name embedded mid-label still matches on a boundary', () => {
  assert.equal(inviteAriaMatchesLeadName('Invite Mary Kathleen L. to connect', 'mary'), true);
});

test('not an invite label (e.g. a Follow button) → false', () => {
  assert.equal(inviteAriaMatchesLeadName('Follow Mary Kathleen L.', 'Mary'), false);
});

test('empty lead name → false (cannot confirm identity)', () => {
  assert.equal(inviteAriaMatchesLeadName('Invite Mary to connect', ''), false);
});

test('empty / nullish aria → false', () => {
  assert.equal(inviteAriaMatchesLeadName('', 'Mary'), false);
  assert.equal(inviteAriaMatchesLeadName(null, 'Mary'), false);
});

test('accented name is treated as a whole word', () => {
  assert.equal(inviteAriaMatchesLeadName('Invite José Ramos to connect', 'José'), true);
});

// ── full-name (first + last) binding, v2.113.x ──────────────────────────────
test('full name matches the lead\'s own button (Choon)', () => {
  assert.equal(inviteAriaMatchesLeadName('Invite Choon Khee Koh to connect', 'Choon Khee Koh'), true);
});

test('full name rejects a recommendation with a different name', () => {
  assert.equal(inviteAriaMatchesLeadName('Invite Claire Ki to connect', 'Choon Khee Koh'), false);
});

test('same first name, different last name is rejected (David Smith ≠ David Foo)', () => {
  assert.equal(inviteAriaMatchesLeadName('Invite David Foo to connect', 'David Smith'), false);
});

test('credential suffixes after the surname still match', () => {
  assert.equal(inviteAriaMatchesLeadName('Invite Pauline Loo MBA (NTU), MSc, BA (NUS) to connect', 'Pauline Loo'), true);
});

test('a dropped middle name still matches on first + last', () => {
  // The label may omit the middle name the top-card h1 carries.
  assert.equal(inviteAriaMatchesLeadName('Invite Choon Koh to connect', 'Choon Khee Koh'), true);
});

test('initials in the lead name are ignored, not required', () => {
  assert.equal(inviteAriaMatchesLeadName('Invite Mary Kathleen to connect', 'Mary Kathleen L.'), true);
});

// ── leadNameFromTitle: rescue when the profile <h1> is empty (Choon, v2.113.x) ──
test('title → name: simple "Name | LinkedIn"', () => {
  assert.equal(leadNameFromTitle('Choon Khee Koh | LinkedIn'), 'Choon Khee Koh');
});

test('title → name: strips a "(3)" notification count prefix', () => {
  assert.equal(leadNameFromTitle('(3) Choon Khee Koh | LinkedIn'), 'Choon Khee Koh');
});

test('title → name: drops a headline after " - "', () => {
  assert.equal(leadNameFromTitle('Mary Kathleen L. - Product Marketing | LinkedIn'), 'Mary Kathleen L.');
});

test('title → name: en-dash separator', () => {
  assert.equal(leadNameFromTitle('José Ramos – CEO | LinkedIn'), 'José Ramos');
});

test('title → name: a hyphenated name is preserved (no surrounding spaces)', () => {
  assert.equal(leadNameFromTitle('Anne-Marie Smith | LinkedIn'), 'Anne-Marie Smith');
});

test('title → name: empty / nullish', () => {
  assert.equal(leadNameFromTitle(''), '');
  assert.equal(leadNameFromTitle(null), '');
});
