/**
 * A LinkedIn account outlives the campaign that used it. Every follow-up queued
 * before campaignId was stamped can only be placed by its account, so without a
 * date these guards let a campaign started in August adopt a follow-up that
 * failed in July. Measured on a real queue: "Udit Pandey", failed 19 July, was
 * being counted on EXPO_GUES_LND_II, started 26 August, because both ran the
 * same login. These tests pin the three places that has to hold.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  belongsToCampaign, claimedByLive, healthForCampaign,
  groupStaleFollowUps, discardGroups, groupKeyOf,
} from '../src/followup-groups.js';

const JULY = Date.parse('2026-07-19T10:00:00Z');
const AUG = Date.parse('2026-08-26T10:00:00Z');
const SEP = Date.parse('2026-09-01T10:00:00Z');
const ACCT = 'acct-shared';

const task = (over = {}) => ({
  id: `t${Math.random()}`, type: 'follow-up', status: 'failed',
  campaignProfileId: ACCT, createdAt: SEP, body: 'Hi Ann, following up.',
  leadName: 'Ann', ...over,
});

test('a follow-up queued before the campaign started is not that campaign\'s', () => {
  const orphan = task({ createdAt: JULY });
  assert.equal(belongsToCampaign(orphan, { profileIds: [ACCT], startedAt: AUG }), false);
  assert.equal(belongsToCampaign(task({ createdAt: SEP }), { profileIds: [ACCT], startedAt: AUG }), true);
});

test('a task queued at the exact start instant still counts', () => {
  assert.equal(belongsToCampaign(task({ createdAt: AUG }), { profileIds: [ACCT], startedAt: AUG }), true);
});

test('no start date means the old account-only behaviour, never a silent drop', () => {
  assert.equal(belongsToCampaign(task({ createdAt: JULY }), { profileIds: [ACCT] }), true);
  assert.equal(belongsToCampaign(task({ createdAt: JULY }), { profileIds: [ACCT], startedAt: 0 }), true);
});

test('a task with no createdAt is not dropped by the guard', () => {
  assert.equal(belongsToCampaign(task({ createdAt: undefined }), { profileIds: [ACCT], startedAt: AUG }), true);
});

test('campaignId always wins over the account fallback', () => {
  const t = task({ campaignId: 'c1', createdAt: JULY });
  assert.equal(belongsToCampaign(t, { campaignId: 'c1', profileIds: [], startedAt: AUG }), true);
  assert.equal(belongsToCampaign(t, { campaignId: 'c2', profileIds: [ACCT], startedAt: 0 }), false);
});

test('the card stops counting the older campaign\'s orphan', () => {
  const tasks = [task({ createdAt: JULY }), task({ createdAt: SEP, status: 'done' })];
  const h = healthForCampaign(tasks, { profileIds: [ACCT], startedAt: AUG });
  assert.equal(h.sent, 1);
  assert.equal(h.failed, 0, 'the July failure belongs to whatever ran before');
});

test('and the strip picks it up, so it is still visible somewhere', () => {
  const orphan = task({ createdAt: JULY, body: 'Hello Ann, i am Bob' });
  const mine = task({ createdAt: SEP });
  const groups = groupStaleFollowUps([orphan, mine], {
    liveCampaigns: [{ id: 'c1', profileIds: [ACCT], startedAt: AUG }],
  });
  assert.equal(groups.length, 1, 'exactly the orphan');
  assert.equal(groups[0].count, 1);
  assert.equal(groups[0].message, 'Hello Ann, i am Bob');
});

test('claimedByLive is the one test the card and the strip share', () => {
  const live = [{ id: 'c1', profileIds: [ACCT], startedAt: AUG }];
  assert.equal(claimedByLive(task({ createdAt: SEP }), live), true);
  assert.equal(claimedByLive(task({ createdAt: JULY }), live), false);
});

test('Discard cannot reach a campaign still on the board that shares the message', () => {
  // Sibling campaigns reuse one follow-up template: measured on a live queue,
  // a single message key covered two campaigns that were both still running.
  const orphan = task({ createdAt: JULY, campaignProfileId: 'gone' });
  const liveOne = task({ createdAt: SEP, campaignProfileId: ACCT });
  assert.equal(groupKeyOf(orphan), groupKeyOf(liveOne), 'same template, same key');

  const key = groupKeyOf(orphan);
  const { tasks, discarded } = discardGroups([orphan, liveOne], [key], {
    liveCampaigns: [{ id: 'c1', profileIds: [ACCT], startedAt: AUG }],
  });
  assert.equal(discarded.length, 1, 'only the orphan');
  assert.equal(tasks.find((t) => t.id === orphan.id).status, 'discarded');
  assert.equal(tasks.find((t) => t.id === liveOne.id).status, 'failed', 'the running campaign is untouched');
});

test('with no live scope Discard still drops what it was given', () => {
  const t = task({ createdAt: JULY });
  const { discarded } = discardGroups([t], [groupKeyOf(t)]);
  assert.equal(discarded.length, 1);
});
