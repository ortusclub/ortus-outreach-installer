// A campaign monitoring on THIS Mac must keep the monitoring control set.
//
// Measured 2026-08-28: TEST_24/08_CC+IC_A was monitoring locally with 92 leads
// never sent. Its engine row still read status='stopping' from the stop that
// put it into monitoring in the first place, and `stopping` outranks
// `monitoring` in statusFromItem — so the card said "Stopping…", drew the
// sending controls, and offered no way to send the remaining 92.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statusFromItem, vjCardControlsFor } from '../public/js/vjcard.mjs';

const monitoringItem = (over = {}) => ({
  where: 'cloud', id: 'c1', runsOn: 'local', bucket: 'running',
  monitoring: true, monitoringPhase: true, engineStatus: 'monitoring',
  total: 123, sent: 31, pending: 92, ...over,
});

test('a locally-monitoring campaign is monitoring, not running', () => {
  const s = statusFromItem(monitoringItem());
  assert.equal(s.state, 'monitoring');
  assert.equal(s.running, false);
});

test('monitoring with leads left offers a choice of what resumes', () => {
  const c = vjCardControlsFor(statusFromItem(monitoringItem()));
  const go = (c.extra || []).find((e) => e.kind === 'play');
  assert.ok(go, 'expected a resume decision action');
  assert.equal(go.tip, 'Choose what resumes');
});

test('a scheduled self-resume still asks which independent phase to start', () => {
  const c = vjCardControlsFor(statusFromItem(monitoringItem({ resumeAt: '2026-08-28T12:28:00Z' })));
  const go = (c.extra || []).find((e) => e.kind === 'play');
  assert.equal(go.tip, 'Choose what resumes');
});

test('nothing left to send offers no resume', () => {
  const c = vjCardControlsFor(statusFromItem(monitoringItem({ pending: 0, sent: 123 })));
  assert.equal((c.extra || []).some((e) => e.kind === 'play'), false);
});

test('a stop actually in flight still reads as stopping', () => {
  // The flag is only overruled for a local runtime that reports monitoring;
  // a genuine stop must still say "Stopping…" while it lands.
  const s = statusFromItem(monitoringItem({ stopping: true, monitoring: false, monitoringPhase: false }));
  assert.equal(s.state, 'stopping');
});
