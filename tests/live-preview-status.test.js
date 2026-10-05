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
