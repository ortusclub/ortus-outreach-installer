import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMailer } from '../services/fg-roster/mailer.js';

test('sendAlert is a no-op when no recipients configured', async () => {
  let called = false;
  const transport = { sendMail: async () => { called = true; } };
  const mailer = makeMailer({ to: '', transport });
  const r = await mailer.sendAlert('subj', 'body');
  assert.equal(r.sent, false);
  assert.equal(r.reason, 'no-recipients');
  assert.equal(called, false);
});

test('sendAlert sends to each recipient when configured', async () => {
  const sent = [];
  const transport = { sendMail: async (m) => { sent.push(m); return { messageId: 'x' }; } };
  const mailer = makeMailer({ to: 'a@x.com, b@x.com', from: 'fg@x.com', transport });
  const r = await mailer.sendAlert('Run failed', 'details');
  assert.equal(r.sent, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'a@x.com, b@x.com');
  assert.equal(sent[0].subject, 'Run failed');
  assert.match(sent[0].text, /details/);
});
