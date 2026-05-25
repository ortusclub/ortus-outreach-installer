// Unit coverage for the CampaignRegistry — the Map-backed store that
// replaces the singleton `campaign` object in src/campaign.js. This task
// (Phase 1.1 of the parallel-campaigns refactor) only covers the data
// structure; runtime wiring lands in Phase 1.2.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CampaignRegistry } from '../src/campaign-registry.js';

test('register adds an entry and returns it', () => {
  const r = new CampaignRegistry();
  const c = r.register({ id: 'a', name: 'A' });
  assert.equal(c.id, 'a');
  assert.equal(c.name, 'A');
  assert.equal(r.get('a'), c);
  assert.equal(r.list().length, 1);
});

test('register without id throws', () => {
  const r = new CampaignRegistry();
  assert.throws(() => r.register({ name: 'no id' }), /id/i);
});

test('register with duplicate id throws (use update instead)', () => {
  const r = new CampaignRegistry();
  r.register({ id: 'a' });
  assert.throws(() => r.register({ id: 'a' }), /exists|duplicate/i);
});

test('get returns undefined for unknown id', () => {
  const r = new CampaignRegistry();
  assert.equal(r.get('missing'), undefined);
});

test('list with no filter returns all entries', () => {
  const r = new CampaignRegistry();
  r.register({ id: 'a', status: 'running' });
  r.register({ id: 'b', status: 'idle' });
  r.register({ id: 'c', status: 'paused' });
  assert.equal(r.list().length, 3);
});

test('list filters by status', () => {
  const r = new CampaignRegistry();
  r.register({ id: 'a', status: 'running' });
  r.register({ id: 'b', status: 'idle' });
  r.register({ id: 'c', status: 'running' });
  const running = r.list({ status: 'running' });
  assert.equal(running.length, 2);
  assert.ok(running.every((e) => e.status === 'running'));
});

test('update merges fields into existing entry', () => {
  const r = new CampaignRegistry();
  r.register({ id: 'a', status: 'idle', name: 'A' });
  r.update('a', { status: 'running', processedToday: 5 });
  const e = r.get('a');
  assert.equal(e.status, 'running');
  assert.equal(e.processedToday, 5);
  assert.equal(e.name, 'A'); // preserved
});

test('update on unknown id throws', () => {
  const r = new CampaignRegistry();
  assert.throws(() => r.update('missing', { status: 'running' }), /not found/i);
});

test('remove deletes by id and returns true', () => {
  const r = new CampaignRegistry();
  r.register({ id: 'a' });
  assert.equal(r.remove('a'), true);
  assert.equal(r.get('a'), undefined);
});

test('remove on unknown id returns false', () => {
  const r = new CampaignRegistry();
  assert.equal(r.remove('missing'), false);
});

test('runningIds returns Set of ids with status=running', () => {
  const r = new CampaignRegistry();
  r.register({ id: 'a', status: 'running' });
  r.register({ id: 'b', status: 'paused' });
  r.register({ id: 'c', status: 'running' });
  r.register({ id: 'd', status: 'idle' });
  const ids = r.runningIds();
  assert.ok(ids instanceof Set);
  assert.equal(ids.size, 2);
  assert.ok(ids.has('a'));
  assert.ok(ids.has('c'));
  assert.ok(!ids.has('b'));
  assert.ok(!ids.has('d'));
});

test('activeProfileIds returns union of profile ids across running campaigns', () => {
  // This is what account-lock.js (Phase 5) builds on. Monitoring and paused
  // campaigns count as active for the purposes of "is this account in use",
  // per spec §4.5 — monitoring exclusion is enforced in the lock helper
  // itself, not here.
  const r = new CampaignRegistry();
  r.register({ id: 'a', status: 'running', participatingProfileIds: ['p1', 'p2'] });
  r.register({ id: 'b', status: 'paused', participatingProfileIds: ['p2', 'p3'] });
  r.register({ id: 'c', status: 'idle', participatingProfileIds: ['p4'] });
  const ids = r.activeProfileIds();
  assert.ok(ids instanceof Set);
  assert.ok(ids.has('p1'));
  assert.ok(ids.has('p2'));
  assert.ok(ids.has('p3'));
  assert.ok(!ids.has('p4')); // idle is not active
});

test('empty registry: list, runningIds, activeProfileIds all return empty', () => {
  const r = new CampaignRegistry();
  assert.equal(r.list().length, 0);
  assert.equal(r.runningIds().size, 0);
  assert.equal(r.activeProfileIds().size, 0);
});
