import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maybeBuildFollowUp } from '../src/linkedin/auto-intro.js';

const base = {
  tpl: { followUpEnabled: true, followUpBody: 'Hi {first name}', followUpDelayMinutes: 10, followUpSender: 'local-browser',
         primaryName: 'You', primaryUrl: 'https://lnkd/in/you', introTitle: 'Intro' },
  introData: { 'first name': 'Jane', firstName: 'Jane', company: 'Acme' },
  profileId: 'p1', profileName: 'patrick.s', sheetUrl: 'https://docs.google.com/spreadsheets/d/SHEET123/edit',
  leadName: 'Jane Doe', url: 'https://www.linkedin.com/in/jane',
  threadUrl: 'https://www.linkedin.com/messaging/thread/2-abc==/', now: 1000,
};

test('maybeBuildFollowUp renders body + sets due time when enabled', () => {
  const t = maybeBuildFollowUp(base);
  assert.ok(t);
  assert.equal(t.type, 'follow-up');
  assert.equal(t.body, 'Hi Jane');
  assert.equal(t.sender, 'local-browser');
  assert.equal(t.dueAt, 1000 + 10 * 60_000);
  assert.equal(t.sheetId, 'SHEET123');
  assert.equal(t.threadUrl, base.threadUrl);
});

test('maybeBuildFollowUp returns null when disabled', () => {
  assert.equal(maybeBuildFollowUp({ ...base, tpl: { ...base.tpl, followUpEnabled: false } }), null);
});

test('maybeBuildFollowUp returns null when body is blank', () => {
  assert.equal(maybeBuildFollowUp({ ...base, tpl: { ...base.tpl, followUpBody: '   ' } }), null);
});

test('maybeBuildFollowUp sender = primarySource when set', () => {
  const t = maybeBuildFollowUp({ ...base, tpl: { ...base.tpl, primarySource: 'p1' } });
  assert.equal(t.sender, 'p1');
});
