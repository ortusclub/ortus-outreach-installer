import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runFollowerInvites } from '../../src/linkedin/follower-invite.js';

test('runFollowerInvites caps at credits, selects, skips ambiguous, invites once', async () => {
  const queued = [
    { name: 'Mara Lee', jobTitle: 'Head of Marketing', company: 'Acme', memberId: '1' },
    { name: 'Dan Roe', jobTitle: 'Brand Lead', company: 'Initech', memberId: '2' },
    { name: 'Amb Ig', jobTitle: 'Marketing', company: 'X', memberId: '3' },
    { name: 'Phil Roe', jobTitle: 'Growth', company: 'Z', memberId: '4' },
    { name: 'Quinn Vee', jobTitle: 'CMO', company: 'Y', memberId: '5' },
  ];
  const calls = { invites: 0 };
  const deps = {
    readCredits: async () => 3,
    selectPerson: async (_page, person) => person.name !== 'Amb Ig',
    clickInvite: async () => { calls.invites += 1; return true; },
    sleep: async () => {},
  };
  const res = await runFollowerInvites({ page: {}, queued, log: () => {}, shouldAbort: () => false, deps });
  assert.deepEqual(res.invited, ['1', '2', '4']);
  assert.deepEqual(res.skipped, ['3']);
  assert.ok(!res.invited.includes('5') && !res.skipped.includes('5'));
  assert.equal(res.creditsBefore, 3);
  assert.equal(res.creditsAfter, 0);
  assert.equal(calls.invites, 1);
});

test('runFollowerInvites: nothing selected → no Invite click, all reported skipped', async () => {
  const deps = { readCredits: async () => 5, selectPerson: async () => false, clickInvite: async () => { throw new Error('should not click'); }, sleep: async () => {} };
  const res = await runFollowerInvites({ page: {}, queued: [{ name: 'A', memberId: '1' }], deps });
  assert.deepEqual(res.invited, []);
  assert.deepEqual(res.skipped, ['1']);
  assert.equal(res.sent, false);
});

test('runFollowerInvites fires onProgress once per person, in order, with index/total/ok', async () => {
  const queued = [
    { name: 'Mara Lee', memberId: '1' },  // selected
    { name: 'Amb Ig', memberId: '2' },    // skipped
    { name: 'Dan Roe', memberId: '3' },   // selected
  ];
  const ticks = [];
  const deps = {
    readCredits: async () => 5,
    selectPerson: async (_page, person) => person.name !== 'Amb Ig',
    clickInvite: async () => true,
    sleep: async () => {},
  };
  await runFollowerInvites({
    page: {}, queued, deps,
    onProgress: (p) => ticks.push({ name: p.person.name, ok: p.ok, index: p.index, total: p.total, selectedSoFar: p.selectedSoFar }),
  });
  assert.deepEqual(ticks, [
    { name: 'Mara Lee', ok: true, index: 1, total: 3, selectedSoFar: 1 },
    { name: 'Amb Ig', ok: false, index: 2, total: 3, selectedSoFar: 1 },
    { name: 'Dan Roe', ok: true, index: 3, total: 3, selectedSoFar: 2 },
  ]);
});

test('runFollowerInvites: a throwing onProgress never breaks the run', async () => {
  const deps = { readCredits: async () => 5, selectPerson: async () => true, clickInvite: async () => true, sleep: async () => {} };
  const res = await runFollowerInvites({
    page: {}, queued: [{ name: 'A', memberId: '1' }], deps,
    onProgress: () => { throw new Error('progress boom'); },
  });
  assert.deepEqual(res.invited, ['1']);
  assert.equal(res.sent, true);
});

test('runFollowerInvites collects already-follows IDs separately', async () => {
  const queued = [
    { name: 'Mara Lee', memberId: '1' },   // selected
    { name: 'Dan Roe', memberId: '2' },    // already follows
  ];
  const deps = {
    readCredits: async () => 5,
    selectPerson: async (_page, person) =>
      person.name === 'Mara Lee' ? { selected: true, reason: 'ok' } : { selected: false, reason: 'already-follows' },
    clickInvite: async () => true,
    sleep: async () => {},
  };
  const res = await runFollowerInvites({ page: {}, queued, log: () => {}, shouldAbort: () => false, deps });
  assert.deepEqual(res.invited, ['1']);
  assert.deepEqual(res.alreadyFollowing, ['2']);
  assert.ok(res.skipped.includes('2'));
});
