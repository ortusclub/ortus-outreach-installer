import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeAutopilotHandler } from '../services/fg-roster/autopilot.js';
import { FG_LIST_HEADER } from '../src/connections/fg-list.js';

const RUN_DAY = new Date('2026-08-01T06:00:00+01:00'); // London run day, 06:00
const cfg = () => ({
  enabled: true, days: [1, 15], keywords: ['marketing'],
  pairs: [{ operator: 'op@x', operatorName: 'Op', account: 'a@x.com', profileId: 'gl-1' }],
  publishedBy: 'owner@x.com',
});

// A pre-generated invite-list tab (header + 2 rows) for account a@x.com == gl-1.
const listRows = () => [
  FG_LIST_HEADER,
  ['Jane', 'Doe', 'https://linkedin.com/in/jane', 'CMO', 'Acme', 'a@x.com', '', '', '', '111'],
  ['John', 'Roe', 'https://linkedin.com/in/john', 'CEO', 'Beta', 'a@x.com', '', '', '', '222'],
];

function memRunStore(initial = []) {
  let runs = [...initial];
  return {
    load: () => runs,
    save: (r) => { runs = r; },
    add: (run) => { runs.push(run); },
    update: (cloudId, patch) => {
      const i = runs.findIndex((r) => r.cloudId === cloudId);
      if (i < 0) return false; runs[i] = { ...runs[i], ...patch }; return true;
    },
    _all: () => runs,
  };
}

function base(overrides = {}) {
  const runStore = overrides.runStore || memRunStore();
  return {
    startCloud: overrides.startCloud || (async () => ({ id: 'cloud-123' })),
    readList: overrides.readList || (async () => listRows()),
    runStore,
    loadConfig: overrides.loadConfig || (() => cfg()),
    saveRuns: () => {},
    sendAlert: overrides.sendAlert || (async () => ({ sent: true })),
    now: () => RUN_DAY.toISOString(),
    log: () => {},
    inviteUrl: 'https://linkedin.com/company/ortus',
    monthlyBudget: 30,
    tz: 'Europe/London',
    ...overrides,
  };
}

test('run day with a generated list: reads the tab, dispatches once, records cycleKey + tab', async () => {
  const runStore = memRunStore();
  let payload = null;
  const h = makeAutopilotHandler(base({ runStore, startCloud: async (p) => { payload = p; return { id: 'cloud-123' }; } }));
  const r = await h.run({ nowDate: RUN_DAY });
  assert.equal(r.dispatched, true);
  assert.equal(r.cloudId, 'cloud-123');
  assert.equal(r.tab, 'FG 2026-08-01');
  // Dispatched follower_growth with 2 leads, each pinned to its account.
  assert.equal(payload.mode, 'follower_growth');
  assert.equal(payload.leads.length, 2);
  assert.equal(payload.leads[0].routeAccount, 'gl-1');
  const rec = runStore._all().find((x) => x.cloudId === 'cloud-123');
  assert.equal(rec.cycleKey, '2026-08-01');
  assert.equal(rec.tab, 'FG 2026-08-01');
  assert.equal(rec.listDriven, true);
});

test('no list generated for the run → skip (no-list) + alert, no dispatch', async () => {
  let dispatched = 0; let alerts = 0;
  const h = makeAutopilotHandler(base({
    readList: async () => [],              // empty tab
    startCloud: async () => { dispatched++; return { id: 'x' }; },
    sendAlert: async () => { alerts++; return { sent: true }; },
  }));
  const r = await h.run({ nowDate: RUN_DAY });
  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'no-list');
  assert.equal(r.tab, 'FG 2026-08-01');
  assert.equal(dispatched, 0);
  assert.equal(alerts, 1);
});

test('does not fire twice for the same cycle', async () => {
  const runStore = memRunStore([{ cloudId: 'old', cycleKey: '2026-08-01', status: 'dispatched' }]);
  let dispatched = 0;
  const h = makeAutopilotHandler(base({ runStore, startCloud: async () => { dispatched++; return { id: 'x' }; } }));
  const r = await h.run({ nowDate: RUN_DAY });
  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'already-ran');
  assert.equal(dispatched, 0);
});

test('disabled config → skip, no dispatch', async () => {
  let dispatched = 0;
  const h = makeAutopilotHandler(base({ loadConfig: () => ({ ...cfg(), enabled: false }), startCloud: async () => { dispatched++; return { id: 'x' }; } }));
  const r = await h.run({ nowDate: RUN_DAY });
  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'disabled');
  assert.equal(dispatched, 0);
});

