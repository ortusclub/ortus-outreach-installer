import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateTeamStatus, bucketForCloudStatus, detectAccountConflicts } from '../src/team-status.js';

test('bucketForCloudStatus maps engine statuses like the campaigns board', () => {
  assert.equal(bucketForCloudStatus('running'), 'running');
  assert.equal(bucketForCloudStatus('pending'), 'queued');
  assert.equal(bucketForCloudStatus('queued'), 'queued');
  assert.equal(bucketForCloudStatus('done'), 'done');
  assert.equal(bucketForCloudStatus('cancelled'), 'done');
  assert.equal(bucketForCloudStatus('error'), 'done');
  assert.equal(bucketForCloudStatus(''), 'done');
  assert.equal(bucketForCloudStatus(undefined), 'done');
});

test('aggregateTeamStatus groups per owner and sums buckets + sent', () => {
  const rows = aggregateTeamStatus([
    { owner: 'a@ortusclub.com', bucket: 'running', sent: 12 },
    { owner: 'a@ortusclub.com', bucket: 'done', sent: 30 },
    { owner: 'b@ortusclub.com', bucket: 'queued', sent: 0 },
  ]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    owner: 'a@ortusclub.com', running: 1, queued: 0, done: 1, sent: 42,
    campaignName: '', mode: '', accounts: [], accountNames: {}, startedAt: null,
  });
  assert.deepEqual(rows[1], {
    owner: 'b@ortusclub.com', running: 0, queued: 1, done: 0, sent: 0,
    campaignName: '', mode: '', accounts: [], accountNames: {}, startedAt: null,
  });
});

test('aggregateTeamStatus enriches a running entry with campaign/mode/accounts/startedAt', () => {
  const rows = aggregateTeamStatus([
    {
      owner: 'a@ortusclub.com', bucket: 'running', sent: 12,
      campaignName: 'CC+IC — FinTech CTOs', mode: 'connect_and_introduce',
      accounts: ['acc-1', 'acc-2'], accountNames: { 'acc-1': 'James Okafor' },
      startedAt: '2026-07-09T01:41:00.000Z',
    },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].campaignName, 'CC+IC — FinTech CTOs');
  assert.equal(rows[0].mode, 'connect_and_introduce');
  assert.deepEqual(rows[0].accounts, ['acc-1', 'acc-2']);
  assert.deepEqual(rows[0].accountNames, { 'acc-1': 'James Okafor' });
  assert.equal(rows[0].startedAt, '2026-07-09T01:41:00.000Z');
});

test('aggregateTeamStatus dedupes accounts and merges names across an owner\'s running entries', () => {
  const rows = aggregateTeamStatus([
    { owner: 'a@x.com', bucket: 'running', sent: 1, accounts: ['acc-1'], accountNames: { 'acc-1': 'James' }, startedAt: '2026-07-09T02:00:00.000Z' },
    { owner: 'a@x.com', bucket: 'running', sent: 1, accounts: ['acc-1', 'acc-2'], accountNames: { 'acc-2': 'Marta' }, startedAt: '2026-07-09T01:00:00.000Z' },
  ]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].accounts, ['acc-1', 'acc-2']);
  assert.deepEqual(rows[0].accountNames, { 'acc-1': 'James', 'acc-2': 'Marta' });
  // Earlier startedAt wins the displayed campaign fields.
  assert.equal(rows[0].startedAt, '2026-07-09T01:00:00.000Z');
});

test('aggregateTeamStatus leaves campaign fields blank when the owner has no running entry', () => {
  const rows = aggregateTeamStatus([
    { owner: 'a@x.com', bucket: 'queued', sent: 0 },
    { owner: 'a@x.com', bucket: 'done', sent: 5 },
  ]);
  assert.equal(rows[0].campaignName, '');
  assert.equal(rows[0].mode, '');
  assert.deepEqual(rows[0].accounts, []);
  assert.equal(rows[0].startedAt, null);
});

test('aggregateTeamStatus normalizes owner case/whitespace', () => {
  const rows = aggregateTeamStatus([
    { owner: 'A@Ortusclub.com ', bucket: 'running', sent: 1 },
    { owner: 'a@ortusclub.com', bucket: 'done', sent: 2 },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].owner, 'a@ortusclub.com');
  assert.equal(rows[0].sent, 3);
});

