import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCloudLeads, invitedWritebackFromLeads, makeRunStore, reconcileCloudRun } from '../src/connections/fg-cloud-launch.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// FG row: [Name, URL, MemberID, Company, Title, ...]
const row = (name, url, member, company = 'Acme', title = 'CMO') =>
  [name, url, member, company, title, '', '', '', '', '', '', '', ''];

test('buildCloudLeads flattens rows to engine leads with routeAccount + row_data', () => {
  const pairs = [{ profileId: 'p1', account: 'a@x.com', operator: 'op@x.com', operatorName: 'Op' }];
  const deps = {
    buildTargets: () => ({ rows: [row('Jane Doe', 'https://linkedin.com/in/jane', '111')], count: 1, reason: '' }),
  };
  const { perAccount, leads } = buildCloudLeads(pairs, { month: '2026-07' }, deps);
  assert.equal(leads.length, 1);
  assert.deepEqual(leads[0], {
    leadUrl: 'https://linkedin.com/in/jane',
    fullName: 'Jane Doe',
    memberUrn: null,
    routeAccount: 'p1',
    row: { memberId: '111', name: 'Jane Doe', company: 'Acme', title: 'CMO' },
  });
  assert.equal(perAccount[0].profileId, 'p1');
  assert.equal(perAccount[0].account, 'a@x.com');
  assert.equal(perAccount[0].operator, 'op@x.com');
  assert.equal(perAccount[0].month, '2026-07');
  assert.deepEqual(perAccount[0].rowsByUrl, { 'https://linkedin.com/in/jane': '111' });
});

test('buildCloudLeads drops rows with an empty URL', () => {
  const pairs = [{ profileId: 'p1', account: 'a', operator: 'o' }];
  const deps = { buildTargets: () => ({ rows: [['No URL', '', '222']], count: 1, reason: '' }) };
  const { leads } = buildCloudLeads(pairs, { month: '2026-07' }, deps);
  assert.equal(leads.length, 0);
});

test('buildCloudLeads dedups a contact across accounts — first pair wins', () => {
  const shared = row('Shared Person', 'https://linkedin.com/in/shared', '999');
  const pairs = [
    { profileId: 'p1', account: 'a1', operator: 'o1' },
    { profileId: 'p2', account: 'a2', operator: 'o2' },
  ];
  const deps = { buildTargets: (pair) => ({ rows: [shared], count: 1, reason: '' }) };
  const { leads } = buildCloudLeads(pairs, { month: '2026-07' }, deps);
  assert.equal(leads.length, 1);
  assert.equal(leads[0].routeAccount, 'p1');
});

const record = {
  perAccount: [
    { profileId: 'p1', account: 'a1@x.com', operator: 'o1@x.com', month: '2026-07',
      rowsByUrl: { 'https://linkedin.com/in/jane': '111', 'https://linkedin.com/in/joe': '112' } },
    { profileId: 'p2', account: 'a2@x.com', operator: 'o2@x.com', month: '2026-07',
      rowsByUrl: { 'https://linkedin.com/in/kim': '221' } },
  ],
};

test('invitedWritebackFromLeads groups invited leads by account, resolves memberIds', () => {
  const cloudLeads = [
    { leadUrl: 'https://linkedin.com/in/jane', account: 'p1', stage: 'Invited', status: 'sent' },
    { leadUrl: 'https://linkedin.com/in/joe', account: 'p1', stage: null, status: 'sent' },
    { leadUrl: 'https://linkedin.com/in/kim', account: 'p2', stage: 'Invited', status: 'sent' },
  ];
  const groups = invitedWritebackFromLeads(cloudLeads, record);
  const g1 = groups.find((g) => g.account === 'a1@x.com');
  const g2 = groups.find((g) => g.account === 'a2@x.com');
  assert.deepEqual(g1, {
    account: 'a1@x.com', operator: 'o1@x.com', month: '2026-07', memberIds: ['111', '112'],
    invited: [
      { memberId: '111', url: 'https://linkedin.com/in/jane' },
      { memberId: '112', url: 'https://linkedin.com/in/joe' },
    ],
  });
  assert.deepEqual(g2, {
    account: 'a2@x.com', operator: 'o2@x.com', month: '2026-07', memberIds: ['221'],
    invited: [{ memberId: '221', url: 'https://linkedin.com/in/kim' }],
  });
});

