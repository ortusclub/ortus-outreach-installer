import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parkProfile } from '../src/campaign.js';

test('parkProfile calls page.goto(about:blank) with 5s timeout and domcontentloaded', async () => {
  const calls = [];
  const page = {
    goto: async (url, opts) => { calls.push({ url, opts }); },
    isClosed: () => false,
  };
  await parkProfile(page, 'about:blank');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'about:blank');
  assert.equal(calls[0].opts.timeout, 5000);
  assert.equal(calls[0].opts.waitUntil, 'domcontentloaded');
});

test('parkProfile swallows goto errors (D-10 / D-11)', async () => {
  const page = {
    goto: async () => { throw new Error('boom'); },
    isClosed: () => false,
  };
  await assert.doesNotReject(parkProfile(page, 'about:blank'));
});

test('parkProfile is a no-op if page is closed', async () => {
  let called = false;
  const page = {
    goto: async () => { called = true; },
    isClosed: () => true,
  };
  await parkProfile(page, 'about:blank');
  assert.equal(called, false);
});

test('parkProfile is a no-op if page is null/undefined', async () => {
  await assert.doesNotReject(parkProfile(null, 'about:blank'));
  await assert.doesNotReject(parkProfile(undefined, 'about:blank'));
});
