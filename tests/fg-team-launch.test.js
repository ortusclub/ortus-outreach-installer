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

test('runTeamLaunch writes observed credits back per account (even 0 sent)', async () => {
  const observed = [];
  const pairs = [
    { operator: 'a@x', operatorName: 'A', account: 'a@x', profileId: 'p1' }, // sends 1
    { operator: 'b@x', operatorName: 'B', account: 'b@x', profileId: 'p2' }, // 0 sent but credits read
  ];
  const sendByOp = {
    'a@x': { invited: ['m1'], skipped: [], creditsBefore: 5, creditsAfter: 4, allowance: 30, refill: 'June 30, 2026' },
    'b@x': { invited: [], skipped: ['m2'], creditsBefore: 0, creditsAfter: 0, allowance: 30, refill: 'June 30, 2026' },
  };
  let idx = 0;
  const deps = {
    buildTargets: (pair) => ({ rows: [FG_ROW('X', pair.operator === 'a@x' ? 'm1' : 'm2')], count: 1 }),
    launch: async () => ({ page: {}, close: async () => {} }),
    send: async () => sendByOp[pairs[idx++].operator], // accounts run sequentially
    record: async () => {},
    observeCredits: async (o) => { observed.push(o); },
    log: () => {},
    now: () => '2026-06-23T00:00:00.000Z',
  };
  const ctx = { keywords: [], month: '2026-06', getAbort: () => false };
  await runTeamLaunch(pairs, ctx, deps, makeInitialStatus(pairs));
  assert.deepEqual(observed, [
    { account: 'a@x', operator: 'a@x', month: '2026-06', available: 4, allowance: 30, refill: 'June 30, 2026' },
    { account: 'b@x', operator: 'b@x', month: '2026-06', available: 0, allowance: 30, refill: 'June 30, 2026' },
  ]);
});

test('runTeamLaunch forwards already-following IDs to record', async () => {
  const pairs = [{ account: 'a@ortusclub.com', operator: 'a@ortusclub.com', profileId: 'p1' }];
  const status = makeInitialStatus(pairs);
  let recorded = null;
  const deps = {
    buildTargets: () => ({ rows: [['N', '', 'm1'], ['M', '', 'm2']], count: 2, reason: '' }),
    launch: async () => ({ page: {}, close: async () => {} }),
    send: async () => ({ invited: ['m1'], skipped: ['m2'], alreadyFollowing: ['m2'], creditsAfter: 4 }),
    record: async (arg) => { recorded = arg; },
    log: () => {},
    now: () => '2026-06-30T00:00:00Z',
  };
  await runTeamLaunch(pairs, { keywords: [], month: '2026-06', getAbort: () => false }, deps, status);
  assert.deepEqual(recorded.invitedIds, ['m1']);
  assert.deepEqual(recorded.alreadyFollowingIds, ['m2']);
});

test('runTeamLaunch labels a logged-out account distinctly', async () => {
  const pairs = [{ account: 'a@ortusclub.com', operator: 'a@ortusclub.com', profileId: 'p1' }];
  const status = makeInitialStatus(pairs);
  const deps = {
    buildTargets: () => ({ rows: [['N', '', 'm1']], count: 1, reason: '' }),
    launch: async () => { const e = new Error('logged out'); e.loggedOut = true; e.softSkip = true; throw e; },
    send: async () => ({ invited: [], skipped: [] }),
    record: async () => {},
    log: () => {},
    now: () => '2026-06-30T00:00:00Z',
  };
  await runTeamLaunch(pairs, { keywords: [], month: '2026-06', getAbort: () => false }, deps, status);
  assert.equal(status.perAccount[0].status, 'skipped');
  assert.equal(status.perAccount[0].reason, 'logged out');
  assert.equal(status.perAccount[0].loggedOut, true);
  assert.equal(status.skipped, 1);
  assert.ok(status.logs.some((l) => /Logged out/.test(l)));
});