test('invitedWritebackFromLeads ignores non-invited leads and unknown urls', () => {
  const cloudLeads = [
    { leadUrl: 'https://linkedin.com/in/jane', account: 'p1', stage: null, status: 'pending' }, // not invited
    { leadUrl: 'https://linkedin.com/in/ghost', account: 'p1', stage: 'Invited', status: 'sent' }, // url not in rowsByUrl
    { leadUrl: 'https://linkedin.com/in/kim', account: 'pX', stage: 'Invited', status: 'sent' }, // account not in record
  ];
  assert.deepEqual(invitedWritebackFromLeads(cloudLeads, record), []);
});

test('makeRunStore add/load/update round-trips atomically', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fgrun-'));
  const file = join(dir, 'fg-cloud-runs.json');
  try {
    const store = makeRunStore(file);
    assert.deepEqual(store.load(), []); // missing file → []
    store.add({ cloudId: 'c1', status: 'dispatched' });
    store.add({ cloudId: 'c2', status: 'dispatched' });
    assert.equal(store.load().length, 2);
    assert.equal(store.update('c1', { status: 'reconciled' }), true);
    assert.equal(store.update('nope', { status: 'x' }), false);
    const c1 = store.load().find((r) => r.cloudId === 'c1');
    assert.equal(c1.status, 'reconciled');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const recordForReconcile = {
  cloudId: 'c1',
  perAccount: [
    { profileId: 'p1', account: 'a1@x.com', operator: 'o1@x.com', month: '2026-07',
      rowsByUrl: { 'https://linkedin.com/in/jane': '111' } },
  ],
};

test('reconcileCloudRun skips a non-terminal campaign without writing', async () => {
  const calls = [];
  const res = await reconcileCloudRun(recordForReconcile, {
    getCampaign: async () => ({ status: 'running' }),
    getLeads: async () => { calls.push('getLeads'); return { leads: [] }; },
    markInvited: async () => calls.push('markInvited'),
    log: () => {},
  });
  assert.deepEqual(res, { reconciled: false, status: 'running' });
  assert.deepEqual(calls, []); // never fetched leads or wrote
});

test('reconcileCloudRun writes invited memberIds back on a terminal campaign', async () => {
  const marks = [];
  const res = await reconcileCloudRun(recordForReconcile, {
    getCampaign: async () => ({ status: 'done' }),
    getLeads: async () => ({ leads: [{ leadUrl: 'https://linkedin.com/in/jane', account: 'p1', stage: 'Invited', status: 'sent' }] }),
    markInvited: async (args) => marks.push(args),
    log: () => {},
  });
  assert.equal(res.reconciled, true);
  assert.deepEqual(marks, [{
    memberIds: ['111'], invited: [{ memberId: '111', url: 'https://linkedin.com/in/jane' }],
    account: 'a1@x.com', operator: 'o1@x.com', month: '2026-07',
  }]);
});

test('reconcileCloudRun on markInvited failure logs STRANDED and does not throw', async () => {
  const logs = [];
  const res = await reconcileCloudRun(recordForReconcile, {
    getCampaign: async () => ({ status: 'done' }),
    getLeads: async () => ({ leads: [{ leadUrl: 'https://linkedin.com/in/jane', account: 'p1', stage: 'Invited', status: 'sent' }] }),
    markInvited: async () => { throw new Error('sheet 503'); },
    log: (m) => logs.push(m),
  });
  assert.equal(res.reconciled, false);
  assert.equal(res.stranded, true);
  assert.match(logs.join('\n'), /STRANDED/);
});

test('reconcileCloudRun is a no-op when already reconciled', async () => {
  const res = await reconcileCloudRun({ ...recordForReconcile, status: 'reconciled' }, {
    getCampaign: async () => { throw new Error('should not be called'); },
    getLeads: async () => { throw new Error('should not be called'); },
    markInvited: async () => { throw new Error('should not be called'); },
    log: () => {},
  });
  assert.equal(res.reconciled, true);
});

import { startTeamLaunchCloud } from '../src/connections/fg-cloud-launch.js';

const onePair = [{ profileId: 'p1', account: 'a1@x.com', operator: 'o1@x.com', operatorName: 'Op1' }];
const oneTarget = () => ({ rows: [['Jane Doe', 'https://linkedin.com/in/jane', '111', 'Acme', 'CMO', '', '', '', '', '', '', '', '']], count: 1, reason: '' });

function fakeStore() {
  const runs = [];
  return { add: (r) => runs.push(r), load: () => runs, save: () => {}, update: () => true, _runs: runs };
}

test('startTeamLaunchCloud dispatches, queues proof, persists record', async () => {
  const store = fakeStore();
  const queued = [];
  const res = await startTeamLaunchCloud(onePair, {
    buildTargets: oneTarget,
    startCloud: async (p) => { assert.equal(p.mode, 'follower_growth'); assert.deepEqual(p.config, { inviteUrl: 'https://linkedin.com/company/ortus/invite', monthlyBudget: 30 }); assert.equal(p.leads.length, 1); assert.deepEqual(p.profileIds, ['p1']); return { id: 'cloud-1' }; },
    queueInvites: async (rows) => { queued.push(...rows); },
    runStore: store, now: () => '2026-07-15T00:00:00Z', log: () => {},
    month: '2026-07', owner: 'o1@x.com', name: 'Team FG', inviteUrl: 'https://linkedin.com/company/ortus/invite', monthlyBudget: 30,
  });
  assert.deepEqual(res, { cloudId: 'cloud-1' });
  assert.equal(queued.length, 1);
  assert.equal(store._runs.length, 1);
  assert.equal(store._runs[0].cloudId, 'cloud-1');
  assert.equal(store._runs[0].status, 'dispatched');
  assert.deepEqual(store._runs[0].perAccount[0].rowsByUrl, { 'https://linkedin.com/in/jane': '111' });
});

test('startTeamLaunchCloud returns error and does NOT queue when there are no targets', async () => {
  const store = fakeStore();
  let queuedCalled = false;
  const res = await startTeamLaunchCloud(onePair, {
    buildTargets: () => ({ rows: [], count: 0, reason: 'all already invited' }),
    startCloud: async () => { throw new Error('should not dispatch'); },
    queueInvites: async () => { queuedCalled = true; },
    runStore: store, now: () => 'now', log: () => {},
    month: '2026-07', owner: 'o', inviteUrl: 'u', monthlyBudget: 30,
  });
  assert.ok(res.error);
  assert.equal(queuedCalled, false);
  assert.equal(store._runs.length, 0);
});

test('startTeamLaunchCloud returns error and does NOT queue when dispatch fails', async () => {
  const store = fakeStore();
  let queuedCalled = false;
  const res = await startTeamLaunchCloud(onePair, {
    buildTargets: oneTarget,
    startCloud: async () => ({ error: 'engine unreachable' }),
    queueInvites: async () => { queuedCalled = true; },
    runStore: store, now: () => 'now', log: () => {},
    month: '2026-07', owner: 'o', inviteUrl: 'u', monthlyBudget: 30,
  });
  assert.equal(res.error, 'engine unreachable');
  assert.equal(queuedCalled, false);
  assert.equal(store._runs.length, 0);
});
