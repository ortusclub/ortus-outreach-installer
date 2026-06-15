import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideLoginWaitAction } from '../src/campaign.js';

test('logged in → resume regardless of elapsed', () => {
  assert.equal(decideLoginWaitAction({ elapsedMs: 0, loggedIn: true, maxMs: 300000 }), 'resume');
  assert.equal(decideLoginWaitAction({ elapsedMs: 999999, loggedIn: true, maxMs: 300000 }), 'resume');
});

test('not logged in, before deadline → wait', () => {
  assert.equal(decideLoginWaitAction({ elapsedMs: 60000, loggedIn: false, maxMs: 300000 }), 'wait');
});

test('not logged in, at/after deadline → timeout', () => {
  assert.equal(decideLoginWaitAction({ elapsedMs: 300000, loggedIn: false, maxMs: 300000 }), 'timeout');
  assert.equal(decideLoginWaitAction({ elapsedMs: 300001, loggedIn: false, maxMs: 300000 }), 'timeout');
});
