import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTemplates } from '../src/campaign.js';

test('normalizeTemplates passes through the new primary-side fields with safe defaults', () => {
  const t = normalizeTemplates({}, 'connect_and_introduce');
  assert.equal(t.autoAcceptPrimary, false);
  assert.equal(t.followUpEnabled, false);
  assert.equal(t.followUpBody, '');
  assert.equal(t.followUpDelayMinutes, 10);
  assert.equal(t.followUpSender, 'local-browser');
  assert.equal(t.autoAcceptSender, 'local-browser');
});

test('normalizeTemplates honors provided primary-side values', () => {
  const t = normalizeTemplates({
    autoAcceptPrimary: true,
    followUpEnabled: true,
    followUpBody: '  Hi {first name}  ',
    followUpDelayMinutes: '25',
    followUpSender: 'campaign-account',
    autoAcceptSender: 'profile-abc123',
  }, 'connect_and_introduce');
  assert.equal(t.autoAcceptPrimary, true);
  assert.equal(t.followUpEnabled, true);
  assert.equal(t.followUpBody, 'Hi {first name}');
  assert.equal(t.followUpDelayMinutes, 25);
  assert.equal(t.followUpSender, 'campaign-account');
  assert.equal(t.autoAcceptSender, 'profile-abc123');
});

test('followUpSender falls back to local-browser for unknown values', () => {
  const t = normalizeTemplates({ followUpSender: 'nonsense' }, 'connect_and_introduce');
  assert.equal(t.followUpSender, 'local-browser');
});

test('autoAcceptSender falls back to local-browser for empty/unknown', () => {
  assert.equal(normalizeTemplates({ autoAcceptSender: '' }, 'connect_and_introduce').autoAcceptSender, 'local-browser');
  assert.equal(normalizeTemplates({}, 'connect_and_introduce').autoAcceptSender, 'local-browser');
});
