import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseCreateMessageResponse } from '../src/linkedin/intro-voyager.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const successFixture = JSON.parse(readFileSync(
  join(__dirname, 'fixtures/voyager-create-message-success-200.json'),
  'utf8'
));

test('parseCreateMessageResponse: extracts conversationUrn from 200 response', () => {
  const result = parseCreateMessageResponse({ status: 200, body: successFixture });
  assert.equal(result.ok, true);
  assert.equal(
    result.conversationUrn,
    'urn:li:msg_conversation:(urn:li:fsd_profile:ACoAABkKUycBZd5cdhq31vO7Rm9K5fCc2Nu6UgA,2-OTkyY2RjYjQtOTcwYS00MmZjLWI5ZDYtM2FlZDM4M2U3ZDNkXzEwMA==)'
  );
  assert.equal(
    result.backendConversationUrn,
    'urn:li:messagingThread:2-OTkyY2RjYjQtOTcwYS00MmZjLWI5ZDYtM2FlZDM4M2U3ZDNkXzEwMA=='
  );
  assert.equal(result.deliveredAt, 1779090581245);
});

test('parseCreateMessageResponse: 4xx returns ok=false with status + errorBody', () => {
  const result = parseCreateMessageResponse({
    status: 403,
    body: { errorDetails: { code: 'FORBIDDEN' }, message: 'not 1st-degree' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.equal(result.errorBody.message, 'not 1st-degree');
});

test('parseCreateMessageResponse: 200 with empty body returns ok=false', () => {
  const result = parseCreateMessageResponse({ status: 200, body: {} });
  assert.equal(result.ok, false);
  assert.match(result.reason, /missing conversationUrn/i);
});

test('parseCreateMessageResponse: 5xx returns ok=false', () => {
  const result = parseCreateMessageResponse({ status: 503, body: 'gateway' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
});
