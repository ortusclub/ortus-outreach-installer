import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');

test('a newer authoritative lead result advances the top banner beyond stale browser progress', () => {
  assert.match(app, /if \(d\) d\._leads = leads;/);
  assert.match(app, /normLead\(l\.fullName\) === normLead\(who\)/);
  assert.match(app, /Latest verified event/);
  assert.match(app, /sent and confirmed/);
  assert.match(app, /\['Sheet', ok \? 'result stamped' : 'error stamped', 'done'\]/);
});

test('a completed monitoring sweep returns to the idle monitoring banner', () => {
  assert.match(app, /const sweepDisposition = monitorSweepDisposition\(status \|\| \{\}\);/);
  assert.match(app, /phase === 'monitoring' && sweepDisposition === 'idle'/);
  assert.match(app, /label: 'Waiting for the next acceptance check'/);
  assert.match(app, /who: ca\.label, l1: ca\.label/);
  assert.match(app, /phase === 'monitoring' && \(transientCheckEvent \|\| durableSweepIdle\)/);
  assert.match(app, /status\.state === 'monitoring' \|\| status\.monitoring \|\| status\.monitoringPhase/);
  assert.match(app, /\|\| \(monitoringIdle \? 'monitoring' : ''\)\s*\|\| \(la && la\.phase\)/);
  assert.match(app, /campaignRow\.monitor_check_status \|\| campaignRow\.monitorCheckStatus/);
  assert.match(app, /const durableSweepCompleted = durableSweepStatus === 'completed';/);
  assert.match(app, /const lp = durableSweepCompleted \? null : \(d && d\.liveProgress\);/);
});