test('aggregateTeamStatus handles missing owner, bad buckets, bad sent', () => {
  const rows = aggregateTeamStatus([
    { bucket: 'running', sent: 5 },
    { owner: '', bucket: 'nonsense', sent: 'NaN' },
    { owner: null, bucket: 'done', sent: -3 },
  ]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    owner: '(unknown)', running: 1, queued: 0, done: 2, sent: 5,
    campaignName: '', mode: '', accounts: [], accountNames: {}, startedAt: null,
  });
});

test('aggregateTeamStatus sorts running owners first, then sent desc, then name', () => {
  const rows = aggregateTeamStatus([
    { owner: 'idle-big@x.com', bucket: 'done', sent: 100 },
    { owner: 'runner@x.com', bucket: 'running', sent: 1 },
    { owner: 'idle-small@x.com', bucket: 'done', sent: 100 },
  ]);
  assert.deepEqual(rows.map((r) => r.owner),
    ['runner@x.com', 'idle-big@x.com', 'idle-small@x.com']);
});

test('aggregateTeamStatus tolerates non-array and junk entries', () => {
  assert.deepEqual(aggregateTeamStatus(null), []);
  assert.deepEqual(aggregateTeamStatus(undefined), []);
  assert.deepEqual(aggregateTeamStatus([null, 42, 'x']), []);
});

// ── detectAccountConflicts ──────────────────────────────────────────────

test('detectAccountConflicts returns [] when there is no overlap', () => {
  const rows = [{ owner: 'marlon.j', accounts: ['acc-1', 'acc-2'] }];
  assert.deepEqual(detectAccountConflicts(rows, ['acc-3']), []);
});

test('detectAccountConflicts flags an account selected in my draft and In Use by another owner', () => {
  const rows = [
    { owner: 'marlon.j', accounts: ['acc-1'], accountNames: { 'acc-1': 'Acme Inc' } },
  ];
  const conflicts = detectAccountConflicts(rows, ['acc-1', 'acc-9']);
  assert.deepEqual(conflicts, [{ account: 'acc-1', accountName: 'Acme Inc', heldBy: 'marlon.j' }]);
});

test('detectAccountConflicts does not flag an account already In Use under my own owner', () => {
  const rows = [
    { owner: 'antonio@ortusclub.com', accounts: ['acc-1'] },
    { owner: 'marlon.j', accounts: ['acc-2'] },
  ];
  const conflicts = detectAccountConflicts(rows, ['acc-1', 'acc-2'], 'antonio@ortusclub.com');
  assert.deepEqual(conflicts, [{ account: 'acc-2', accountName: 'acc-2', heldBy: 'marlon.j' }]);
});

test('detectAccountConflicts owner match is case-insensitive', () => {
  const rows = [{ owner: 'Antonio@OrtusClub.com', accounts: ['acc-1'] }];
  assert.deepEqual(detectAccountConflicts(rows, ['acc-1'], 'antonio@ortusclub.com'), []);
});

test('detectAccountConflicts dedupes an account seen under multiple rows', () => {
  const rows = [
    { owner: 'marlon.j', accounts: ['acc-1'] },
    { owner: 'trixia.aguilera', accounts: ['acc-1'] },
  ];
  const conflicts = detectAccountConflicts(rows, ['acc-1']);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].heldBy, 'marlon.j'); // first row encountered wins
});

test('detectAccountConflicts falls back to the raw id when no accountName is known', () => {
  const rows = [{ owner: 'marlon.j', accounts: ['acc-1'] }];
  assert.deepEqual(detectAccountConflicts(rows, ['acc-1']), [
    { account: 'acc-1', accountName: 'acc-1', heldBy: 'marlon.j' },
  ]);
});

test('detectAccountConflicts handles empty/absent inputs', () => {
  assert.deepEqual(detectAccountConflicts([], []), []);
  assert.deepEqual(detectAccountConflicts(null, null), []);
  assert.deepEqual(detectAccountConflicts([{ owner: 'x', accounts: ['a'] }], []), []);
  assert.deepEqual(detectAccountConflicts([], ['a']), []);
});
