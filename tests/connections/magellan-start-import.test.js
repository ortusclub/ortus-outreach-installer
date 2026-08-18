import test from 'node:test';
import assert from 'node:assert/strict';
import { startImport, getState, reset } from '../../src/connections/magellan-run.js';

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const noSheet = async () => ({ written: true });

const onePlan = () => ([{
  account: 'a@ortus.solutions',
  plan: { creates: [{ properties: { email: 'x@linkedinmembership.id' } }], updates: [], additionalEmails: [] },
}]);

test('refuses with a reason when there is no preview, and starts nothing', () => {
  reset();
  const r = startImport(null, { sheet: noSheet });
  assert.equal(r.ok, false);
  assert.match(r.reason, /preview/i);
  assert.equal(getState().running, false);
});

test('returns before the write finishes, and marks the run running', async () => {
  reset();
  let released;
  const slow = new Promise((r) => { released = r; });

  const r = startImport(onePlan(), {
    // Hangs until the test lets go — if startImport awaited the write, the
    // assertion below could not run at all.
    create: async () => { await slow; return { created: 1, errors: [], ids: new Map() }; },
    update: async () => ({ updated: 0, errors: [] }),
    sheet: noSheet,
  });

  assert.deepEqual(r, { ok: true, started: true });
  assert.equal(getState().running, true, 'the run is already marked running when the call returns');
  assert.equal(getState().phase, 'importing');

  released();
  await settle(60);
  assert.equal(getState().running, false);
});

test('a second press while one is in flight is refused, not queued', async () => {
  reset();
  let released;
  const slow = new Promise((r) => { released = r; });
  const deps = {
    create: async () => { await slow; return { created: 1, errors: [], ids: new Map() }; },
    update: async () => ({ updated: 0, errors: [] }),
    sheet: noSheet,
  };

  assert.equal(startImport(onePlan(), deps).ok, true);
  const second = startImport(onePlan(), deps);
  assert.equal(second.ok, false);
  assert.match(second.reason, /already running/i);

  released();
  await settle(60);
});

test('the outcome lands on the polled state, which is how the card reads it', async () => {
  reset();
  startImport(onePlan(), {
    create: async () => ({ created: 1, errors: [], ids: new Map() }),
    update: async () => ({ updated: 0, errors: [] }),
    sheet: noSheet,
  });
  await settle(80);

  const s = getState();
  assert.equal(s.running, false);
  assert.equal(s.phase, 'done');
  assert.ok(s.imported, 'state.imported carries the result the request no longer returns');
  assert.equal(s.imported.created, 1);
});
