// tests/fg-team-launch.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTeamLaunch, pairToQueued, makeInitialStatus } from '../src/connections/fg-team-launch.js';

const FG_ROW = (name, mid) => [name, `url/${mid}`, mid, 'Co', 'Head of Marketing', 'marketing', 'Milan', 'Op', 'acct', 'Queued', '', '', '2026-06'];

test('pairToQueued maps FG_HEADER rows to the sender shape', () => {
  assert.deepEqual(pairToQueued([FG_ROW('Marta Rossi', 'm1')]), [
    { name: 'Marta Rossi', jobTitle: 'Head of Marketing', company: 'Co', memberId: 'm1' },
  ]);
});

test('runTeamLaunch runs accounts sequentially, skips empty/zero-target, records invited, never overlaps launches', async () => {
  const events = [];
  let open = 0, maxOpen = 0;
  const recorded = [];
  const pairs = [
    { operator: 'a@x', operatorName: 'A', account: 'a@x', profileId: 'p1' }, // sends m1
    { operator: 'b@x', operatorName: 'B', account: 'b@x', profileId: 'p2' }, // 0 targets → skip
    { operator: 'c@x', operatorName: 'C', account: 'c@x', profileId: 'p3' }, // sends m3
  ];
  const targetsByOp = { 'a@x': [FG_ROW('A1','m1')], 'b@x': [], 'c@x': [FG_ROW('C1','m3')] };
  const deps = {
    buildTargets: (pair) => ({ rows: targetsByOp[pair.operator], count: targetsByOp[pair.operator].length }),
    launch: async (pair) => { open++; maxOpen = Math.max(maxOpen, open); events.push(`launch:${pair.operator}`); return { page: {}, close: async () => { open--; events.push(`close:${pair.operator}`); } }; },
    send: async ({ queued }) => ({ invited: queued.map((q) => q.memberId), skipped: [], creditsBefore: 30, creditsAfter: 30 - queued.length }),
    record: async ({ account, invitedIds }) => { recorded.push({ account, invitedIds }); },
    log: (l) => events.push(`log:${l}`),
    now: () => '2026-06-23T00:00:00.000Z',
  };
  const ctx = { keywords: ['marketing'], month: '2026-06', getAbort: () => false };
  const status = makeInitialStatus(pairs);
  await runTeamLaunch(pairs, ctx, deps, status);

  assert.equal(maxOpen, 1, 'only one browser open at a time');
  assert.equal(status.running, false);
  assert.equal(status.phase, 'done');
  assert.equal(status.sent, 2);
  assert.equal(status.skipped, 1);
  assert.equal(status.invitesTotal, 2);
  assert.deepEqual(status.perAccount.map((a) => a.status), ['done', 'skipped', 'done']);
  assert.equal(status.perAccount[1].reason, 'no targets');
  assert.deepEqual(recorded, [
    { account: 'a@x', invitedIds: ['m1'] },
    { account: 'c@x', invitedIds: ['m3'] },
  ]);
  // launches never interleave
  assert.deepEqual(events.filter((e) => e.startsWith('launch') || e.startsWith('close')),
    ['launch:a@x', 'close:a@x', 'launch:c@x', 'close:c@x']);
});

test('runTeamLaunch surfaces a specific skip reason from buildTargets', async () => {
  const pairs = [{ operator: 'a@x', operatorName: 'A', account: 'a@x', profileId: 'p1' }];
  const deps = {
    buildTargets: () => ({ rows: [], count: 0, reason: 'monthly budget used up — no invites remaining this month' }),
    launch: async () => ({ page: {}, close: async () => {} }),
    send: async () => ({ invited: [], skipped: [], creditsBefore: 0, creditsAfter: 0 }),
    record: async () => {},
    log: () => {},
    now: () => '2026-06-23T00:00:00.000Z',
  };
  const ctx = { keywords: [], month: '2026-06', getAbort: () => false };
  const status = makeInitialStatus(pairs);
  await runTeamLaunch(pairs, ctx, deps, status);
  assert.equal(status.perAccount[0].status, 'skipped');
  assert.equal(status.perAccount[0].reason, 'monthly budget used up — no invites remaining this month');
  assert.ok(status.logs.some((l) => l.includes('monthly budget used up')));
});

test('runTeamLaunch aborts before the next account when getAbort flips', async () => {
  const pairs = [
    { operator: 'a@x', operatorName: 'A', account: 'a@x', profileId: 'p1' },
    { operator: 'b@x', operatorName: 'B', account: 'b@x', profileId: 'p2' },
  ];
  let aborted = false;
  const deps = {
    buildTargets: () => ({ rows: [FG_ROW('X','mX')], count: 1 }),
    launch: async () => ({ page: {}, close: async () => {} }),
    send: async ({ queued }) => { aborted = true; return { invited: queued.map((q) => q.memberId), skipped: [], creditsBefore: 30, creditsAfter: 29 }; },
    record: async () => {},
    log: () => {},
    now: () => '2026-06-23T00:00:00.000Z',
  };
  const ctx = { keywords: [], month: '2026-06', getAbort: () => aborted }; // flips true after first send
  const status = makeInitialStatus(pairs);
  await runTeamLaunch(pairs, ctx, deps, status);
  assert.equal(status.perAccount[0].status, 'done');
  assert.equal(status.perAccount[1].status, 'skipped');
  assert.equal(status.perAccount[1].reason, 'stopped');
});
