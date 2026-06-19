import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyAccountChannels, isBreakdownMode } from '../public/js/account-guardrails.mjs';

test('breakdown modes = Message Campaign / Direct Messages / InMail Only', () => {
  assert.equal(isBreakdownMode('open_profile_only'), true);
  assert.equal(isBreakdownMode('message_only'), true);
  assert.equal(isBreakdownMode('inmail_only'), true);
  assert.equal(isBreakdownMode('connect_only'), false);
  assert.equal(isBreakdownMode('introduce_back'), false);
  assert.equal(isBreakdownMode('check_status'), false);
});

test('returns the 3 non-CC channels in order: Sales Nav, LinkedIn, InMail', () => {
  const { channels } = classifyAccountChannels({
    salesNavCredits: 'Used', linkedinCredits: 'Available', inmailCredits: 'NA',
  });
  assert.deepEqual(channels.map((c) => c.label), ['SN OP', 'LN OP', 'InMail']);
  assert.deepEqual(channels.map((c) => c.status), ['Used', 'Available', 'NA']);
});

test('usable only when the channel is "Available"', () => {
  const { channels } = classifyAccountChannels({
    salesNavCredits: 'Used', linkedinCredits: 'Available', inmailCredits: 'In Use',
  });
  assert.deepEqual(channels.map((c) => c.usable), [false, true, false]);
});

test('anyFree reflects at least one Available channel', () => {
  assert.equal(classifyAccountChannels({ linkedinCredits: 'Available' }).anyFree, true);
  assert.equal(classifyAccountChannels({ salesNavCredits: 'Used', linkedinCredits: 'NA', inmailCredits: 'In Use' }).anyFree, false);
});

test('reserver (who) comes from the channel\'s own User column, only when In Use', () => {
  const { channels } = classifyAccountChannels({
    salesNavCredits: 'In Use', salesNavUser: 'bleron@ortusclub.com, 2026-06-17, In Use',
    linkedinCredits: 'Available', linkedinUser: 'shouldNotShow',
  });
  assert.equal(channels[0].who, 'bleron');   // SN in use → who from salesNavUser, cleaned
  assert.equal(channels[1].who, '');          // OP available → no who
});

test('restricted Status → blocked flag (whole account off-limits)', () => {
  assert.equal(classifyAccountChannels({ Status: 'Identity Restricted', linkedinCredits: 'Available' }).blocked, true);
  assert.equal(classifyAccountChannels({ linkedinCredits: 'Available' }).blocked, false);
});

test('anyActive = a channel is Available OR In Use (all-In-Use stays active)', () => {
  // all In Use → no free channel, but still "active" (selectable, like Connect tiles).
  const allInUse = classifyAccountChannels({ salesNavCredits: 'In Use', linkedinCredits: 'In Use', inmailCredits: 'In Use' });
  assert.equal(allInUse.anyFree, false);
  assert.equal(allInUse.anyActive, true);
  // all dead (NA/Used/Partial) → not active → the picker locks it.
  const allDead = classifyAccountChannels({ salesNavCredits: 'Used', linkedinCredits: 'NA', inmailCredits: 'Partial Inaccessible' });
  assert.equal(allDead.anyActive, false);
});

test('null soo → empty channels, not free, not active, not blocked', () => {
  assert.deepEqual(classifyAccountChannels(null), { channels: [], anyFree: false, anyActive: false, blocked: false });
});
