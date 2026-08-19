import test from 'node:test';
import assert from 'node:assert/strict';
import { queueState } from '../public/js/queue-state.mjs';

const CAP = { queue: ['a', 'b', 'c'], active: 30, ceiling: 30, full: true };
const camp = (over = {}) => ({ id: 'a', status: 'queued', leadCount: 798, ...over });
const account = (over = {}) => ({ dailyCount: 0, dailyLimit: 50, parked: false, needsLogin: false, ...over });

test('a campaign that is not queued says nothing at all', () => {
  assert.equal(queueState(camp({ status: 'running' }), CAP), null);
  assert.equal(queueState(camp({ status: 'done' }), CAP), null);
});

test('first in line with room is the cold start, not a queue', () => {
  const s = queueState(camp(), { queue: ['a'], active: 2, ceiling: 30, full: false });
  assert.equal(s.kind, 'starting');
  assert.equal(s.badge, 'IN THE QUEUE');
  assert.match(s.line, /nothing ahead of you/);
  assert.match(s.note, /about two minutes/);
});

test('behind others, the position is the engine order read back', () => {
  const s = queueState(camp({ id: 'b' }), CAP);
  assert.equal(s.kind, 'queued');
  assert.equal(s.badge, '2ND IN LINE');
  assert.match(s.line, /<b>30 of 30<\/b> campaigns running/);
  assert.match(s.note, /1 campaign ahead of yours/);
});

test('the ordinal is right where English is irregular', () => {
  const q = (n) => queueState(camp({ id: 'x' }),
    { queue: [...Array(n - 1).fill(0).map((_, i) => `p${i}`), 'x'], active: 30, ceiling: 30, full: true }).badge;
  assert.equal(q(3), '3RD IN LINE');
  assert.equal(q(4), '4TH IN LINE');
  assert.equal(q(11), '11TH IN LINE', 'not 11ST');
  assert.equal(q(12), '12TH IN LINE');
  assert.equal(q(13), '13TH IN LINE');
  assert.equal(q(21), '21ST IN LINE');
});

test('first in line but the cloud is full is a queue wait, not a cold start', () => {
  // Nothing ahead of you, but no slot either — "waking a worker" would be a lie.
  const s = queueState(camp(), { queue: ['a'], active: 30, ceiling: 30, full: true });
  assert.equal(s.kind, 'queued');
  assert.equal(s.badge, 'NEXT IN LINE');
  assert.match(s.note, /Yours is next/);
});

test('NO ETA is ever produced for a queue wait', () => {
  // The whole point of facts-only. p50 5 min vs p90 2427 min supports no estimate.
  for (const id of ['a', 'b', 'c']) {
    const s = queueState(camp({ id }), CAP);
    assert.doesNotMatch(`${s.line} ${s.note}`, /~\s*\d|\bmin\b|minutes? away|starts in/i);
  }
});

test('every account blocked is the operator\'s problem, and says which', () => {
  const s = queueState(camp(), CAP, [
    account({ dailyCount: 50, dailyLimit: 50 }),
    account({ parked: true, parkReason: 'weekly cap' }),
    account({ parked: true }),
    account({ needsLogin: true }),
  ]);
  assert.equal(s.kind, 'accounts');
  assert.match(s.line, /<b>1<\/b> at the daily limit/);
  assert.match(s.line, /<b>2<\/b> parked/);
  assert.match(s.line, /<b>1<\/b> needing a login/);
  assert.match(s.note, /reset at midnight/);
});

test('one live account means it is waiting, not stuck', () => {
  // Three of four blocked is still a campaign that can send.
  const s = queueState(camp({ id: 'b' }), CAP, [
    account({ dailyCount: 50, dailyLimit: 50 }), account({ parked: true }),
    account({ needsLogin: true }), account(),
  ]);
  assert.equal(s.kind, 'queued');
});

test('an account block outranks the queue — it is true either way', () => {
  // Even 5th in line, if no account can send, that is the thing to fix.
  const s = queueState(camp({ id: 'c' }), CAP, [account({ parked: true })]);
  assert.equal(s.kind, 'accounts');
});

test('an unreadable capacity says nothing rather than guessing', () => {
  assert.equal(queueState(camp(), { queue: [], unavailable: true }), null);
  assert.equal(queueState(camp(), {}), null, 'no queue field at all');
  assert.equal(queueState(camp({ id: 'zzz' }), CAP), null, 'not in the queue we were given');
});

test('a campaign with no lead count drops the phrase, not the card', () => {
  const s = queueState({ id: 'a', status: 'queued' }, { queue: ['a'], active: 1, ceiling: 30 });
  assert.doesNotMatch(s.line, /waiting/);
  assert.equal(s.kind, 'starting');
});

test('lead counts are grouped so 1720 does not read as 172', () => {
  const s = queueState(camp({ leadCount: 1720 }), { queue: ['a'], active: 1, ceiling: 30 });
  assert.match(s.line, /1,720 leads/);
});
