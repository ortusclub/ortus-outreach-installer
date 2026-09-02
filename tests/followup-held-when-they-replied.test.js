import { test } from 'node:test';
import assert from 'node:assert/strict';
import { declinePhrase, findLeadReply, holdVerdict, heldSummary } from '../src/followup-dnc.js';
import { selectDue } from '../src/primary-tasks.js';

const msg = (sender, text) => ({ sender, text });

test('silence sends: no reply from the lead means no hold', () => {
  const thread = [
    msg('Antonio Varlese', 'Michael, meet James. James, meet Michael.'),
    msg('Liza Advocate', 'Great to connect you both.'),
  ];
  assert.equal(holdVerdict(thread, 'Michael Chen'), null);
});

test('ANY reply holds, warm ones included', () => {
  const warm = holdVerdict([msg('Michael Chen', 'No worries, count me in!')], 'Michael Chen');
  assert.equal(warm.reason, 'replied', 'a warm reply is held, but not called a DNC');
  assert.match(warm.quote, /count me in/);
});

test("a refusal is held AND labelled a probable DNC", () => {
  const v = holdVerdict([msg('James Auld', "Hi, sorry I can't make that event")], 'James Auld');
  assert.equal(v.reason, 'declined');
  assert.match(v.phrase, /can't make/i);
});

test('the label survives phrasings no single word would catch', () => {
  for (const t of [
    'Unfortunately I have a clash that week',
    "I won't be able to attend, but thank you",
    'Have to pass on this one',
    'Maybe another time!',
    'Please remove me off this list',
    'Not interested, thanks',
  ]) assert.ok(declinePhrase(t), `should read as a decline: "${t}"`);
});

test('a warm reply is never mislabelled a decline', () => {
  for (const t of [
    "Sorry for the slow reply, I'd love to come",
    'No worries at all, see you there',
    "Can't wait!",
    'Sounds great, count me in',
  ]) assert.equal(declinePhrase(t), null, `should NOT read as a decline: "${t}"`);
});

test('the lead is found by name, not by markup', () => {
  // LinkedIn abbreviates to a first name in group threads.
  const thread = [msg('Antonio Varlese', 'intro'), msg('Michael', 'thanks!')];
  assert.equal(findLeadReply(thread, 'Michael Chen').text, 'thanks!');
  // And our own messages are never mistaken for theirs.
  assert.equal(findLeadReply([msg('Antonio Varlese', "sorry I can't make it")], 'Michael Chen'), null);
});

test('the most recent word from the lead is the one that counts', () => {
  const v = holdVerdict([
    msg('Michael Chen', "sorry I can't make it"),
    msg('Michael Chen', 'actually my plans changed, I can come'),
  ], 'Michael Chen');
  assert.match(v.quote, /plans changed/);
  assert.equal(v.reason, 'replied', 'the later message is the current answer');
});

test('an unreadable thread sends as normal rather than stopping everything', () => {
  // readThreadMessages returns [] when the markup moves. Fail OPEN: a DOM change
  // must not silently park every follow-up in the app.
  assert.equal(holdVerdict([], 'Michael Chen'), null);
});

test('a held follow-up can never be sent by the runner on its own', () => {
  const held = { id: 'h', type: 'follow-up', status: 'held', dueAt: 1 };
  assert.equal(selectDue([held], 2).length, 0);
  // …until the operator releases it, which is exactly what /send-held does.
  assert.equal(selectDue([{ ...held, status: 'pending' }], 2).length, 1);
});

test('the card wording separates a probable no from a plain reply', () => {
  const t = (reason) => ({ type: 'follow-up', status: 'held', heldReason: reason });
  assert.equal(heldSummary([t('declined'), t('declined'), t('replied')]), '2 probable DNC · 1 replied');
  assert.equal(heldSummary([t('replied')]), '1 replied');
  assert.equal(heldSummary([]), '');
});
