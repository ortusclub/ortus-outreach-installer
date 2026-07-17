import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTeamLaunchCloud, reconcileCloudRun } from '../src/connections/fg-cloud-launch.js';

test('startTeamLaunchCloud stamps runId=cloudId + runAt onto queued rows', async () => {
  let queuedOpts = null;
  const deps = {
    buildTargets: () => ({ rows: [['J','u','1','','','','','Op','a@x','Queued','','','2026-07']], count: 1, reason: '' }),
    startCloud: async () => ({ id: 'cmp_ABC' }),
    queueInvites: async (rows, opts) => { queuedOpts = opts; },
    runStore: { add: () => {} },
    now: () => '2026-07-17T11:40:00.000Z',
    log: () => {}, month: '2026-07', owner: '', name: 'x', inviteUrl: 'u', monthlyBudget: 30,
  };
  const out = await startTeamLaunchCloud([{ profileId: 'p1', account: 'a@x', operator: 'Op' }], deps);
  assert.equal(out.cloudId, 'cmp_ABC');
  assert.equal(queuedOpts.runId, 'cmp_ABC');
  assert.equal(queuedOpts.runAt, '2026-07-17T11:40:00.000Z');
});

test('reconcileCloudRun sweeps failures with runId=cloudId after marking invited', async () => {
  const calls = [];
  const deps = {
    getCampaign: async () => ({ status: 'done' }),
    getLeads: async () => ({ leads: [] }),
    markInvited: async () => { calls.push('invited'); },
    markFailed: async (a) => { calls.push('failed:' + a.runId); },
    log: () => {},
  };
  const out = await reconcileCloudRun({ cloudId: 'cmp_ABC', perAccount: [] }, deps);
  assert.equal(out.reconciled, true);
  assert.deepEqual(calls, ['failed:cmp_ABC']); // no invited groups, but sweep still runs
});
