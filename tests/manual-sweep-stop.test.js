import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { taskOwnerOf } from '../src/task-owner.js';
import { startTaskOwner } from '../src/task-owner.js';
import { preparePrimarySession } from '../src/primary-session-control.js';
import { requestStandaloneStop, standaloneStopStatus } from '../src/standalone-stop-control.js';

const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const routeSource = source.slice(source.indexOf("app.post('/api/bulk-check-now'"),
  source.indexOf('// v2.72: Manual "Run reply check now"'));
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};
function harness(overrides = {}) {
  const routes = new Map();
  const calls = { launches: 0, checks: 0, sends: 0, closes: 0, resumes: 0 };
  const context = {
    AbortController, structuredClone, setTimeout, Date, taskOwnerOf, process: { env: {} },
    startTaskOwner, preparePrimarySession, requestStandaloneStop, standaloneStopStatus,
    browserSemaphore: { acquire: async () => {}, release() {} },
    app: { post: (path, handler) => routes.set(path, handler) },
    campaign: { running: false, templates: {}, mode: '' },
    campaignLog() {}, setBulkCheckInProgress() {}, forceCloseActiveBulkChecks() {},
    addActiveBulkCheck() {}, removeActiveBulkCheck() {}, getProfilePid: () => null,
    getProfiles: async () => [], pauseCampaign() {}, preemptCurrentLead: () => false,
    resumeCampaign: () => calls.resumes++,
    launchProfile: async () => { calls.launches++; return { page: {} }; },
    dependencies: {
      bulkCheckConnections: async () => { calls.checks++; return { connectedUrls: ['lead'] }; },
      runAutoIntros: async () => calls.sends++, runAutoDms: async () => calls.sends++,
      closeProfile: async () => { calls.closes++; return { browserClosed: true }; },
    },
    ...overrides,
  };
  // Execute the real route bodies with external dependencies replaced; never
  // import the live server, launch a browser, access a sheet, or send a message.
  vm.runInNewContext(`let _manualSweepRunning = false;
    let _manualSweepAbort = false; let _manualSweepController = null; let _manualSweepControl = null;
    ${routeSource.replace(/await import\('[^']+'\)/g, 'dependencies')}
    globalThis.getManualControl = () => _manualSweepControl;`, context);
  async function request(path, body = {}) {
    const result = { statusCode: 200 };
    const res = { status(code) { result.statusCode = code; return this; },
      json(body) { result.body = body; return this; } };
    await routes.get(path)({ body }, res);
    return result;
  }
  return { calls, context, request };
}
const body = { explicitCheckContext: true, sheetUrl: 'test-sheet',
  profileIds: ['test-account'], mode: 'connect_and_message', ccDmBody: 'test' };
const start = '/api/bulk-check-now';
const stop = '/api/bulk-check/stop';

test('stop during a late launch blocks replacement until cleanup; no check or send', async () => {
  const entered = deferred(), launch = deferred();
  let signal;
  const h = harness({ launchProfile: async (_id, _token, options) => {
    signal = options.signal; entered.resolve(); return launch.promise;
  } });
  const pending = h.request(start, body);
  await entered.promise;
  assert.equal((await h.request(stop)).body.stopping, true);
  assert.equal(signal.aborted, true);
  assert.equal((await h.request(start, body)).statusCode, 409);
  launch.resolve({ page: {} });
  await pending;
  assert.equal(h.calls.checks, 0);
  assert.equal(h.calls.sends, 0);
  assert.equal(h.calls.closes, 1);
  await h.context.getManualControl()._stopReceipt.done;
  assert.equal((await h.request(start, body)).statusCode, 200);
  assert.equal(h.calls.checks, 1);
});

test('stop during acceptance read prevents the follow-on message pass', async () => {
  const entered = deferred(), read = deferred();
  const h = harness();
  h.context.dependencies.bulkCheckConnections = async () => {
    entered.resolve(); return read.promise;
  };
  const pending = h.request(start, body);
  await entered.promise;
  await h.request(stop);
  read.resolve({ connectedUrls: ['lead'] });
  await pending;
  assert.equal(h.calls.sends, 0);
  assert.equal(h.calls.closes, 1);
});

test('unacknowledged pause refuses the check instead of sharing campaign browsers', async () => {
  let now = 0;
  const h = harness({ campaign: { running: true, templates: {} },
    Date: { now: () => (now += 31000) } });
  const result = await h.request(start, body);
  assert.equal(result.statusCode, 503);
  assert.equal(h.calls.launches, 0);
});

test('stop while awaiting pause never auto-resumes the campaign', async () => {
  const entered = deferred(), wait = deferred();
  const h = harness({ campaign: { running: true, templates: {} },
    setTimeout: (callback) => { entered.resolve(); wait.promise.then(callback); } });
  const pending = h.request(start, body);
  await entered.promise;
  await h.request(stop);
  wait.resolve();
  await pending;
  assert.equal(h.calls.launches, 0);
  assert.equal(h.calls.resumes, 0);
});

test('normal check still runs the intended post-acceptance message pass', async () => {
  const h = harness();
  assert.equal((await h.request(start, body)).statusCode, 200);
  assert.equal(h.calls.checks, 1);
  assert.equal(h.calls.sends, 1);
  assert.equal(h.calls.closes, 1);
});
