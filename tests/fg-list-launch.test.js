import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildListRows, dispatchFromRows } from '../src/connections/fg-list-launch.js';
import { FG_LIST_HEADER } from '../src/connections/fg-list.js';

const ACCOUNT_EMAILS = { pid_ada: 'ada@ortus.example', pid_grace: 'grace@ortus.example' };

// buildTargets stub: returns FG_HEADER-order rows [Name, URL, MemberID, Company, Title, ...]
function fakeBuildTargets(byProfile) {
  return (pair) => ({ rows: byProfile[pair.profileId] || [], reason: '' });
}

test('buildListRows converts per-pair targets to list rows with Account Email', () => {
  const pairs = [
    { profileId: 'pid_ada', account: 'ada@ortus.example' },
    { profileId: 'pid_grace', account: 'grace@ortus.example' },
  ];
  const buildTargets = fakeBuildTargets({
    pid_ada: [['Ada Lovelace', 'https://li/ada', '111', 'Engines', 'CMO']],
    pid_grace: [['Grace Hopper', 'https://li/grace', '222', 'Navy', 'Admiral']],
  });
  const { header, rows, perAccount, skipped } = buildListRows(pairs, { accountEmails: ACCOUNT_EMAILS }, { buildTargets });

  assert.deepEqual(header, FG_LIST_HEADER);
  assert.equal(skipped.length, 0);
  assert.equal(rows.length, 2);
  // First/last split, reordered, account email + member id present.
  assert.deepEqual(rows[0], ['Ada', 'Lovelace', 'https://li/ada', 'CMO', 'Engines', 'ada@ortus.example', 'Queued', '', '', '111']);
  assert.equal(perAccount.find((a) => a.profileId === 'pid_ada').count, 1);
});

test('buildListRows de-dupes a person claimed by an earlier account', () => {
  const pairs = [{ profileId: 'pid_ada', account: 'a' }, { profileId: 'pid_grace', account: 'g' }];
  const buildTargets = fakeBuildTargets({
    pid_ada: [['Ada Lovelace', 'https://li/ada', '111', 'Engines', 'CMO']],
    pid_grace: [['Ada Lovelace', 'https://li/ada', '111', 'Engines', 'CMO']], // same person → dropped
  });
  const { rows } = buildListRows(pairs, { accountEmails: ACCOUNT_EMAILS }, { buildTargets });
  assert.equal(rows.length, 1);
});

test('buildListRows flags an account with no resolvable email', () => {
  const pairs = [{ profileId: 'pid_unknown', account: '' }];
  const buildTargets = fakeBuildTargets({ pid_unknown: [['X Y', 'https://li/x', '9', 'Co', 'Role']] });
  const { skipped } = buildListRows(pairs, { accountEmails: {} }, { buildTargets });
  assert.deepEqual(skipped, [{ profileId: 'pid_unknown', reason: 'no email resolved for this account' }]);
});

test('dispatchFromRows builds routed leads and dispatches follower_growth', async () => {
  const rows = [
    FG_LIST_HEADER,
    ['Ada', 'Lovelace', 'https://li/ada', 'CMO', 'Engines', 'ada@ortus.example', '', '', '', '111'],
    ['Grace', 'Hopper', 'https://li/grace', 'Admiral', 'Navy', 'grace@ortus.example', '', '', '', '222'],
  ];
  let captured = null;
  const deps = { startCloud: async (p) => { captured = p; return { id: 'cmp_test' }; } };
  const res = await dispatchFromRows(rows, {
    accountEmails: ACCOUNT_EMAILS,
    campaign: { name: 'Team Follower Growth · 2026-08 · auto', owner: 'sam@ortus.example', config: { monthlyBudget: 30 } },
  }, deps);

  assert.equal(res.cloudId, 'cmp_test');
  assert.equal(res.leadCount, 2);
  assert.equal(res.skipped.length, 0);
  assert.equal(captured.mode, 'follower_growth');
  assert.deepEqual([...captured.profileIds].sort(), ['pid_ada', 'pid_grace']);
  assert.equal(captured.leads[0].routeAccount, 'pid_ada');
  assert.equal(captured.config.monthlyBudget, 30);
  // Every dispatch carries accountEmails — the engine labels its log lines and
  // account pills with it, and prints raw GoLogin ids when it's missing.
  assert.deepEqual(captured.config.accountEmails, ACCOUNT_EMAILS);
});

test('dispatchFromRows returns an error (not throw) when nothing usable', async () => {
  const rows = [
    FG_LIST_HEADER,
    ['Ada', 'Lovelace', 'https://li/ada', 'CMO', 'Engines', 'nobody@x.com', '', '', '', ''],
  ];
  let called = false;
  const res = await dispatchFromRows(rows, { accountEmails: ACCOUNT_EMAILS, campaign: {} }, { startCloud: async () => { called = true; return { id: 'x' }; } });
  assert.match(res.error, /No invites to send/);
  assert.equal(res.skipped[0].reason, 'unknown account email "nobody@x.com"');
  assert.equal(called, false); // never dispatched
});

test('dispatchFromRows surfaces skipped rows alongside a successful dispatch', async () => {
  const rows = [
    FG_LIST_HEADER,
    ['Ada', 'Lovelace', 'https://li/ada', 'CMO', 'Engines', 'ada@ortus.example', '', '', '', '111'],
    ['Bad', 'Row', '', 'x', 'y', 'ada@ortus.example', '', '', '', ''], // no URL → skipped
  ];
  const res = await dispatchFromRows(rows, { accountEmails: ACCOUNT_EMAILS, campaign: { name: 'n' } }, { startCloud: async () => ({ id: 'cmp_1' }) });
  assert.equal(res.cloudId, 'cmp_1');
  assert.equal(res.leadCount, 1);
  assert.deepEqual(res.skipped.map((s) => s.reason), ['missing LinkedIn URL']);
});
