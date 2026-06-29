// Sales Navigator inbox reader (OP / InMail reply-check). Proves the normalizer
// emits the internal conversation shape and that the existing classifier matches
// OP/InMail replies to sheet leads by numeric memberId. Schema mirrors the live
// capture — docs/salesnav-inbox-SCHEMA.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSalesNavThreads } from '../src/linkedin/helpers.js';
import { classifyConversations } from '../src/linkedin/inbox-sweep.js';

// Helpers to build a salesProfile URN + included Profile entity.
const sUrn = (acwaa) => `urn:li:fs_salesProfile:(${acwaa},NAME_SEARCH,XxXx)`;
const profile = (acwaa, memberId, firstName, lastName) => ({
  $type: 'com.linkedin.sales.profile.Profile',
  entityUrn: sUrn(acwaa),
  objectUrn: `urn:li:member:${memberId}`,
  firstName, lastName, fullName: `${firstName} ${lastName}`, degree: 2,
});
const msg = (author, body, deliveredAt, type = 'MESSAGE') => ({
  $type: 'com.linkedin.sales.messaging.message.Message',
  author, body, deliveredAt, type, attachments: [],
});

// ME = the account owner (dwayne.co); LEAD = Sophie (in the sheet, memberId 11415868).
const ME = 'ACwAADpvnRYBOgPC7lAlsCHBUZ';
const LEAD = 'ACwAAACuMTwB8AguvuSJNPf0W2gG1J2oMd3lprc';

function rawWith(threads, profiles) {
  return { data: { elements: threads }, included: profiles };
}

test('salesnav: lead reply → matched campaign reply by memberId', () => {
  const raw = rawWith(
    [{
      $type: 'com.linkedin.sales.messaging.message.Thread',
      id: '2-THREAD-A', unreadMessageCount: 1,
      participants: [sUrn(ME), sUrn(LEAD)],
      messages: [
        msg(sUrn(ME), 'Hi Sophie, invitation to our dinner…', 1000, 'INMAIL'),
        msg(sUrn(LEAD), 'Grazie, ci sarò volentieri!', 2000, 'MESSAGE'),
      ],
    }],
    [profile(ME, '66974850', 'Christian Dwayne', 'Co'), profile(LEAD, '11415868', 'Sophie', 'Marchessou')],
  );
  const { elements } = normalizeSalesNavThreads(raw);
  assert.equal(elements.length, 1);
  const conv = elements[0];
  // Me excluded → participants[0] is the lead.
  assert.equal(conv.participants.length, 1);
  assert.equal(conv.participants[0].memberId, '11415868');
  assert.equal(conv.lastMessage.text, 'Grazie, ci sarò volentieri!');
  assert.equal(conv.lastMessage.isInbound, true);

  const rows = [{ 'First Name': 'Sophie', 'Last Name': 'Marchessou', 'Linkedin Membership ID': '11415868', 'Linkedin Bio': `https://www.linkedin.com/in/${LEAD}` }];
  const { campaignReplies, unmatched } = classifyConversations(elements, rows, 'Linkedin Bio');
  assert.equal(campaignReplies.length, 1);
  assert.equal(unmatched.length, 0);
  assert.equal(campaignReplies[0].leadName, 'Sophie Marchessou');
  assert.equal(campaignReplies[0].fullText, 'Grazie, ci sarò volentieri!');
});

test('salesnav: only our InMail sent (no reply) → NOT a campaign reply', () => {
  const raw = rawWith(
    [{
      id: '2-THREAD-B', unreadMessageCount: 0,
      participants: [sUrn(ME), sUrn(LEAD)],
      messages: [msg(sUrn(ME), 'Hi Sophie, invitation…', 1000, 'INMAIL')],
    }],
    [profile(ME, '66974850', 'Christian Dwayne', 'Co'), profile(LEAD, '11415868', 'Sophie', 'Marchessou')],
  );
  const { elements } = normalizeSalesNavThreads(raw);
  assert.equal(elements[0].lastMessage.isInbound, false);
  const rows = [{ 'First Name': 'Sophie', 'Last Name': 'Marchessou', 'Linkedin Membership ID': '11415868' }];
  const { campaignReplies } = classifyConversations(elements, rows, 'Linkedin Bio');
  assert.equal(campaignReplies.length, 0);
});

test('salesnav: reply from someone NOT in the sheet → unmatched bucket', () => {
  const STRANGER = 'ACwAAStranger0000';
  const raw = rawWith(
    [{
      id: '2-THREAD-C', unreadMessageCount: 1,
      participants: [sUrn(ME), sUrn(STRANGER)],
      messages: [
        msg(sUrn(ME), 'Hi there…', 1000, 'INMAIL'),
        msg(sUrn(STRANGER), 'Please remove me.', 2000, 'MESSAGE'),
      ],
    }],
    [profile(ME, '66974850', 'Christian Dwayne', 'Co'), profile(STRANGER, '99999999', 'Random', 'Person')],
  );
  const { elements } = normalizeSalesNavThreads(raw);
  const rows = [{ 'First Name': 'Sophie', 'Last Name': 'Marchessou', 'Linkedin Membership ID': '11415868' }];
  const { campaignReplies, unmatched } = classifyConversations(elements, rows, 'Linkedin Bio');
  assert.equal(campaignReplies.length, 0);
  assert.equal(unmatched.length, 1);
});

test('salesnav: empty / malformed payload → no throw, empty elements', () => {
  assert.deepEqual(normalizeSalesNavThreads(null), { elements: [], metadata: null });
  assert.deepEqual(normalizeSalesNavThreads({}), { elements: [], metadata: null });
  assert.equal(normalizeSalesNavThreads({ data: { elements: [] }, included: [] }).elements.length, 0);
});
