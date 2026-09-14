import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { requestLocalPause } from '../src/local-pause-control.js';

const source = fs.readFileSync(new URL('../src/campaign.js', import.meta.url), 'utf8');
const start = source.indexOf('export function pauseCampaign()');
const end = source.indexOf('export async function resumeCampaign(', start);
assert.ok(start >= 0 && end > start);
function fixture() {
  const campaign = { running: true, templates: { primaryName: 'fixture primary' },
    _abortController: new AbortController() };
  const logs = [];
  const pause = vm.runInNewContext(source.slice(start, end).replace('export ', '') + '\npauseCampaign;', {
    campaign, log: line => logs.push(line), setTimeout,
    taskOwnerOf: () => ({ campaignId: 'fixture', campaignRunId: 'run' }),
    requestLocalPause: options => requestLocalPause(options, { pause: async () => ({ stopped: true, commandId: 'fixture-pause' }) }),
  });
  return { campaign, pause, logs };
}

test('existing Pause snapshots settings independently and keeps progress intact', () => {
  const { campaign, pause } = fixture();
  campaign.successCount = 4;
  pause();
  campaign.templates.primaryName = 'edited primary';
  assert.equal(campaign._pauseSnapshot.templates.primaryName, 'fixture primary');
  assert.equal(campaign.successCount, 4);
  assert.equal(campaign._pauseRequested, true);
});

test('existing Pause does not falsely mark itself already paused', () => {
  const { campaign, pause } = fixture();
  pause();
  assert.notEqual(campaign._paused, true);
});

test('Pause immediately aborts its captured controller without promising to finish the lead', () => {
  const { campaign, pause, logs } = fixture();
  pause();
  assert.equal(campaign._abortController.signal.aborted, true);
  assert.ok(!logs.some(line => /after current lead completes/i.test(line)),
    'Pause still explicitly defers interruption until the lead completes');
});
