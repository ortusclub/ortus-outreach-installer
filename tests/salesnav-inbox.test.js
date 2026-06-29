// Sales Navigator inbox reader (OP / InMail reply-check). Proves the normalizer
// emits the internal conversation shape and that the existing classifier matches
// OP/InMail replies to sheet leads by numeric memberId. Schema mirrors the live
// capture — docs/salesnav-inbox-SCHEMA.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSalesNavThreads } from '../src/linkedin/helpers.js';
import { classifyConversations, hasSalesNavChannel, sweepProfileInbox, _setDeps } from '../src/linkedin/inbox-sweep.js';

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

test('hasSalesNavChannel: detects OP/InMail leads by sheet markers', () => {
  assert.equal(hasSalesNavChannel([{ Stage: 'OP Sent', 'OP Status': 'OP Sent' }]), true);
  assert.equal(hasSalesNavChannel([{ Stage: 'InMail Sent' }]), true);
  assert.equal(hasSalesNavChannel([{ 'Last Action': 'Open Profile message' }]), true);
  assert.equal(hasSalesNavChannel([{ Stage: 'Connected', 'Last Action': 'DM Sent' }]), false);
  assert.equal(hasSalesNavChannel([]), false);
});

test('sweepProfileInbox: combines regular DM + Sales Nav replies in one pass', async () => {
  // Build one regular-inbox DM reply (internal shape) + one Sales Nav OP reply.
  const dmConv = {
    threadId: 'dm-1', lastActivityAt: 5000, groupChat: false,
    participants: [{ firstName: 'Luca', lastName: 'Coppone', memberId: '269709976' }],
    lastMessage: { text: 'Ciao!', deliveredAt: 5000, isInbound: true, actor: { firstName: 'Luca', lastName: 'Coppone', memberId: '269709976' } },
  };
  const snRaw = {
    data: { elements: [{ id: 'sn-1', unreadMessageCount: 1, participants: [sUrn(ME), sUrn(LEAD)],
      messages: [msg(sUrn(ME), 'Invite…', 1000, 'INMAIL'), msg(sUrn(LEAD), 'Sì, volentieri', 2000, 'MESSAGE')] }] },
    included: [profile(ME, '66974850', 'Christian Dwayne', 'Co'), profile(LEAD, '11415868', 'Sophie', 'Marchessou')],
  };
  _setDeps({
    async getConversationsPage() { return { elements: [dmConv] }; },
    async getSalesNavThreadsPage() { return normalizeSalesNavThreads(snRaw); },
  });
  try {
    const rows = [
      { 'First Name': 'Luca', 'Last Name': 'Coppone', 'Linkedin Membership ID': '269709976', Stage: 'Connected' },
      { 'First Name': 'Sophie', 'Last Name': 'Marchessou', 'Linkedin Membership ID': '11415868', Stage: 'OP Sent' },
    ];
    // page with no goto/waitForFunction → loaders skip navigation, hit the stubs.
    const out = await sweepProfileInbox({ page: {}, sheetUrl: 'x', linkedinColumn: 'Linkedin Bio', candidateRows: rows });
    assert.equal(out.error, '');
    const names = out.campaignReplies.map((r) => r.leadName).sort();
    assert.deepEqual(names, ['Luca Coppone', 'Sophie Marchessou']);
  } finally {
    _setDeps(null);
  }
});
