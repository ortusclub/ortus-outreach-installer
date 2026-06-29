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

import { isInboundConversation, matchConversationIdentitySafe } from '../src/linkedin/inbox-sweep.js';

const inboundConv = (over = {}) => ({
  participants: [{ firstName: 'Jane', lastName: 'Doe', profileUrl: 'https://www.linkedin.com/in/jane-doe' }],
  lastMessage: { text: 'thanks!', deliveredAt: 1000, actor: { firstName: 'Jane', lastName: 'Doe', profileUrl: 'https://www.linkedin.com/in/jane-doe' } },
  ...over,
});

test('isInboundConversation: lead sent last message (profileUrl match)', () => {
  assert.equal(isInboundConversation(inboundConv()), true);
});

test('isInboundConversation: we sent last message (actor differs) → false', () => {
  const conv = inboundConv({ lastMessage: { text: 'hi', actor: { firstName: 'Matt', lastName: 'Adcock', profileUrl: 'https://www.linkedin.com/in/matt' } } });
  assert.equal(isInboundConversation(conv), false);
});

test('isInboundConversation: no lastMessage → false', () => {
  assert.equal(isInboundConversation({ participants: [{ firstName: 'Jane', lastName: 'Doe' }] }), false);
});

test('matcher: numeric memberId is the primary anchor across the ACwAA/ACoAA gap', () => {
  // Real-world shape: sheet stores ACwAA + numeric memberId; inbox gives ACoAA + same memberId.
  const conv = { participants: [{ firstName: 'Luca', lastName: 'Coppone', memberId: '269709976', fsdProfile: 'ACoAABATcpgBDDx_VOd0lhUz_ZFcIhV21cuJuw8', profileUrl: 'https://www.linkedin.com/in/ACoAABATcpgBDDx_VOd0lhUz_ZFcIhV21cuJuw8' }],
    lastMessage: { text: 'grazie', deliveredAt: 1, isInbound: true } };
  const rows = [
    { 'First Name': 'Other', 'Last Name': 'Person', 'Linkedin Member': '111111111', 'Linkedin URL': 'https://www.linkedin.com/in/ACwAAsomeoneelse' },
    { 'First Name': 'Luca', 'Last Name': 'Coppone', 'Linkedin Member': '269709976', 'Linkedin URL': 'http://www.linkedin.com/in/ACwAABATcpgBWoI4yCYrBfmpcpJA0zLKtvoJUic' },
  ];
  const res = matchConversationIdentitySafe(conv, rows, 'Linkedin URL');
  assert.equal(res.reason, 'identity');
  assert.equal(res.row['First Name'], 'Luca');
});

test('matcher: two rows share the memberId → ambiguous, no row', () => {
  const conv = { participants: [{ firstName: 'Luca', lastName: 'Coppone', memberId: '269709976' }], lastMessage: { text: 'x', isInbound: true } };
  const rows = [
    { 'First Name': 'Luca', 'Last Name': 'Coppone', 'Linkedin Member': '269709976' },
    { 'First Name': 'Luca', 'Last Name': 'Coppone', 'Linkedin Member': '269709976' },
  ];
  assert.equal(matchConversationIdentitySafe(conv, rows).reason, 'ambiguous');
});

test('matcher: identity-token match wins (slug, when no memberId present)', () => {
  const rows = [
    { 'First Name': 'Other', 'Last Name': 'Person', 'Linkedin URL': 'https://www.linkedin.com/in/someone-else' },
    { 'First Name': 'Jane', 'Last Name': 'Doe', 'Linkedin URL': 'https://www.linkedin.com/in/jane-doe' },
  ];
  const res = matchConversationIdentitySafe(inboundConv(), rows);
  assert.equal(res.reason, 'identity');
  assert.equal(res.row['First Name'], 'Jane');
});

test('matcher: two rows share the token → ambiguous, no row', () => {
  const rows = [
    { 'First Name': 'Jane', 'Last Name': 'Doe', 'Linkedin URL': 'https://www.linkedin.com/in/jane-doe' },
    { 'First Name': 'Jane', 'Last Name': 'Doe', 'Linkedin URL': 'https://www.linkedin.com/in/jane-doe' },
  ];
  const res = matchConversationIdentitySafe(inboundConv(), rows);
  assert.equal(res.reason, 'ambiguous');
  assert.equal(res.row, null);
});

test('matcher: name fallback when no token on either side', () => {
  // Conversation participant has no profileUrl → no token; match by name.
  const conv = { participants: [{ firstName: 'Jane', lastName: 'Doe', profileUrl: '' }], lastMessage: { text: 'hi', actor: { firstName: 'Jane', lastName: 'Doe' } } };
  const rows = [{ 'First Name': 'Jane', 'Last Name': 'Doe', 'Linkedin URL': '' }];
  const res = matchConversationIdentitySafe(conv, rows);
  assert.equal(res.reason, 'name');
  assert.equal(res.row['First Name'], 'Jane');
});

test('matcher: two same-name rows with no token → ambiguous (skip-on-doubt)', () => {
  const conv = { participants: [{ firstName: 'Jane', lastName: 'Doe', profileUrl: '' }], lastMessage: { text: 'hi', actor: { firstName: 'Jane', lastName: 'Doe' } } };
  const rows = [
    { 'First Name': 'Jane', 'Last Name': 'Doe', 'Linkedin URL': '' },
    { 'First Name': 'Jane', 'Last Name': 'Doe', 'Linkedin URL': '' },
  ];
  assert.equal(matchConversationIdentitySafe(conv, rows).reason, 'ambiguous');
});

test('matcher: nothing matches → unmatched', () => {
  const rows = [{ 'First Name': 'Nobody', 'Last Name': 'Here', 'Linkedin URL': 'https://www.linkedin.com/in/nobody' }];
  assert.equal(matchConversationIdentitySafe(inboundConv(), rows).reason, 'unmatched');
});
