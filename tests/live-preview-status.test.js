import test from 'node:test';
import assert from 'node:assert/strict';
import { previewStatus, countdown, previewSessionKey } from '../public/js/live-preview-status.mjs';
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

test('a maturing campaign says what it does next, in the words of the plan', () => {
  const now = Date.parse('2026-10-05T19:25:00Z');
  const config = { matureWarm: true, matureKind: 'warm', tz: 'Asia/Manila', dailySchedule: { startAt: '2026-10-05T18:30:00Z', amounts: [3, 6] } };
  const s = previewStatus({ campaign: { status: 'waiting_daily_reset', config, resumeTaskDueAt: '2026-10-07T01:00:00Z', matureAcceptPending: 3, matureAcceptDueAt: '2026-10-05T19:36:00Z' } }, 'x', now);
  assert.equal(s.step, 'Next: accept 3 connection requests in the receiving accounts');
  assert.equal(s.due, Date.parse('2026-10-05T19:36:00Z'));
  assert.equal(countdown(s.due, now), 'In 11m 00s');
  // Batch sent, day not closed yet: no "Campaign running" — the accepts are next.
  const resting = previewStatus({ campaign: { status: 'running', config }, monitorLog: [{ t: 2, line: '⏹ a@x — browser closed · 3 sent this turn (3/3 today) · rests ~3 min' }, { t: 1, line: '✓ a@x invited P · 1 of 8 this turn, 1/3 today' }] }, 'x', now);
  assert.match(resting.step, /^Next: the receiving accounts accept today's requests/);
  // Sleeping with nothing to accept: the next daily batch.
  const sleeping = previewStatus({ campaign: { status: 'waiting_daily_reset', config, resumeTaskDueAt: '2026-10-07T01:00:00Z' } }, 'x', now);
  assert.equal(sleeping.step, 'Next: 6 warm connections');
  assert.equal(sleeping.due, Date.parse('2026-10-07T01:00:00Z'));
  // Long waits read in hours, not hundreds of minutes.
  assert.equal(countdown(Date.parse('2026-10-07T01:00:00Z'), now), 'In 29h 35m');
});


test('acceptance preview identifies the recipient under the completed parent campaign', () => {
  const now=Date.now();
  const result=previewStatus({campaign:{name:'Pauline',status:'completed',config:{matureWarm:true},matureAcceptPending:2},live:true,liveProgress:{phase:'accepting',accountName:'Recipient Name',stepAt:now}},'Campaign',now);
  assert.equal(result.name,'Pauline');assert.equal(result.terminal,false);
  assert.match(result.step,/accepting connection requests on Recipient Name/);
  assert.equal(result.due,0);
});


test('mid-batch gap shows the engine timer, then loading without inventing a deadline', () => {
  const data = { campaign:{status:'running',config:{matureWarm:true}},live:true,
    liveProgress:{step:'between_profiles',nextProfileAt:61000} };
  const waiting = previewStatus(data, 'Brian', 1000);
  assert.equal(waiting.transition, true);
  assert.equal(waiting.due, 61000);
  assert.match(waiting.step,/Mid-batch.*waiting/);
  const loading = previewStatus(data, 'Brian', 62000);
  assert.match(loading.step,/loading the next profile/);
  assert.equal(loading.due,61000);
  const stopped = previewStatus({...data,campaign:{status:'cancelled'}},'Brian',1000);
  assert.equal(stopped.transition,undefined);
  const next = previewStatus({...data,liveProgress:{step:'opening_profile'}},'Brian',62000);
  assert.equal(next.transition,undefined);
});


test('preview session identity changes when accepting moves to another browser',()=>{
  const a={live:true,liveAccount:'a',liveStamp:{startedAt:100}};
  assert.notEqual(previewSessionKey(a),previewSessionKey({...a,liveAccount:'b'}));
  assert.notEqual(previewSessionKey(a),previewSessionKey({...a,liveStamp:{startedAt:200}}));
  assert.equal(previewSessionKey({...a,live:false}),'');
});
