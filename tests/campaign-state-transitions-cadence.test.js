import { test } from 'node:test';
import assert from 'node:assert';
import { transitionToMonitoring } from '../src/campaign-state-transitions.js';

test('transitionToMonitoring uses campaign.checkIntervalMinutes for first nextCheckAt', () => {
  const campaign = {
    state: 'running',
    mode: 'connect_and_introduce',
    checkIntervalMinutes: 30,
    logs: [],
  };
  const now = new Date('2026-05-15T20:00:00.000Z');
  const next = transitionToMonitoring(campaign, {
    now,
    participatingProfileIds: ['p1'],
  });
  assert.equal(next.state, 'monitoring');
  assert.equal(new Date(next.nextCheckAt).toISOString(), '2026-05-15T20:30:00.000Z');
});

test('transitionToMonitoring defaults to 60 min when checkIntervalMinutes absent', () => {
  const campaign = {
    state: 'running',
    mode: 'connect_and_introduce',
    logs: [],
  };
  const now = new Date('2026-05-15T20:00:00.000Z');
  const next = transitionToMonitoring(campaign, {
    now,
    participatingProfileIds: ['p1'],
  });
  assert.equal(new Date(next.nextCheckAt).toISOString(), '2026-05-15T21:00:00.000Z');
});
