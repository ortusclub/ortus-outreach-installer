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

test('mirrors manual FG: caps at monthly budget + skips already-invited + writes Queued', async () => {
  // Regression: autopilot used to pass budget:Infinity + alreadyInvited:[] + a no-op
  // queue — dispatching EVERY matched connection (~15k), re-inviting done people, and
  // never writing the sheet. It must match /api/fg/team-launch/start exactly.
  let seenBudget, seenInvited;
  const spy = { buildFgTargets: (_c, opts) => { seenBudget = opts.budget; seenInvited = opts.alreadyInvited; return { rows: [['J', 'u', '1', '', '', '', '', '', '', '', '', '', '']], count: 1, matched: 1, eligible: 1 }; } };
  let queuedRows = null;
  const h = makeAutopilotHandler(base({
    searchService: spy, monthlyBudget: 30,
    getFgState: async () => ({ invites: [{ 'Member ID': '999', Status: 'Invited' }, { 'LinkedIn URL': 'https://x/y', Status: 'Invited' }] }),
    queueInvites: async (rows) => { queuedRows = rows; },
  }));
  await h.run({ force: true, nowDate: RUN_DAY });
  assert.equal(seenBudget, 30, `budget should be 30, got ${seenBudget}`);
  assert.deepEqual(seenInvited, ['999', 'https://x/y'], `alreadyInvited should come from the FG sheet, got ${JSON.stringify(seenInvited)}`);
  assert.ok(Array.isArray(queuedRows) && queuedRows.length === 1, 'queueInvites must receive the dispatched rows (Queued write-back)');
});

test('FG sheet unreachable → still runs, just does not skip already-invited', async () => {
  let seenInvited = 'unset';
  const spy = { buildFgTargets: (_c, opts) => { seenInvited = opts.alreadyInvited; return { rows: [['J', 'u', '1', '', '', '', '', '', '', '', '', '', '']], count: 1, matched: 1, eligible: 1 }; } };
  const h = makeAutopilotHandler(base({ searchService: spy, getFgState: async () => { throw new Error('sheet down'); } }));
  const r = await h.run({ force: true, nowDate: RUN_DAY });
  assert.equal(r.dispatched, true, 'a sheet hiccup must not block the run');
  assert.deepEqual(seenInvited, [], 'falls back to [] when the sheet is unreadable');
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

test('force + empty pairs → skip, no dispatch', async () => {
  let dispatched = 0;
  const h = makeAutopilotHandler(base({
    loadConfig: () => ({ ...cfg(), pairs: [] }),
    startCloud: async () => { dispatched++; return { id: 'cloud-123' }; },
  }));
  const r = await h.run({ force: true, nowDate: RUN_DAY });
  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'no-pairs');
  assert.equal(dispatched, 0);
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

test('no eligible targets → benign skip, no alert, no failed record', async () => {
  const runStore = memRunStore();
  let alerts = 0;
  let dispatched = 0;
  const emptySearchService = { buildFgTargets: () => ({ rows: [], count: 0, matched: 0, eligible: 0 }) };
  const h = makeAutopilotHandler(base({
    runStore,
    searchService: emptySearchService,
    startCloud: async () => { dispatched++; return { id: 'cloud-123' }; },
    sendAlert: async () => { alerts++; return { sent: true }; },
  }));
  const r = await h.run({ nowDate: RUN_DAY });
  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'no-eligible-targets');
  assert.equal(dispatched, 0);
  assert.equal(alerts, 0);
  assert.equal(runStore._all().some((x) => x.status === 'failed'), false);
});

test('startCloud exception → failed record + one alert', async () => {
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
