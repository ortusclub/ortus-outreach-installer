import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maybeBuildFollowUp } from '../src/linkedin/auto-intro.js';

// NOTE: set introData keys to match personalizeTemplate's expectations so
// `{first name}` renders. Read personalizeTemplate before finalizing keys.
// personalizeTemplate normalizes keys: lowercases + removes spaces/underscores/hyphens.
// So 'firstName' -> 'firstname' which matches token '{first name}' -> 'firstname'.
const introData = { firstName: 'Lee' };

test('follow-up posting identity = tpl.primarySource (GoLogin profile)', () => {
  const task = maybeBuildFollowUp({
    tpl: { followUpEnabled: true, followUpBody: 'Hi {first name}', primarySource: 'profileX', followUpDelayMinutes: 10 },
    introData, profileId: 'campaignAcct1', profileName: 'alec@x', sheetUrl: 'u',
    leadName: 'Lee', url: 'https://lnkd/in/lee', threadUrl: 'https://www.linkedin.com/messaging/thread/abc', now: 1000,
  });
  assert.equal(task.sender, 'profileX');
  assert.equal(task.body, 'Hi Lee');            // personalized at build time, independent of posting identity
  assert.equal(task.campaignProfileId, 'campaignAcct1');
});

test('follow-up posting identity defaults to local-browser when primarySource absent', () => {
  const task = maybeBuildFollowUp({
    tpl: { followUpEnabled: true, followUpBody: 'Hi', followUpDelayMinutes: 10 },
    introData, profileId: 'campaignAcct1', profileName: 'alec@x', sheetUrl: 'u',
    leadName: 'Lee', url: 'u2', threadUrl: 't', now: 1000,
  });
  assert.equal(task.sender, 'local-browser');
});

test('follow-up disabled returns null', () => {
  assert.equal(maybeBuildFollowUp({ tpl: { followUpEnabled: false }, introData, profileId: 'p' }), null);
});
