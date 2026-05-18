import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCreateMessagePayload } from '../src/linkedin/intro-voyager.js';

test('buildCreateMessagePayload: produces all required top-level fields with title', () => {
  const payload = buildCreateMessagePayload({
    senderUrn: 'urn:li:fsd_profile:ACoAASender',
    recipientUrns: ['urn:li:fsd_profile:ACoAALead', 'urn:li:fsd_profile:ACoAAPrimary'],
    body: 'Hello — meet Sam.',
    title: 'Intro: lead <> Sam',
  });
  assert.equal(payload.mailboxUrn, 'urn:li:fsd_profile:ACoAASender');
  assert.deepEqual(payload.hostRecipientUrns, [
    'urn:li:fsd_profile:ACoAALead',
    'urn:li:fsd_profile:ACoAAPrimary',
  ]);
  assert.equal(payload.message.body.text, 'Hello — meet Sam.');
  assert.deepEqual(payload.message.body.attributes, []);
  assert.deepEqual(payload.message.renderContentUnions, []);
  assert.equal(payload.conversationTitle, 'Intro: lead <> Sam');
  assert.equal(payload.dedupeByClientGeneratedToken, false);
  assert.equal(typeof payload.trackingId, 'string');
  assert.equal(payload.trackingId.length, 16);
  assert.equal(typeof payload.message.originToken, 'string');
  // originToken is a UUID v4: 8-4-4-4-12 hex
  assert.match(payload.message.originToken, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
});

test('buildCreateMessagePayload: omits conversationTitle when title is empty', () => {
  const payload = buildCreateMessagePayload({
    senderUrn: 'urn:li:fsd_profile:ACoAASender',
    recipientUrns: ['urn:li:fsd_profile:ACoAALead', 'urn:li:fsd_profile:ACoAAPrimary'],
    body: 'Hi.',
    title: '',
  });
  assert.equal('conversationTitle' in payload, false);
});

test('buildCreateMessagePayload: omits conversationTitle when title is whitespace-only', () => {
  const payload = buildCreateMessagePayload({
    senderUrn: 'urn:li:fsd_profile:ACoAASender',
    recipientUrns: ['urn:li:fsd_profile:ACoAALead', 'urn:li:fsd_profile:ACoAAPrimary'],
    body: 'Hi.',
    title: '   ',
  });
  assert.equal('conversationTitle' in payload, false);
});

test('buildCreateMessagePayload: omits conversationTitle when title is undefined', () => {
  const payload = buildCreateMessagePayload({
    senderUrn: 'urn:li:fsd_profile:ACoAASender',
    recipientUrns: ['urn:li:fsd_profile:ACoAALead', 'urn:li:fsd_profile:ACoAAPrimary'],
    body: 'Hi.',
  });
  assert.equal('conversationTitle' in payload, false);
});

test('buildCreateMessagePayload: each call gets a fresh trackingId and originToken', () => {
  const a = buildCreateMessagePayload({
    senderUrn: 'urn:li:fsd_profile:ACoAASender',
    recipientUrns: ['urn:li:fsd_profile:ACoAALead', 'urn:li:fsd_profile:ACoAAPrimary'],
    body: 'Hi.', title: 'T',
  });
  const b = buildCreateMessagePayload({
    senderUrn: 'urn:li:fsd_profile:ACoAASender',
    recipientUrns: ['urn:li:fsd_profile:ACoAALead', 'urn:li:fsd_profile:ACoAAPrimary'],
    body: 'Hi.', title: 'T',
  });
  assert.notEqual(a.trackingId, b.trackingId);
  assert.notEqual(a.message.originToken, b.message.originToken);
});

test('buildCreateMessagePayload: throws on missing senderUrn', () => {
  assert.throws(
    () => buildCreateMessagePayload({
      senderUrn: '',
      recipientUrns: ['urn:li:fsd_profile:ACoAALead', 'urn:li:fsd_profile:ACoAAPrimary'],
      body: 'Hi.',
    }),
    /senderUrn required/i,
  );
});

test('buildCreateMessagePayload: throws on empty recipientUrns', () => {
  assert.throws(
    () => buildCreateMessagePayload({
      senderUrn: 'urn:li:fsd_profile:ACoAASender',
      recipientUrns: [],
      body: 'Hi.',
    }),
    /recipientUrns required/i,
  );
});

test('buildCreateMessagePayload: throws on missing body', () => {
  assert.throws(
    () => buildCreateMessagePayload({
      senderUrn: 'urn:li:fsd_profile:ACoAASender',
      recipientUrns: ['urn:li:fsd_profile:ACoAALead', 'urn:li:fsd_profile:ACoAAPrimary'],
      body: '',
    }),
    /body required/i,
  );
});
