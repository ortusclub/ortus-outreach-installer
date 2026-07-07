import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateTeamStatus, bucketForCloudStatus } from '../src/team-status.js';

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
  assert.deepEqual(rows[0], { owner: 'a@ortusclub.com', running: 1, queued: 0, done: 1, sent: 42 });
  assert.deepEqual(rows[1], { owner: 'b@ortusclub.com', running: 0, queued: 1, done: 0, sent: 0 });
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
  assert.deepEqual(rows[0], { owner: '(unknown)', running: 1, queued: 0, done: 2, sent: 5 });
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
