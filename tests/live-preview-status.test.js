import test from 'node:test';
import assert from 'node:assert/strict';
import { previewStatus, countdown } from '../public/js/live-preview-status.mjs';
test('completed campaign overrides stale waiting activity and scheduled timestamps', () => {
  const m = previewStatus({campaign:{name:'Example',status:'done',blocked_until:'2099-01-01'},monitorLog:[{t:1,line:'Still waiting'}],liveProgress:{stepLabel:'Opening browser'}});
  assert.equal(m.step,'Campaign complete'); assert.equal(m.due,0); assert.equal(m.name,'Example'); assert.equal(m.terminal,true);
});
test('real future schedule produces countdown; absent schedule never invents one', () => {
  assert.equal(previewStatus({campaign:{status:'queued'}}).due,0);
  const now = Date.parse('2026-10-05T10:00:00Z');
  const m = previewStatus({campaign:{status:'sending',blocked_until:'2026-10-05T10:02:00Z'}},'Campaign',now);
  assert.equal(countdown(m.due,now),'In 2m 00s'); assert.equal(countdown(m.due,now+120000),'Due now · waiting for the engine');
});
test('activity is newest first and restricted to five records', () => {
  const m = previewStatus({monitorLog:Array.from({length:8},(_,t)=>({t,line:`Event ${t}`}))});
  assert.equal(m.logs.length,5); assert.equal(m.logs[0].line,'Event 7');
});

test('a maturing campaign with accepts pending shows accepting as the next action', () => {
  const now = Date.parse('2026-10-05T19:25:00Z');
  const s = previewStatus({ campaign: { status: 'waiting_daily_reset', resumeTaskDueAt: '2026-10-07T01:00:00Z', matureAcceptPending: 3, matureAcceptDueAt: '2026-10-05T19:36:00Z' } }, 'x', now);
  assert.equal(s.step, 'Next: accepting 3 connection requests');
  assert.equal(s.due, Date.parse('2026-10-05T19:36:00Z'));
  assert.equal(countdown(s.due, now), 'In 11m 00s');
  // Long waits read in hours, not hundreds of minutes.
  assert.equal(countdown(Date.parse('2026-10-07T01:00:00Z'), now), 'In 29h 35m');
});
