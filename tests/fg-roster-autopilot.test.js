import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeAutopilotHandler } from '../services/fg-roster/autopilot.js';

const RUN_DAY = new Date('2026-08-01T06:00:00+01:00'); // London run day, 06:00
const cfg = () => ({
  enabled: true, days: [1, 15], keywords: ['marketing'],
  pairs: [{ operator: 'op@x', operatorName: 'Op', account: 'a@x.com', profileId: 'gl-1' }],
});

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

// Minimal searchService stub: buildFgTargets returns 2 rows.
const searchService = {
  buildFgTargets: () => ({
    rows: [
      ['Jane', 'https://linkedin.com/in/jane', '111', 'Acme', 'CMO', '', '', '', '', '', '', '', ''],
      ['John', 'https://linkedin.com/in/john', '222', 'Beta', 'CEO', '', '', '', '', '', '', '', ''],
    ],
    count: 2, matched: 2, eligible: 2,
  }),
};

function base(overrides = {}) {
  const runStore = overrides.runStore || memRunStore();
  return {
    searchService,
    startCloud: overrides.startCloud || (async () => ({ id: 'cloud-123' })),
    queueInvites: async () => {},
    runStore,
    loadConfig: overrides.loadConfig || (() => cfg()),
    saveRuns: () => {},
    sendAlert: overrides.sendAlert || (async () => ({ sent: true })),
    now: () => RUN_DAY.toISOString(),
    log: () => {},
    inviteUrl: 'https://linkedin.com/company/ortus',
    monthlyBudget: 30,
    tz: 'Europe/London',
    _now: RUN_DAY,
    ...overrides,
  };
}

test('fires on a run day: dispatches once + records with cycleKey', async () => {
  const runStore = memRunStore();
  let dispatched = 0;
  const h = makeAutopilotHandler(base({ runStore, startCloud: async () => { dispatched++; return { id: 'cloud-123' }; }, _now: RUN_DAY }));
  const r = await h.run({ nowDate: RUN_DAY });
  assert.equal(r.dispatched, true);
  assert.equal(r.cloudId, 'cloud-123');
  assert.equal(dispatched, 1);
  const rec = runStore._all().find((x) => x.cloudId === 'cloud-123');
  assert.equal(rec.cycleKey, '2026-08-01');
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

test('force ignores the gate and dispatches even off a run day', async () => {
  const OFF_DAY = new Date('2026-08-02T09:00:00+01:00');
  let dispatched = 0;
  const h = makeAutopilotHandler(base({ startCloud: async () => { dispatched++; return { id: 'm1' }; }, now: () => OFF_DAY.toISOString() }));
  const r = await h.run({ force: true, nowDate: OFF_DAY });
  assert.equal(r.dispatched, true);
  assert.equal(dispatched, 1);
  assert.match(r.cycleKey, /-manual-/);
});

test('dispatch failure → failed record + one alert', async () => {
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
