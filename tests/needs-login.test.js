import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildNeedsLoginUpdates } from '../src/campaign.js';

const rows = () => [
  { 'First Name': 'Jane', 'LinkedIn URL': 'https://linkedin.com/in/jane', 'Sender': 'kenya5@ortus.solutions' },
  { 'First Name': 'Bob',  'LinkedIn URL': 'https://linkedin.com/in/bob',  'Sender': 'kenya5@ortus.solutions' },
  { 'First Name': 'Sue',  'LinkedIn URL': 'https://linkedin.com/in/sue',  'Sender': 'someone-else@ortus.solutions' },
  { 'First Name': 'NoUrl','LinkedIn URL': '',                              'Sender': 'kenya5@ortus.solutions' },
];

test('flags every row owned by the account with Y', () => {
  const updates = buildNeedsLoginUpdates(rows(), 'kenya5@ortus.solutions', '', 'LinkedIn URL', 'Y');
  assert.equal(updates.length, 2, 'two rows have a sender match AND a URL');
  assert.deepEqual(updates.map(u => u.linkedinUrl).sort(), [
    'https://linkedin.com/in/bob', 'https://linkedin.com/in/jane',
  ]);
  assert.ok(updates.every(u => u.needsLogin === 'Y'));
});

test('clear builds the same rows with an empty value', () => {
  const updates = buildNeedsLoginUpdates(rows(), 'kenya5@ortus.solutions', '', 'LinkedIn URL', '');
  assert.equal(updates.length, 2);
  assert.ok(updates.every(u => u.needsLogin === ''));
});

test('rows assigned to a different account are excluded', () => {
  const updates = buildNeedsLoginUpdates(rows(), 'kenya5@ortus.solutions', '', 'LinkedIn URL', 'Y');
  assert.ok(!updates.some(u => u.linkedinUrl === 'https://linkedin.com/in/sue'));
});

test('account match is case-insensitive and trimmed', () => {
  const updates = buildNeedsLoginUpdates(rows(), '  KENYA5@ortus.solutions ', '', 'LinkedIn URL', 'Y');
  assert.equal(updates.length, 2);
});

test('empty account name yields no updates', () => {
  assert.deepEqual(buildNeedsLoginUpdates(rows(), '', '', 'LinkedIn URL', 'Y'), []);
  assert.deepEqual(buildNeedsLoginUpdates(rows(), null, '', 'LinkedIn URL', 'Y'), []);
});

test('senderColumn override is honored when provided', () => {
  const r = [
    { 'LinkedIn URL': 'https://linkedin.com/in/x', 'Sender': 'wrong', 'Account Used': 'kenya5' },
    { 'LinkedIn URL': 'https://linkedin.com/in/y', 'Sender': 'kenya5', 'Account Used': 'other' },
  ];
  const updates = buildNeedsLoginUpdates(r, 'kenya5', 'Account Used', 'LinkedIn URL', 'Y');
  assert.equal(updates.length, 1);
  assert.equal(updates[0].linkedinUrl, 'https://linkedin.com/in/x');
});
