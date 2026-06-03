import test from 'node:test';
import assert from 'node:assert/strict';

import { replyKey, dedupeReplies } from '../src/replies-log.js';
import { leadsForProfile, repliesToLogEntries } from '../src/post-campaign-reply-check.js';

test('repliesToLogEntries keeps inbound replies and flags ambiguous as suspected', () => {
  const result = {
    replies: [
      { inbound: true,  leadUrl: 'https://linkedin.com/in/a', name: 'Ada Lovelace', snippet: 'Sounds great', timestamp: 111, match: { 'First Name': 'Ada', 'Last Name': 'Lovelace' } },
      { inbound: false, leadUrl: 'https://linkedin.com/in/b', name: 'You',          snippet: 'our outbound', timestamp: 99 },
    ],
    ambiguous: [
      { inbound: true,  name: 'John Smith', snippet: 'who is this', timestamp: 222, candidates: [{}, {}] },
      { inbound: false, name: 'John Smith', snippet: 'outbound',    timestamp: 50 },
    ],
  };
  const entries = repliesToLogEntries(result, 'p1', 'Sam');
  assert.equal(entries.length, 2); // 1 inbound reply + 1 suspected (outbound dropped)
  const real = entries.find(e => !e.suspected);
  assert.equal(real.leadName, 'Ada Lovelace');
  assert.equal(real.linkedinUrl, 'https://linkedin.com/in/a');
  const susp = entries.find(e => e.suspected);
  assert.equal(susp.leadName, 'John Smith');
  assert.equal(susp.linkedinUrl, ''); // can't attribute a URL when ambiguous
});

test('repliesToLogEntries handles empty/missing result safely', () => {
  assert.deepEqual(repliesToLogEntries({}, 'p1', 'Sam'), []);
  assert.deepEqual(repliesToLogEntries({ replies: [], ambiguous: [] }, 'p1', 'Sam'), []);
});
import { prettyParkReason } from '../src/campaign.js';

test('prettyParkReason maps known park codes to readable labels', () => {
  assert.equal(prettyParkReason('session_expired'), 'logged out / session expired');
  assert.equal(prettyParkReason('weekly_limit_429'), 'weekly invite limit reached');
  assert.equal(prettyParkReason('consecutive_skips'), 'too many consecutive skips / failures');
  assert.equal(prettyParkReason('something_else'), 'something_else'); // unknown passthrough
  assert.equal(prettyParkReason(''), 'parked');
});

test('replyKey is stable and content-derived', () => {
  const a = { profileId: 'p1', linkedinUrl: 'https://linkedin.com/in/Foo', text: 'Hi there, thanks!' };
  const b = { profileId: 'p1', linkedinUrl: 'https://linkedin.com/in/foo', text: 'Hi there, thanks!' };
  // URL casing is normalized, so these collide (same person/message).
  assert.equal(replyKey(a), replyKey(b));
  const c = { profileId: 'p2', linkedinUrl: 'https://linkedin.com/in/foo', text: 'Hi there, thanks!' };
  assert.notEqual(replyKey(a), replyKey(c)); // different account
});

test('dedupeReplies returns only genuinely new replies', () => {
  const existing = [
    { profileId: 'p1', linkedinUrl: 'https://linkedin.com/in/a', text: 'already seen' },
  ];
  const incoming = [
    { profileId: 'p1', linkedinUrl: 'https://linkedin.com/in/a', text: 'already seen' }, // dup
    { profileId: 'p1', linkedinUrl: 'https://linkedin.com/in/b', text: 'new one' },       // new
  ];
  const fresh = dedupeReplies(existing, incoming);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].linkedinUrl, 'https://linkedin.com/in/b');
});

test('dedupeReplies de-dups within the same batch', () => {
  const incoming = [
    { profileId: 'p1', linkedinUrl: 'https://linkedin.com/in/a', text: 'same' },
    { profileId: 'p1', linkedinUrl: 'https://linkedin.com/in/a', text: 'same' },
  ];
  assert.equal(dedupeReplies([], incoming).length, 1);
});

test('leadsForProfile keeps Sent-stage rows for the matching sender only', () => {
  const rows = [
    { Stage: 'OP Sent',  Sender: 'Sam Adcock',  'Linkedin URL': 'https://linkedin.com/in/a' },
    { Stage: 'OP Sent',  Sender: 'Other Person', 'Linkedin URL': 'https://linkedin.com/in/b' },
    { Stage: 'Queued',   Sender: 'Sam Adcock',  'Linkedin URL': 'https://linkedin.com/in/c' },
    { Stage: 'Replied',  Sender: 'Sam Adcock',  'Linkedin URL': 'https://linkedin.com/in/d' },
  ];
  const leads = leadsForProfile(rows, 'Sam Adcock');
  const urls = leads.map(l => l['Linkedin URL']);
  assert.deepEqual(urls, ['https://linkedin.com/in/a', 'https://linkedin.com/in/d']);
});

test('leadsForProfile matches on legacy Account Used column + is case-insensitive', () => {
  const rows = [
    { Stage: 'DM Sent', 'Account Used': 'sam adcock', url: 'https://linkedin.com/in/a' },
  ];
  assert.equal(leadsForProfile(rows, 'Sam Adcock').length, 1);
});

test('leadsForProfile falls back to Message=sent when there is no Stage column', () => {
  const rows = [
    { Message: 'sent', Sender: 'Sam', url: 'x' },
    { Message: '',     Sender: 'Sam', url: 'y' },
  ];
  assert.equal(leadsForProfile(rows, 'Sam').length, 1);
});

test('leadsForProfile returns [] for unknown sender or empty rows', () => {
  assert.deepEqual(leadsForProfile([], 'Sam'), []);
  assert.deepEqual(leadsForProfile([{ Stage: 'OP Sent', Sender: 'X' }], ''), []);
});