test('force off a run day → reads the upcoming run tab and dispatches (manual cycleKey)', async () => {
  const OFF_DAY = new Date('2026-08-02T09:00:00+01:00');
  let dispatched = 0; let readTab = null;
  const h = makeAutopilotHandler(base({
    startCloud: async () => { dispatched++; return { id: 'm1' }; },
    readList: async (tab) => { readTab = tab; return listRows(); },
    now: () => OFF_DAY.toISOString(),
  }));
  const r = await h.run({ force: true, nowDate: OFF_DAY });
  assert.equal(r.dispatched, true);
  assert.equal(dispatched, 1);
  assert.match(r.cycleKey, /-manual-/);
  assert.equal(readTab, 'FG 2026-08-15'); // next scheduled run after Aug 2
});

test('dispatch error (engine returns {error}) → failed record + one alert', async () => {
  const runStore = memRunStore();
  let alerts = 0;
  const h = makeAutopilotHandler(base({
    runStore,
    startCloud: async () => ({ error: 'engine down' }),
    sendAlert: async () => { alerts++; return { sent: true }; },
  }));
  const r = await h.run({ nowDate: RUN_DAY });
  assert.equal(r.failed, true);
  assert.match(r.error, /engine down/);
  assert.equal(alerts, 1);
  assert.equal(runStore._all().some((x) => x.status === 'failed' && x.cycleKey === '2026-08-01'), true);
});

test('force + empty pairs → skip, no dispatch (never reads a tab)', async () => {
  let dispatched = 0; let read = 0;
  const h = makeAutopilotHandler(base({
    loadConfig: () => ({ ...cfg(), pairs: [] }),
    readList: async () => { read++; return listRows(); },
    startCloud: async () => { dispatched++; return { id: 'cloud-123' }; },
  }));
  const r = await h.run({ force: true, nowDate: RUN_DAY });
  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'no-pairs');
  assert.equal(dispatched, 0);
  assert.equal(read, 0);
});

test('sendAlert throwing does not mask dispatch failure', async () => {
  const runStore = memRunStore();
  const h = makeAutopilotHandler(base({
    runStore,
    startCloud: async () => ({ error: 'engine down' }),
    sendAlert: async () => { throw new Error('smtp down'); },
  }));
  const r = await h.run({ nowDate: RUN_DAY });
  assert.equal(r.failed, true);
  assert.match(r.error, /engine down/);
  assert.equal(runStore._all().some((x) => x.status === 'failed' && x.cycleKey === '2026-08-01'), true);
});

test('list with only unknown accounts → benign skip (no-usable-rows), no alert, no failed record', async () => {
  const runStore = memRunStore();
  let alerts = 0; let dispatched = 0;
  const h = makeAutopilotHandler(base({
    runStore,
    readList: async () => [FG_LIST_HEADER, ['X', 'Y', 'https://li/x', 'r', 'c', 'nobody@x.com', '', '', '', '']],
    startCloud: async () => { dispatched++; return { id: 'cloud-123' }; },
    sendAlert: async () => { alerts++; return { sent: true }; },
  }));
  const r = await h.run({ nowDate: RUN_DAY });
  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'no-usable-rows');
  assert.equal(dispatched, 0);
  assert.equal(alerts, 0);
  assert.equal(runStore._all().some((x) => x.status === 'failed'), false);
});

test('startCloud exception → failed record + one alert (dispatchFromRows never throws out)', async () => {
  const runStore = memRunStore();
  let alerts = 0;
  const h = makeAutopilotHandler(base({
    runStore,
    startCloud: async () => { throw new Error('boom'); },
    sendAlert: async () => { alerts++; return { sent: true }; },
  }));
  const r = await h.run({ nowDate: RUN_DAY });
  assert.equal(r.failed, true);
  assert.match(r.error, /boom/);
  assert.equal(alerts, 1);
  assert.equal(runStore._all().some((x) => x.status === 'failed' && x.cycleKey === '2026-08-01'), true);
});

test('read error (Apps Script down) → failed record + alert', async () => {
  const runStore = memRunStore();
  let alerts = 0;
  const h = makeAutopilotHandler(base({
    runStore,
    readList: async () => { throw new Error('fg script 500'); },
    sendAlert: async () => { alerts++; return { sent: true }; },
  }));
  const r = await h.run({ nowDate: RUN_DAY });
  assert.equal(r.failed, true);
  assert.match(r.error, /fg script 500/);
  assert.equal(alerts, 1);
});
