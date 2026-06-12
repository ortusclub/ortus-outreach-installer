import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTemplates } from '../src/campaign.js';

test('normalizeTemplates passes through the new primary-side fields with safe defaults', () => {
  const t = normalizeTemplates({}, 'connect_and_introduce');
  assert.equal(t.autoAcceptPrimary, false);
  assert.equal(t.followUpEnabled, false);
  assert.equal(t.followUpBody, '');
  assert.equal(t.followUpDelayMinutes, 10);
  assert.equal(t.primarySource, 'local-browser');
});

test('normalizeTemplates honors provided primary-side values', () => {
  const t = normalizeTemplates({
    autoAcceptPrimary: true,
    followUpEnabled: true,
    followUpBody: '  Hi {first name}  ',
    followUpDelayMinutes: '25',
    primarySource: 'profile-abc123',
  }, 'connect_and_introduce');
  assert.equal(t.autoAcceptPrimary, true);
  assert.equal(t.followUpEnabled, true);
  assert.equal(t.followUpBody, 'Hi {first name}');
  assert.equal(t.followUpDelayMinutes, 25);
  assert.equal(t.primarySource, 'profile-abc123');
});

test('primarySource falls back to local-browser for empty/unknown', () => {
  assert.equal(normalizeTemplates({ primarySource: '' }, 'connect_and_introduce').primarySource, 'local-browser');
  assert.equal(normalizeTemplates({}, 'connect_and_introduce').primarySource, 'local-browser');
});

test('legacy followUpSender / autoAcceptSender are no longer emitted', () => {
  const t = normalizeTemplates({ followUpSender: 'campaign-account', autoAcceptSender: 'profX' }, 'connect_and_introduce');
  assert.equal(t.followUpSender, undefined);
  assert.equal(t.autoAcceptSender, undefined);
  assert.equal(t.primarySource, 'local-browser');
});
