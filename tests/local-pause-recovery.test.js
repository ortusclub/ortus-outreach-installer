import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { releaseLocalPause } from '../src/local-pause-control.js';

const source = readFileSync(new URL('../src/campaign.js', import.meta.url), 'utf8');
test('retention never erases an unresolved remote outcome', async () => {
  const start = source.indexOf('async function loadState()');
  const end = source.indexOf('async function saveState(', start);
  const state = { processed: {
    unknown: { action: 'interrupted', date: '2020-01-01' },
    crashed: { action: '_in_progress', date: '2020-01-01' },
    completed: { action: 'connection_sent', date: '2020-01-01' },
  } };
  const load = vm.runInNewContext(source.slice(start, end) + '\nloadState;', {
    readJson: async () => state, STATE_FILE: 'fixture', STATE_RETENTION_DAYS: 60, console: { log() {} },
  });
  await load();
  assert.ok(state.processed.unknown);
  assert.ok(state.processed.crashed);
  assert.equal(state.processed.completed, undefined);
});

test('actual Resume leaves pause flags and controller intact when a newer Stop wins', async () => {
  const start = source.indexOf('export async function resumeCampaign(');
  const end = source.indexOf('// v2.112: apply staged paused edits', start);
  const controller = new AbortController(); controller.abort();
  const receipt = { confirmed: true, owner: { campaignId: 'fixture', campaignRunId: 'run' }, commandId: 'pause' };
  const campaign = { running: true, _paused: true, _pauseRequested: true, _pauseReceipt: receipt, _abortController: controller, _generation: 1 };
  const resume = vm.runInNewContext(source.slice(start, end).replace('export ', '') + '\nresumeCampaign;', {
    campaign, AbortController, log() {}, _applyPendingResume: () => assert.fail('must not apply changes'),
    releaseLocalPause: (r, current) => releaseLocalPause(r, current, { resume: async () => { campaign._abort = true; return true; } }),
  });
  assert.equal((await resume({ applyPending: true })).ok, false);
  assert.equal(campaign._pauseRequested, true);
  assert.equal(campaign._abortController, controller);
});

test('every standard campaign holds unknown rows before creating a new in-progress marker', () => {
  const held = source.indexOf("if (state.processed[url]?.action === 'interrupted')");
  const dispatch = source.indexOf("state.processed[url] = { ...taskOwner", held);
  assert.ok(held > 0 && dispatch > held);
  assert.match(source.slice(held, dispatch), /continue;/);
  assert.doesNotMatch(source.slice(source.indexOf('const stalePending'), source.indexOf('// v2.14.x: Resume support')), /delete state.processed/);
});

test('confirmed Resume replaces the aborted controller and preserves completed progress', async () => {
  const start = source.indexOf('export async function resumeCampaign(');
  const end = source.indexOf('// v2.112: apply staged paused edits', start);
  const controller = new AbortController(); controller.abort();
  const campaign = { running: true, _paused: true, _pauseRequested: true,
    _pauseReceipt: { confirmed: true, owner: {}, commandId: 'pause' }, _abortController: controller, _generation: 1,
    successCount: 7 };
  let applied = 0;
  const resume = vm.runInNewContext(source.slice(start, end).replace('export ', '') + '\nresumeCampaign;', {
    campaign, AbortController, log() {}, _applyPendingResume: () => { applied++; },
    releaseLocalPause: (r, current) => releaseLocalPause(r, current, { resume: async () => true }),
  });
  assert.equal((await resume({ applyPending: true })).ok, true);
  assert.equal(campaign._abortController.signal.aborted, false);
  assert.equal(campaign._pauseRequested, false);
  assert.equal(campaign._paused, false);
  assert.equal(campaign.successCount, 7);
  assert.equal(applied, 1);
});
