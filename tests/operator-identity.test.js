import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPlausibleEmail } from '../src/operator-identity.js';

test('isPlausibleEmail: accepts ordinary work emails', () => {
  assert.equal(isPlausibleEmail('alecx@ortus.solutions'), true);
  assert.equal(isPlausibleEmail('  micha.cunanan@klabber.co  '), true);
  assert.equal(isPlausibleEmail('a.b-c+tag@sub.example.com'), true);
});

test('isPlausibleEmail: rejects blanks and obvious garbage', () => {
  assert.equal(isPlausibleEmail(''), false);
  assert.equal(isPlausibleEmail(null), false);
  assert.equal(isPlausibleEmail('not-an-email'), false);
  assert.equal(isPlausibleEmail('nope@'), false);
  assert.equal(isPlausibleEmail('@nope.com'), false);
  assert.equal(isPlausibleEmail('a b@c.com'), false);
});
