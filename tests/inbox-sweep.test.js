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

import { classifyConversations } from '../src/linkedin/inbox-sweep.js';

test('classify: splits matched vs unmatched, skips outbound', () => {
  const convs = [
    // inbound, matches a row by token → campaign reply
    { threadId: 't1', lastActivityAt: 10,
      participants: [{ firstName: 'Jane', lastName: 'Doe', profileUrl: 'https://www.linkedin.com/in/jane-doe' }],
      lastMessage: { text: 'thanks for connecting!', deliveredAt: 9, actor: { firstName: 'Jane', lastName: 'Doe', profileUrl: 'https://www.linkedin.com/in/jane-doe' } } },
    // inbound, no matching row → unmatched new reply
    { threadId: 't2', lastActivityAt: 20,
      participants: [{ firstName: 'Stranger', lastName: 'Person', profileUrl: 'https://www.linkedin.com/in/stranger' }],
      lastMessage: { text: 'hi there', deliveredAt: 19, actor: { firstName: 'Stranger', lastName: 'Person', profileUrl: 'https://www.linkedin.com/in/stranger' } } },
    // outbound (we sent last) → ignored entirely
    { threadId: 't3', lastActivityAt: 30,
      participants: [{ firstName: 'Jane', lastName: 'Doe', profileUrl: 'https://www.linkedin.com/in/jane-doe' }],
      lastMessage: { text: 'following up', deliveredAt: 29, actor: { firstName: 'Matt', lastName: 'Adcock', profileUrl: 'https://www.linkedin.com/in/matt' } } },
  ];
  const rows = [{ 'First Name': 'Jane', 'Last Name': 'Doe', 'Linkedin URL': 'https://www.linkedin.com/in/jane-doe' }];
  const { campaignReplies, unmatched } = classifyConversations(convs, rows);
  assert.equal(campaignReplies.length, 1);
  assert.equal(campaignReplies[0].leadName, 'Jane Doe');
  assert.equal(campaignReplies[0].threadId, 't1');
  assert.equal(campaignReplies[0].linkedinUrl, 'https://www.linkedin.com/in/jane-doe');
  assert.equal(unmatched.length, 1);
  assert.equal(unmatched[0].leadName, 'Stranger Person');
  assert.equal(unmatched[0].suspected, false);
});

test('classify: ambiguous same-name → unmatched with suspected:true', () => {
  const convs = [{ threadId: 'a', lastActivityAt: 5,
    participants: [{ firstName: 'Jane', lastName: 'Doe', profileUrl: '' }],
    lastMessage: { text: 'hey', deliveredAt: 4, actor: { firstName: 'Jane', lastName: 'Doe' } } }];
  const rows = [
    { 'First Name': 'Jane', 'Last Name': 'Doe', 'Linkedin URL': '' },
    { 'First Name': 'Jane', 'Last Name': 'Doe', 'Linkedin URL': '' },
  ];
  const { campaignReplies, unmatched } = classifyConversations(convs, rows);
  assert.equal(campaignReplies.length, 0);
  assert.equal(unmatched.length, 1);
  assert.equal(unmatched[0].suspected, true);
});

import { makeInitialSweepStatus, applyReplyWriteBack, _setDeps } from '../src/linkedin/inbox-sweep.js';

test('makeInitialSweepStatus: shape + dryRun flag', () => {
  const s = makeInitialSweepStatus(['a@x.com', 'b@x.com'], true);
  assert.equal(s.running, true);
  assert.equal(s.dryRun, true);
  assert.equal(s.totalProfiles, 2);
  assert.equal(s.perProfile.length, 2);
  assert.equal(s.perProfile[0].status, 'waiting');
});

test('applyReplyWriteBack: writes matched replies via deps, honors non-destructive guard', async () => {
  const calls = { update: [], append: [] };
  _setDeps({
    async getSheetRowStatus() { return { Reply: '' }; },          // empty → should write
    async updateSheetRow(sheetUrl, url, tracking) { calls.update.push({ url, tracking }); },
    async appendReplyRow(sheetUrl, reply) { calls.append.push(reply); },
  });
  const campaignReplies = [
    { leadName: 'Jane Doe', snippet: 'thanks', linkedinUrl: 'https://www.linkedin.com/in/jane-doe', timestamp: 1000, row: { 'First Name': 'Jane', 'Last Name': 'Doe' } },
  ];
  const out = await applyReplyWriteBack({ sheetUrl: 'S', linkedinColumn: 'Linkedin URL', campaignReplies, deps: undefined });
  assert.equal(out.wrote, 1);
  assert.equal(calls.update.length, 1);
  assert.equal(calls.update[0].tracking.Reply, 'yes');
  assert.equal(calls.update[0].tracking.stage, 'Replied');
  assert.equal(calls.append.length, 1);
  _setDeps(null);
});

