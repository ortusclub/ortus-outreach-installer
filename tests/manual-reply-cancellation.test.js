import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { startTaskOwner } from '../src/task-owner.js';
import { preparePrimarySession } from '../src/primary-session-control.js';
import { requestStandaloneStop, standaloneStopStatus } from '../src/standalone-stop-control.js';

const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const reply = source.slice(source.indexOf("app.post('/api/reply-check-now'"), source.indexOf("app.delete('/api/draft-name'"));
const stop = source.slice(source.indexOf("app.post('/api/bulk-check/stop'"), source.indexOf('// v2.72: Manual "Run reply check now"'));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; };
function harness() {
  const routes = new Map();
  const calls = { launches: 0, scans: 0, closes: 0, writes: 0, salesNav: 0, resumes: 0, permits: 0 };
  const context = {
    AbortController, structuredClone, Date, setTimeout, process: { env: {} },
    startTaskOwner, preparePrimarySession, requestStandaloneStop, standaloneStopStatus,
    _manualSweepRunning: false, _manualSweepControl: null, _manualSweepController: null, _manualSweepAbort: false,
    app: { post: (path, handler) => routes.set(path, handler) },
    campaign: { running: false, templates: {}, mode: 'message_only', name: 'fixture' },
    campaignLog() {}, setBulkCheckInProgress() {},
    getProfilePid: () => null, getProfiles: async () => [{ id: 'a', name: 'Account A' }, { id: 'b', name: 'Account B' }],
    fetchSheet: async () => [{ Sender: 'Account A', Message: 'sent' }, { Sender: 'Account B', Message: 'sent' }],
    browserSemaphore: { acquire: async () => { calls.permits++; }, release: () => { calls.permits--; } },
    launchProfile: async () => { calls.launches++; return { page: {} }; },
    resumeCampaign: async () => { calls.resumes++; return { ok: true }; },
    pauseCampaign() {},
    loadSalesNavConversations: async () => { calls.salesNav++; return { convs: [] }; },
    classifyConversations: () => ({ campaignReplies: [] }),
    dependencies: {
      scanRepliesForProfile: async () => { calls.scans++; return { inboundCount: 0, suspectedCount: 0, recentMessages: [], logEntries: [] }; },
      appendReplies: async () => { calls.writes++; }, writeRecentMessagesTab: async () => { calls.writes++; },
      closeProfile: async () => { calls.closes++; return { browserClosed: true }; },
    },
  };
  vm.runInNewContext((reply + stop).replace(/await import\('[^']+'\)/g, 'dependencies'), context);
  async function request(path, body = {}) {
    const result = { statusCode: 200 };
    await routes.get(path)({ body }, { status(code) { result.statusCode = code; return this; }, json(body) { result.body = body; } });
    return result;
  }
  return { context, calls, start: (body = { sheetUrl: 'fixture', profileIds: ['a', 'b'] }) => request('/api/reply-check-now', body),
    stop: () => request('/api/bulk-check/stop') };
}

test('normal reply check scans selected accounts and closes only its sessions', async () => {
  const h = harness();
  const result = await h.start();
  assert.equal(result.body.ok, true);
  assert.equal(h.calls.launches, 2);
  assert.equal(h.calls.scans, 2);
  assert.equal(h.calls.closes, 2);
  assert.equal(h.calls.permits, 0);
});

test('Stop during sheet read prevents all launches and overlapping checks', async () => {
  const h = harness(), entered = deferred(), wait = deferred();
  h.context.fetchSheet = async () => { entered.resolve(); return wait.promise; };
  const pending = h.start(); await entered.promise;
  assert.equal((await h.start()).statusCode, 409);
  await h.stop();
  assert.equal((await h.start()).statusCode, 409);
  wait.resolve([]);
  assert.equal((await pending).body.cancelled, true);
  assert.equal(h.calls.launches, 0);
});

test('Stop while waiting for a browser permit launches nothing', async () => {
  const h = harness(), entered = deferred();
  h.context.browserSemaphore.acquire = ({ signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    entered.resolve();
  });
  const pending = h.start(); await entered.promise;
  await h.stop();
  assert.equal((await pending).body.cancelled, true);
  await h.context._manualSweepControl._stopReceipt.done;
  assert.equal(h.calls.launches, 0);
  assert.equal(h.calls.closes, 0);
  assert.equal(h.calls.permits, 0);
});

test('Stop while awaiting campaign Pause never launches or auto-resumes', async () => {
  const h = harness(), entered = deferred(), wait = deferred();
  h.context.campaign.running = true;
  h.context.setTimeout = callback => { entered.resolve(); wait.promise.then(callback); };
  const pending = h.start(); await entered.promise;
  await h.stop(); wait.resolve();
  assert.equal((await pending).body.cancelled, true);
  assert.equal(h.calls.launches, 0);
  assert.equal(h.calls.resumes, 0);
});

test('Stop during late launch closes it without scanning and keeps ownership until proof', async () => {
  const h = harness(), entered = deferred(), wait = deferred();
  let signal;
  h.context.launchProfile = async (_id, _token, options) => { signal = options.signal; entered.resolve(); return wait.promise; };
  const pending = h.start(); await entered.promise;
  await h.stop();
  assert.equal(signal.aborted, true);
  assert.equal((await h.start()).statusCode, 409);
  wait.resolve({ page: {} });
  assert.equal((await pending).body.cancelled, true);
  await h.context._manualSweepControl._stopReceipt.done;
  assert.equal(h.calls.scans, 0);
  assert.equal(h.calls.closes, 1);
  assert.equal(h.calls.permits, 0);
});

test('Stop during inbox scan blocks writeback, Sales Nav and the next account', async () => {
  const h = harness(), entered = deferred(), wait = deferred();
  let signal;
  h.context.dependencies.scanRepliesForProfile = async options => { signal = options.signal; entered.resolve(); return wait.promise; };
  const pending = h.start(); await entered.promise;
  await h.stop();
  assert.equal(signal.aborted, true);
  wait.resolve({ inboundCount: 1, recentMessages: [], logEntries: [] });
  assert.equal((await pending).body.cancelled, true);
  await h.context._manualSweepControl._stopReceipt.done;
  assert.equal(h.calls.launches, 1);
  assert.equal(h.calls.writes, 0);
  assert.equal(h.calls.salesNav, 0);
});

test('busy browser is neither reused nor closed', async () => {
  const h = harness();
  h.context.getProfilePid = () => 123;
  const result = await h.start();
  assert.equal(result.body.perProfile.length, 2);
  assert.ok(result.body.perProfile.every(row => /ownership/.test(row.error)));
  assert.equal(h.calls.launches, 0);
  assert.equal(h.calls.closes, 0);
});

test('replacement remains blocked while automatic Resume cleanup is pending', async () => {
  const h = harness(), entered = deferred(), wait = deferred();
  h.context.campaign.running = true;
  h.context.pauseCampaign = () => { h.context.campaign._paused = true; h.context.campaign._pauseReceipt = {}; };
  h.context.resumeCampaign = async () => { entered.resolve(); await wait.promise; return { ok: true }; };
  const pending = h.start(); await entered.promise;
  assert.equal((await h.start()).statusCode, 409);
  wait.resolve(); await pending;
  assert.equal(h.context._manualSweepRunning, false);
});

test('Stop during cleanup replaces the pause authority before aborting the check', async () => {
  const h = harness(), entered = deferred(), wait = deferred();
  h.context.campaign.running = true;
  h.context.pauseCampaign = () => {
    h.context.campaign._paused = true; h.context.campaign._pauseRequested = true;
    h.context.campaign._pauseReceipt = {};
  };
  h.context.resumeCampaign = async ({ expectedPause }) => {
    entered.resolve(); await wait.promise;
    assert.notEqual(expectedPause, h.context.campaign._pauseReceipt);
    return { ok: false };
  };
  const pending = h.start(); await entered.promise;
  await h.stop(); wait.resolve(); await pending;
  await h.context._manualSweepControl._stopReceipt.done;
});

test('operator Resume endpoint blocks active and unconfirmed manual checks', async () => {
  const start = source.indexOf("app.post('/api/campaign/resume'");
  const end = source.indexOf('// ── v2.112:', start);
  for (const state of ['active', 'unconfirmed']) {
    let route, resumed = false;
    vm.runInNewContext(source.slice(start, end), {
      app: { post: (_path, handler) => { route = handler; } },
      _manualSweepRunning: state === 'active', _manualSweepControl: {},
      standaloneStopStatus: () => ({ stopping: state === 'unconfirmed' }),
      resumeCampaign: async () => { resumed = true; return { ok: true }; },
    });
    let code;
    await route({}, { status(value) { code = value; return this; }, json() {} });
    assert.equal(code, 409);
    assert.equal(resumed, false);
  }
});

test('unconfirmed normal close blocks another account, replacement and automatic Resume', async () => {
  const h = harness();
  h.context.campaign.running = true;
  h.context.pauseCampaign = () => { h.context.campaign._paused = true; h.context.campaign._pauseReceipt = {}; };
  let confirmed = false;
  h.context.dependencies.closeProfile = async () => ({ browserClosed: confirmed });
  const result = await h.start();
  assert.equal(result.body.cancelled, true);
  await h.context._manualSweepControl._stopReceipt.done;
  assert.equal(standaloneStopStatus(h.context._manualSweepControl).stopping, true);
  assert.equal((await h.start()).statusCode, 409);
  assert.equal(h.calls.launches, 1);
  assert.equal(h.calls.resumes, 0);
  // Recover the isolated mock session so this test leaves no active registry entry.
  confirmed = true;
  await h.stop();
  await h.context._manualSweepControl._stopReceipt.done;
  assert.equal(standaloneStopStatus(h.context._manualSweepControl).stopping, false);
});
