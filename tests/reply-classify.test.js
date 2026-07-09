import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyReply, isValidLabel, CATEGORY_LABELS, REPLY_CATEGORIES } from '../src/reply-classify.js';

test('interested — enthusiastic sketch phrasing (Sofia)', () => {
  const r = classifyReply('Thanks for the intro Sam — a fintech roundtable in Singapore sounds great. Could you send over the date and the guest list so I can check my calendar?');
  assert.equal(r.category, 'interested');
  assert.equal(r.confidence, 'high');
  assert.equal(r.label, 'Interested');
});

test('interested — short yes (Rachel)', () => {
  const r = classifyReply('Yes — happy to join. Who else is confirmed so far?');
  assert.equal(r.category, 'interested');
  assert.equal(r.confidence, 'high');
});

test('interested — count me in', () => {
  assert.equal(classifyReply("Count me in! Looks like a great group.").category, 'interested');
});

test('interested — soft hint is low confidence', () => {
  const r = classifyReply('Potentially open to learning more about this.');
  assert.equal(r.category, 'interested');
  assert.equal(r.confidence, 'low');
});

test('not-interested — explicit decline', () => {
  const r = classifyReply("Thanks but I'm not interested in events like this.");
  assert.equal(r.category, 'not-interested');
  assert.equal(r.confidence, 'high');
});

test('not-interested — explicit decline beats the word "interested"', () => {
  assert.equal(classifyReply('Not interested, please remove me from your list.').category, 'not-interested');
});

test('not-interested — unsubscribe / stop contacting', () => {
  assert.equal(classifyReply('Please stop messaging me.').category, 'not-interested');
  assert.equal(classifyReply('Unsubscribe.').category, 'not-interested');
});

test('not-interested — soft decline is low confidence (Daniel, sketch)', () => {
  const r = classifyReply("Appreciate the connect. We're mid-audit until end of July so I'll have to pass on anything before then — happy to revisit in August.");
  assert.equal(r.category, 'not-interested');
  assert.equal(r.confidence, 'low');
});

test('not-interested — "not right now" soft decline', () => {
  const r = classifyReply('Not right now I am afraid, maybe later in the year.');
  assert.equal(r.category, 'not-interested');
  assert.equal(r.confidence, 'low');
});

test('out-of-office — classic auto-reply (Priya, sketch)', () => {
  const r = classifyReply('I am out of the office until 14 July with limited access to email and LinkedIn. For urgent matters please contact my EA.');
  assert.equal(r.category, 'out-of-office');
  assert.equal(r.confidence, 'high');
});

test('out-of-office — on leave', () => {
  assert.equal(classifyReply('I am on parental leave until September.').category, 'out-of-office');
});

test('out-of-office — beats question mark inside auto-reply', () => {
  const r = classifyReply('Auto-reply: away on vacation. Did you need something urgent? Contact my assistant.');
  assert.equal(r.category, 'out-of-office');
});

test('question — format question (Marcus, sketch)', () => {
  const r = classifyReply("What's the format — is this a sales pitch dinner or an actual discussion?");
  assert.equal(r.category, 'question');
  assert.equal(r.confidence, 'high');
});

test('question — generic text ending in ? is low confidence', () => {
  const r = classifyReply('Do you also run these in Berlin?');
  assert.equal(r.category, 'question');
  assert.equal(r.confidence, 'low');
});

test('other — pleasantry with no signal', () => {
  const r = classifyReply('Thanks for connecting.');
  assert.equal(r.category, 'other');
  assert.equal(r.confidence, 'low');
  assert.equal(r.label, 'Other');
});

test('other — empty / missing text', () => {
  assert.equal(classifyReply('').category, 'other');
  assert.equal(classifyReply(null).category, 'other');
  assert.equal(classifyReply(undefined).category, 'other');
});

test('every category has a display label and validates', () => {
  for (const c of REPLY_CATEGORIES) {
    assert.ok(CATEGORY_LABELS[c], `label for ${c}`);
    assert.ok(isValidLabel(CATEGORY_LABELS[c]));
  }
  assert.equal(isValidLabel('Spam'), false);
  assert.equal(isValidLabel(''), false);
});
