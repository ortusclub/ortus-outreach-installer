import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isUsableThreadUrl } from '../src/linkedin/thread-message.js';

test('isUsableThreadUrl accepts a real messaging thread URL', () => {
  assert.equal(isUsableThreadUrl('https://www.linkedin.com/messaging/thread/2-abc==/'), true);
});

test('isUsableThreadUrl rejects compose / feed / empty URLs', () => {
  assert.equal(isUsableThreadUrl('https://www.linkedin.com/messaging/compose/'), false);
  assert.equal(isUsableThreadUrl('https://www.linkedin.com/messaging/thread/new/?isTYAHFlow=true'), false);
  assert.equal(isUsableThreadUrl('https://www.linkedin.com/messaging/thread/new/?isTYAHFlow=true&recipient=ayush-goswami-65636a402'), false);
  assert.equal(isUsableThreadUrl('https://www.linkedin.com/feed/'), false);
  assert.equal(isUsableThreadUrl(''), false);
  assert.equal(isUsableThreadUrl(null), false);
  assert.equal(isUsableThreadUrl(undefined), false);
});