test('applyReplyWriteBack: skips rows already marked Reply=yes', async () => {
  const calls = { update: [] };
  _setDeps({
    async getSheetRowStatus() { return { Reply: 'yes' }; },        // already replied → skip
    async updateSheetRow(s, u, t) { calls.update.push(t); },
    async appendReplyRow() {},
  });
  const out = await applyReplyWriteBack({ sheetUrl: 'S', linkedinColumn: 'Linkedin URL',
    campaignReplies: [{ leadName: 'Jane', snippet: 'hi', linkedinUrl: 'https://www.linkedin.com/in/jane-doe', timestamp: 1, row: {} }], deps: undefined });
  assert.equal(out.wrote, 0);
  assert.equal(out.skipped, 1);
  assert.equal(calls.update.length, 0);
  _setDeps(null);
});

test('applyReplyWriteBack: missing linkedinUrl → counted as error, no throw', async () => {
  _setDeps({ async getSheetRowStatus() { return { Reply: '' }; }, async updateSheetRow() {}, async appendReplyRow() {} });
  const out = await applyReplyWriteBack({ sheetUrl: 'S', linkedinColumn: 'Linkedin URL',
    campaignReplies: [{ leadName: 'NoUrl', snippet: 'x', linkedinUrl: '', timestamp: 1, row: {} }], deps: undefined });
  assert.equal(out.wrote, 0);
  assert.equal(out.errors.length, 1);
  _setDeps(null);
});

import { sweepProfileInbox } from '../src/linkedin/inbox-sweep.js';

function fakePage() {
  // Minimal puppeteer-page stand-in: goto/evaluate/waitForFunction are no-ops.
  return {
    async goto() {}, async evaluate() {}, async waitForFunction() {},
  };
}

test('sweepProfileInbox: classifies fetched conversations, preview-only', async () => {
  _setDeps({
    async getConversationsPage() {
      return { elements: [
        { threadId: 't1', lastActivityAt: 100,
          participants: [{ firstName: 'Jane', lastName: 'Doe', profileUrl: 'https://www.linkedin.com/in/jane-doe' }],
          lastMessage: { text: 'thanks!', deliveredAt: 99, actor: { firstName: 'Jane', lastName: 'Doe', profileUrl: 'https://www.linkedin.com/in/jane-doe' } } },
      ], metadata: null };
    },
  });
  const rows = [{ 'First Name': 'Jane', 'Last Name': 'Doe', 'Linkedin URL': 'https://www.linkedin.com/in/jane-doe' }];
  const out = await sweepProfileInbox({ page: fakePage(), sheetUrl: 'S', linkedinColumn: 'Linkedin URL', candidateRows: rows, watermark: 0, log: () => {} });
  assert.equal(out.error, '');
  assert.equal(out.campaignReplies.length, 1);
  assert.equal(out.unmatched.length, 0);
  assert.equal(out.conversationsScanned, 1);
  _setDeps(null);
});

test('sweepProfileInbox: getConversationsPage null → clean error, no throw', async () => {
  _setDeps({ async getConversationsPage() { return null; } });
  const out = await sweepProfileInbox({ page: fakePage(), sheetUrl: 'S', linkedinColumn: 'Linkedin URL', candidateRows: [], watermark: 0, log: () => {} });
  assert.match(out.error, /inbox/i);
  assert.equal(out.campaignReplies.length, 0);
  _setDeps(null);
});

// ── Group-thread (CC+IC 3-way) attribution — the real Luca Coppone case ──────
// Sweeping Pavan's inbox: parser excludes "me" (Pavan), leaving [Antonio(primary), Luca(lead)].
// participants[0] is the PRIMARY, not the lead — so the matcher must scan all participants.
const groupConv = (lastActorMid) => ({
  groupChat: true, threadId: 'g1', lastActivityAt: 100,
  participants: [
    { firstName: 'Antonio', lastName: 'Varlese', memberId: '420107047', fsdProfile: 'ACoAABkKUycB' }, // primary (participants[0])
    { firstName: 'Luca', lastName: 'Coppone', memberId: '269709976', fsdProfile: 'ACoAABATcpgB' },      // lead
  ],
  lastMessage: { text: 'Buongiorno, scusate il ritardo…', deliveredAt: 99,
    actor: { firstName: lastActorMid === '269709976' ? 'Luca' : 'Antonio', lastName: lastActorMid === '269709976' ? 'Coppone' : 'Varlese', memberId: lastActorMid } },
});
const leadRows = [{ 'First Name': 'Luca', 'Last Name': 'Coppone', 'Linkedin Membership ID': '269709976' }];

test('group: matcher finds the LEAD even when it is not participants[0]', () => {
  const m = matchConversationIdentitySafe(groupConv('269709976'), leadRows);
  assert.equal(m.reason, 'identity');
  assert.equal(m.row['First Name'], 'Luca');
  assert.equal(m.lead.memberId, '269709976'); // attributed to Luca, not Antonio
});

test('group: lead replied → campaign reply attributed to the lead, not the primary', () => {
  const { campaignReplies, unmatched } = classifyConversations([groupConv('269709976')], leadRows);
  assert.equal(campaignReplies.length, 1);
  assert.equal(campaignReplies[0].leadName, 'Luca Coppone');
  assert.equal(unmatched.length, 0);
  assert.equal(campaignReplies[0].isGroup, true);
});

test('group: primary spoke last → NOT counted as a lead reply', () => {
  const { campaignReplies } = classifyConversations([groupConv('420107047')], leadRows);
  assert.equal(campaignReplies.length, 0); // Antonio (primary) sent last — not Luca
});
