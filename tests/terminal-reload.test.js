import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTerminalStatus } from '../public/js/campaign-terminal.mjs';
import { vjCardControlsFor } from '../public/js/vjcard.mjs';
const stopped = { id: 'legacy-singleton', executionId: 'local-qa', running: false,
  state: 'idle', stopReason: 'operator-stopped', totalTargets: 2, totalProcessed: 0,
  logs: ['Stop requested', '=== Campaign ended ==='] };
test('cold local stopped snapshot normalizes without account cache or mutation', () => {
  assert.equal(normalizeTerminalStatus(stopped).state, 'done');
  assert.equal(stopped.state, 'idle');
  const c = vjCardControlsFor(stopped);
  assert.equal(c.stop, null); assert.equal(c.pause, null); assert.equal(c.bulk, null);
  assert.equal(c.restart, null);
  assert.equal(c.extra.filter((entry) => entry.kind === 'play').length, 1);
  assert.match(c.extra.find((entry) => entry.kind === 'play').onclick, /openCampaignContinuation/);
});
test('normalization preserves active, paused, monitoring, queued and recovery states', () => {
  for (const patch of [{ running: true }, { paused: true }, { pauseRequested: true },
    { state: 'monitoring' }, { state: 'needs_review' }, { state: 'waiting_daily_reset' },
    { queued: true }, { interrupted: true }, { monitoringCheckInProgress: true },
    { phase: 'preflight' }, { logs: [] }, { executionId: null }, { id: 'cloud-id' }, { _cloud: true }]) {
    const s = { ...stopped, ...patch }; assert.equal(normalizeTerminalStatus(s), s);
  }
});
