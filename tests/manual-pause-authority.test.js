import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { requestLocalPause, releaseLocalPause } from '../src/local-pause-control.js';
import { pausePrimaryTasksForOwner } from '../src/primary-task-control.js';
import { startTaskOwner } from '../src/task-owner.js';
import { standaloneStopStatus } from '../src/standalone-stop-control.js';
import { saveTasks, loadTasks, resumeTaskOwner, selectDue, isTaskOwnerSuspended } from '../src/primary-tasks.js';

const source = readFileSync(new URL('../src/campaign.js', import.meta.url), 'utf8');
const controls = source.slice(source.indexOf('export function pauseCampaign()'),
  source.indexOf('// v2.112: apply staged paused edits')).replaceAll('export ', '');
const owner = { campaignId: 'manual-pause-fixture', campaignRunId: 'run' };

for (const timing of ['before-release', 'after-durable-release']) {
  test(`new operator Pause keeps real queued work suspended: ${timing}`, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'ortus-pause-authority-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const file = join(dir, 'tasks.json');
    await saveTasks([{ ...owner, id: 'follow-up', type: 'follow-up', status: 'pending', dueAt: 0 }], file);
    const campaign = { running: true, templates: {}, _generation: 1, _abortController: new AbortController() };
    let releaseEntered, finishRelease;
    const entered = new Promise(resolve => { releaseEntered = resolve; });
    const unblock = new Promise(resolve => { finishRelease = resolve; });
    const context = {
      campaign, AbortController, setTimeout, log() {}, taskOwnerOf: () => owner,
      requestLocalPause: options => requestLocalPause(options, { pause: o => pausePrimaryTasksForOwner(o, { file }) }),
      releaseLocalPause: (receipt, current) => releaseLocalPause(receipt, current, {
        resume: async (o, commandId) => {
          if (timing === 'before-release') { releaseEntered(); await unblock; }
          const result = await resumeTaskOwner(o, commandId, file);
          if (timing === 'after-durable-release') { releaseEntered(); await unblock; }
          return result;
        },
      }),
    };
    const { pause, resume } = vm.runInNewContext(controls + '\n({ pause: pauseCampaign, resume: resumeCampaign });', context);
    pause();
    const original = campaign._pauseReceipt;
    await original.done;
    const pending = resume({ expectedPause: original });
    await entered;
    pause();
    const newer = campaign._pauseReceipt;
    await newer.done;
    finishRelease();
    assert.equal((await pending).ok, false);
    assert.equal(campaign._pauseReceipt, newer);
    assert.equal(campaign._paused, true);
    assert.equal(campaign._abortController.signal.aborted, true);
    assert.equal(await isTaskOwnerSuspended(owner, file), true);
    assert.equal(selectDue(await loadTasks(file), Date.now()).length, 0);
    assert.equal((await resume({ expectedPause: newer })).ok, true);
    assert.equal(selectDue(await loadTasks(file), Date.now()).length, 1);
  });
}

const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const replyRoute = server.slice(server.indexOf("app.post('/api/reply-check-now'"), server.indexOf("app.delete('/api/draft-name'"));
function replyHarness() {
  const campaign = { running: true, templates: {} };
  const captures = [];
  let route;
  const context = {
    AbortController, structuredClone, startTaskOwner, standaloneStopStatus,
    _manualSweepRunning: false, _manualSweepControl: null, _manualSweepController: null, _manualSweepAbort: false,
    setBulkCheckInProgress() {},
    campaign, process: { env: {} }, Date, setTimeout,
    app: { post: (_path, handler) => { route = handler; } },
    campaignLog() {}, dependencies: {}, getProfiles: async () => [], fetchSheet: async () => [],
    pauseCampaign: () => { campaign._paused = true; campaign._pauseReceipt = {}; },
    resumeCampaign: async options => { captures.push(options); return { ok: false }; },
  };
  vm.runInNewContext(replyRoute.replace(/await import\('[^']+'\)/g, 'dependencies'), context);
  async function request(body) {
    const result = { statusCode: 200 };
    await route({ body }, { status(code) { result.statusCode = code; return this; }, json(body) { result.body = body; } });
    return result;
  }
  return { context, campaign, captures, request };
}

test('reply-check cleanup uses its captured receipt when the operator pauses during sheet fetch', async () => {
  const h = replyHarness();
  let original;
  h.context.fetchSheet = async () => {
    original = h.campaign._pauseReceipt;
    h.campaign._pauseReceipt = {};
    return [];
  };
  assert.equal((await h.request({ sheetUrl: 'fixture' })).statusCode, 200);
  assert.equal(h.captures.length, 1);
  assert.equal(h.captures[0].expectedPause, original);
  assert.notEqual(h.captures[0].expectedPause, h.campaign._pauseReceipt);
});

test('invalid reply check never resumes work it did not pause', async () => {
  const h = replyHarness();
  assert.equal((await h.request({})).statusCode, 400);
  assert.equal(h.captures.length, 0);
});

test('reply check leaves a previously paused campaign paused', async () => {
  const h = replyHarness();
  h.campaign._paused = true;
  h.campaign._pauseReceipt = {};
  assert.equal((await h.request({ sheetUrl: 'fixture' })).statusCode, 200);
  assert.equal(h.captures.length, 0);
});
