import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resumeMonitoringOnly } from '../src/monitoring-resume-command.js';
const now = Date.parse('2026-09-09T12:00:00Z');
function setup() {
  let current = { executionId: 'run-a', taskCampaignId: 'legacy-singleton', campaignRunId: 'owner-a',
    mode: 'connect_and_introduce', state: 'idle', running: false, sheetUrl: 'saved-sheet',
    participatingProfileIds: ['sender'], sendingEndedAt: '2026-09-08T12:00:00Z',
    monitoringUntil: '2026-09-15T12:00:00Z', checkIntervalMinutes: 60, _generation: 1, _controlRevision: 2 };
  const events = [];
  return { events, change: patch => { current = { ...current, ...patch }; },
    deps: { snapshot: () => ({ ...current }), now: () => now,
      confirmShutdown: async () => { events.push('shutdown'); return { ok: true }; },
      commit: () => events.push('persist'), activate: candidate => { events.push('activate'); current = candidate; } } };
}
test('shutdown and durable commit precede monitoring activation; sending is not resumed', async () => {
  const f = setup();
  const r = await resumeMonitoringOnly({ executionId: 'run-a' }, f.deps);
  assert.deepEqual(f.events, ['shutdown', 'persist', 'activate']);
  assert.equal(r.sendingResumed, false); assert.equal(f.deps.snapshot().running, false);
});
test('Stop or new execution during shutdown wins without persistence or activation', async () => {
  for (const change of [{ _controlRevision: 3 }, { _generation: 2 }, { executionId: 'other' }]) {
    const f = setup();
    f.deps.confirmShutdown = async () => { f.change(change); return { ok: true }; };
    await assert.rejects(resumeMonitoringOnly({ executionId: 'run-a' }, f.deps), /newer control/);
    assert.deepEqual(f.events, []);
  }
});
test('shutdown and persistence failures never start a watcher', async () => {
  const f = setup(); f.deps.confirmShutdown = async () => ({ ok: false });
  await assert.rejects(resumeMonitoringOnly({ executionId: 'run-a' }, f.deps), /shutdown/);
  assert.deepEqual(f.events, []);
  const g = setup(); g.deps.commit = () => { throw new Error('disk full'); };
  await assert.rejects(resumeMonitoringOnly({ executionId: 'run-a' }, g.deps), /disk full/);
  assert.deepEqual(g.events, ['shutdown']);
});
test('already-active monitoring does not stop, write, activate or shift its timer', async () => {
  const f = setup(); f.change({ state: 'monitoring', nextCheckAt: '2026-09-09T12:40:00Z', autoChecksEnabled: true });
  const r = await resumeMonitoringOnly({ executionId: 'run-a' }, f.deps);
  assert.equal(r.alreadyActive, true); assert.equal(r.nextCheckAt, '2026-09-09T12:40:00Z');
  assert.deepEqual(f.events, []);
});
