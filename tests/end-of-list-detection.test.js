import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isEndOfList } from '../src/end-of-list.js';

test('isEndOfList: all queues empty + no in-flight → true', () => {
  const state = {
    queuesByProfile: { p1: [], p2: [] },
    inFlight: new Set(),
    connectionSentCount: { p1: 3, p2: 2 },
  };
  assert.equal(isEndOfList(state), true);
});

test('isEndOfList: non-empty queue → false', () => {
  const state = {
    queuesByProfile: { p1: [], p2: ['lead-x'] },
    inFlight: new Set(),
    connectionSentCount: { p1: 1, p2: 0 },
  };
  assert.equal(isEndOfList(state), false);
});

test('isEndOfList: in-flight request → false', () => {
  const state = {
    queuesByProfile: { p1: [], p2: [] },
    inFlight: new Set(['p1:lead-x']),
    connectionSentCount: { p1: 1, p2: 1 },
  };
  assert.equal(isEndOfList(state), false);
});

test('isEndOfList: zero connection_sent across all accounts → false (campaign never really started sending)', () => {
  const state = {
    queuesByProfile: { p1: [], p2: [] },
    inFlight: new Set(),
    connectionSentCount: { p1: 0, p2: 0 },
  };
  assert.equal(isEndOfList(state), false);
});

test('isEndOfList: at least one connection_sent + queues empty + no in-flight → true', () => {
  const state = {
    queuesByProfile: { p1: [], p2: [] },
    inFlight: new Set(),
    connectionSentCount: { p1: 0, p2: 1 },
  };
  assert.equal(isEndOfList(state), true);
});
