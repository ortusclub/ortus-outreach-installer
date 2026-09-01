// /api/campaign/status claimed runsOn:'local' for a placeholder holding no
// campaign at all. Read live out of the running app on 2026-09-01:
//
//   { "id": "legacy-singleton", "runsOn": "local", "state": "idle" }
//
// The live card polls this every 2 seconds and feeds it to _whSide, so a card
// showing a VM campaign lit up "This Mac". COLL_CHI_ANTONIO2 (e4f26bc2) was
// monitoring on the VM from 28 Aug to 1 Sep while the card said it was here,
// and Stop, trusting the same claim, went to the local singleton and did
// nothing. Twice.
//
// The rule: runsOn is an ANSWER, and an answer requires evidence. No campaign
// here means no answer, not "local".
import test from 'node:test';
import assert from 'node:assert';
import { getCampaignStatus, campaign } from '../src/campaign.js';

// Snapshot and restore, so this test can't leak into the rest of the suite.
const KEYS = ['running', 'state', 'name', 'runsOn', 'id'];
const saved = {};
for (const k of KEYS) saved[k] = campaign[k];
const reset = () => { for (const k of KEYS) campaign[k] = saved[k]; };

function statusWith(patch) {
  reset();
  Object.assign(campaign, patch);
  const s = getCampaignStatus();
  reset();
  return s;
}

test('THE BUG: an idle placeholder must not claim This Mac', () => {
  const s = statusWith({ running: false, state: 'idle', name: '', runsOn: null });
  assert.equal(s.id, 'legacy-singleton', 'this is the empty-placeholder shape');
  assert.notEqual(s.runsOn, 'local', 'the four-day lie');
  assert.ok(s.runsOn == null, `expected no answer, got ${JSON.stringify(s.runsOn)}`);
});

test('a campaign actually running here still says local', () => {
  assert.equal(statusWith({ running: true, state: 'running', name: 'X' }).runsOn, 'local');
});

test('a campaign monitoring here still says local', () => {
  assert.equal(statusWith({ running: false, state: 'monitoring', name: 'X' }).runsOn, 'local');
});

test('a finished local campaign keeps saying local — it did run here', () => {
  assert.equal(statusWith({ running: false, state: 'done', name: 'Finished run' }).runsOn, 'local');
});

test('an explicit runsOn always wins, in both directions', () => {
  assert.equal(statusWith({ running: false, state: 'idle', name: '', runsOn: 'vm' }).runsOn, 'vm');
  assert.equal(statusWith({ running: false, state: 'idle', name: '', runsOn: 'local' }).runsOn, 'local');
});

test('an interrupted run is local — the interruption happened on this Mac', () => {
  assert.equal(statusWith({ running: false, state: 'interrupted', name: 'X' }).runsOn, 'local');
});
