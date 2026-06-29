import { test } from 'node:test';
import assert from 'node:assert/strict';
import { identityToken, conversationToken, rowLinkedinUrl } from '../src/linkedin/inbox-sweep.js';

test('identityToken: vanity /in/ slug is lowercased', () => {
  assert.equal(identityToken('https://www.linkedin.com/in/Jane-Doe-123/'), 'jane-doe-123');
});

test('identityToken: member URN is preserved case-sensitively', () => {
  assert.equal(identityToken('https://www.linkedin.com/in/ACwAAB_xYz12'), 'ACwAAB_xYz12');
});

test('identityToken: sales lead URN', () => {
  assert.equal(identityToken('https://www.linkedin.com/sales/lead/ACwAAB_xYz12,NAME_SEARCH'), 'ACwAAB_xYz12');
});

test('identityToken: unrecognized → null', () => {
  assert.equal(identityToken('https://example.com/jane'), null);
  assert.equal(identityToken(''), null);
  assert.equal(identityToken(null), null);
});

test('conversationToken: from participant profileUrl', () => {
  const conv = { participants: [{ firstName: 'Jane', lastName: 'Doe', profileUrl: 'https://www.linkedin.com/in/jane-doe-123' }] };
  assert.equal(conversationToken(conv), 'jane-doe-123');
});

test('conversationToken: no participant → null', () => {
  assert.equal(conversationToken({ participants: [] }), null);
  assert.equal(conversationToken({}), null);
});

test('rowLinkedinUrl: configured column wins, then fallback scan', () => {
  assert.equal(rowLinkedinUrl({ 'Linkedin URL': 'https://www.linkedin.com/in/a' }), 'https://www.linkedin.com/in/a');
  assert.equal(rowLinkedinUrl({ Profile: 'https://www.linkedin.com/in/b' }, 'Profile'), 'https://www.linkedin.com/in/b');
  assert.equal(rowLinkedinUrl({ Misc: 'see www.linkedin.com/in/c here' }), 'see www.linkedin.com/in/c here');
  assert.equal(rowLinkedinUrl({ Name: 'Jane' }), '');
});
