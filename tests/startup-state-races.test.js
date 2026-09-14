import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../src/campaign.js', import.meta.url), 'utf8');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

for (const control of ['pause', 'stop']) test(`${control} during preference loading survives actual startup initialization`, async () => {
  const prefs = deferred();
  const campaign = { _generation: 0 };
  const noop = () => {};
  const context = { campaign, AbortController, console, Date, Map, Set,
    startupAdmission: { assertCurrent: noop }, clearRuntimeInterruption: noop,
    startTaskOwner: () => ({ campaignId: 'new', campaignRunId: 'run' }),
    extractSheetGid: () => '', writeLastRun: noop, LAST_RUN_FILE: '', getOperatorPrefs: () => prefs.promise,
    setOperatorTz: noop, identityGateEnabled: () => false, clearSkips: noop, SINGLETON_CAMPAIGN_ID: 'singleton',
    emptyTally: () => ({}), clearFailures: noop, recordRuntimeInterruption: noop,
    clampCadenceMinutes: n => n, _resetSampleCache: noop,
    browserSemaphore: { _reset: noop, setMax: noop }, MAX_CONCURRENT_PROFILES: 3,
    campaignCounts: {}, campaignSendCounts: {}, campaignMessageCounts: {},
    normalizeTemplates: () => ({}), _ops: noop, log: noop,
    awaitUnpause: async () => { if (control === 'pause') assert.equal(campaign._pauseRequested, true); },
    clearRecentConnectionsTab: async () => { if (control === 'stop') assert.fail('Stop must precede sheet writes'); },
  };
  const start = source.indexOf('export async function startCampaign(');
  const end = source.indexOf('    rotateCampaignLogIfBig();', start);
  const run = vm.runInNewContext(source.slice(start, end).replace('export ', '') + '\n } finally {} }\nstartCampaign;', context);
  const pending = run({ createdBy: 'fixture', name: 'fresh', sheetUrl: 'fixture', profileIds: [] });
  assert.equal(campaign.name, 'fresh');
  const generation = campaign._generation;
  const receipt = { commandId: 'operator' };
  campaign._abortController.abort();
  if (control === 'pause') { campaign._pauseRequested = true; campaign._paused = true; campaign._pauseReceipt = receipt; }
  else { campaign._abort = true; campaign._stoppedManually = true; }
  prefs.resolve({}); await pending;
  assert.equal(campaign._generation, generation);
  assert.equal(campaign._abortController.signal.aborted, true);
  if (control === 'pause') assert.equal(campaign._pauseReceipt, receipt);
  else assert.equal(campaign._stoppedManually, true);
});

test('monitoring restore cannot overwrite a run that starts while disk read waits', async () => {
  const disk = deferred();
  const campaign = { _generation: 0, name: 'before' };
  const start = source.indexOf('export async function resumeMonitoringFromDisk()');
  const end = source.indexOf('\n/**', start);
  const restore = vm.runInNewContext(source.slice(start, end).replace('export ', '') + '\nresumeMonitoringFromDisk;', {
    campaign, readMonitoringState: () => disk.promise,
  });
  const pending = restore();
  Object.assign(campaign, { _generation: 1, running: true, name: 'new' });
  disk.resolve({ name: 'old', sheetUrl: 'old sheet' });
  assert.equal((await pending).reason, 'restore-superseded');
  assert.equal(campaign.name, 'new');
});
