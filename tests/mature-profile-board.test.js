import test from 'node:test';
import assert from 'node:assert/strict';
import { splitMaturingCampaigns } from '../public/js/mature-profile-board.mjs';
test('everything maturing — runs, drafts and saved plans — sits in its own section, once',()=>{
  const items=[{id:'regular',mode:'connect_only',bucket:'running'},{id:'mature',mode:'mature_profile',bucket:'running'},{id:'draft',mode:'mature_profile',bucket:'draft'},{id:'saved',mode:'mature_profile',bucket:'saved'},{id:'paused',mode:'mature_profile',bucket:'running',paused:true}];
  const {regular,maturing}=splitMaturingCampaigns(items);
  assert.deepEqual(regular.map(x=>x.id),['regular']);assert.deepEqual(maturing.map(x=>x.id),['mature','draft','saved','paused']);
  assert.equal(new Set([...regular,...maturing].map(x=>x.id)).size,items.length);
});

import { maturingStatus } from '../public/js/mature-profile-board.mjs';
const schedule = { startDate: '2026-10-05', amounts: [3, 3, 5, 0] };
test('a running warm stage reports its day, today\'s amount and pool progress', () => {
  const s = maturingStatus({ schedule, today: '2026-10-06', sentToday: 2, sent: 5, total: 40 });
  assert.equal(s.text, 'Day 2 of 3 · 2 of 3 warm connections sent today · 5 tomorrow · 5 of 40 pool accounts invited');
  assert.equal(s.todayLimit, 3);
});
test('the last plan day says so, and after it the plan is complete', () => {
  assert.match(maturingStatus({ schedule, today: '2026-10-07', sent: 8, total: 40 }).text, /^Day 3 of 3 · up to 5 warm connections today · last day of the plan/);
  const over = maturingStatus({ schedule, today: '2026-10-20', sent: 11, total: 40 });
  assert.equal(over.finished, true);
  assert.match(over.text, /^Plan complete after 3 days/);
});
test('an open-ended plan has no day count and keeps its last amount', () => {
  const s = maturingStatus({ schedule: { startDate: '2026-10-05', amounts: [3, 15] }, today: '2026-11-05', sent: 1, total: 9 });
  assert.equal(s.text, 'Day 32 · up to 15 warm connections today · same amount tomorrow · 1 of 9 pool accounts invited');
});
test('an exhausted pool wins over the plan', () => {
  assert.equal(maturingStatus({ schedule, today: '2026-10-06', sent: 40, total: 40 }).text, 'Every account in the pool has been invited');
});
test('a campaign without a schedule has no maturing status', () => {
  assert.equal(maturingStatus({ schedule: null, today: '2026-10-06' }), null);
});

test('a cold stage is described as cold connections to leads', () => {
  const s = maturingStatus({ kind: 'cold', schedule: { startDate: '2026-10-12', amounts: [5, 5, 0] }, today: '2026-10-12', sentToday: 1, sent: 1, total: 300 });
  assert.equal(s.text, 'Day 1 of 2 · 1 of 5 cold connections sent today · same amount tomorrow · 1 of 300 leads invited');
});

import { mergeMaturingLogs } from '../public/js/mature-profile-board.mjs';
test('the maturing log merges every campaign in time order, tagged by account and stage', () => {
  const lines = mergeMaturingLogs([
    { name: 'ana@ortus.solutions', kind: 'warm', log: [{ t: 10, line: 'sent 3' }, { t: 30, line: '😴 Sleeping' }] },
    { name: 'ana@ortus.solutions · Cold', kind: 'cold', log: [{ t: 20, line: 'scheduled' }] },
    { name: 'ben@klabber.co', kind: 'warm', log: [{ t: 25, line: 'sent 3' }, { line: '' }] },
  ]);
  assert.deepEqual(lines.map(l => l.text), [
    'ana@ortus.solutions · warm — sent 3',
    'ana@ortus.solutions · cold — scheduled',
    'ben@klabber.co · warm — sent 3',
    'ana@ortus.solutions · warm — 😴 Sleeping',
  ]);
  assert.equal(mergeMaturingLogs([{ name: 'a', log: Array.from({ length: 90 }, (_, t) => ({ t, line: `l${t}` })) }], 60).length, 60);
});

test('a schedule with startAt counts plan days in the campaign time zone, like the engine', () => {
  // Started 02:13 on 6 Oct in Manila (18:13 UTC on the 5th).
  const s = { startAt: '2026-10-05T18:13:00Z', startDate: '2026-10-06', amounts: [3, 6, 10] };
  const at = (now) => maturingStatus({ schedule: s, timeZone: 'Asia/Manila', now: Date.parse(now), today: now.slice(0, 10), sent: 0, total: 9 });
  assert.equal(at('2026-10-05T18:30:00Z').day, 1);   // still 6 Oct in Manila
  assert.equal(at('2026-10-07T01:00:00Z').day, 2);   // 09:00 Manila on the 7th — the next batch
  assert.equal(at('2026-10-07T01:00:00Z').todayLimit, 6);
});

import { maturingRowState } from '../public/js/mature-profile-board.mjs';
test('each maturing campaign reads as one plain state, green only while connecting', () => {
  const state = (it) => maturingRowState({ bucket: 'running', ...it });
  assert.deepEqual(state({ live: true, liveProgress: {phase:'sending',stepAt:Date.now()} }), { label: 'Active', tone: 'green' });
  assert.deepEqual(state({ dailyWait: true }), { label: 'Sleeping', tone: 'amber' });
  assert.deepEqual(state({}), { label: 'Awaiting its turn', tone: 'amber' });
  assert.equal(state({ paused: true, live: true }).label, 'Paused');
  assert.equal(state({ bucket: 'done', bad: true }).label, 'Stopped');
  assert.equal(state({ bucket: 'done' }).label, 'Finished');
  assert.equal(state({ bucket: 'queued', scheduledAt: '2026-10-12' }).label, 'Scheduled');
  assert.equal(state({ needsReview: true, live: true }).label, 'Needs attention');
});

import { groupMaturingAccounts } from '../public/js/mature-profile-board.mjs';
test('an account shows as one entry with its warm and cold counts', () => {
  const groups = groupMaturingAccounts([
    { id: 'w', name: 'ana@ortus.solutions', matureKind: 'warm', bucket: 'running', dailyWait: true, sent: 6 },
    { id: 'c', name: 'ana@ortus.solutions · Cold', matureKind: 'cold', bucket: 'queued', scheduledAt: '2026-10-12', sent: 0 },
    { id: 'b', name: 'ben@klabber.co', matureKind: 'warm', bucket: 'running', live: true, liveProgress: {phase:'sending',stepAt:Date.now()}, sent: 2 },
  ]);
  assert.equal(groups.length, 2);
  assert.deepEqual([groups[0].name, groups[0].state.label, groups[0].warmSent, groups[0].coldSent], ['ana@ortus.solutions', 'Sleeping', 6, 0]);
  assert.deepEqual([groups[1].state.label, groups[1].warmSent, groups[1].coldSent], ['Active', 2, null]);
});

import { maturingNextAction } from '../public/js/mature-profile-board.mjs';
test('each maturing account says what it does next and when', () => {
  const schedule = { startAt: '2026-10-05T18:30:00Z', amounts: [3, 3, 3, 6] };
  const it = { bucket: 'running', matureKind: 'warm', matureTz: 'Asia/Manila', warmSchedule: schedule };
  const opts = { now: Date.parse('2026-10-05T19:30:00Z'), viewerTimeZone: 'Europe/Rome' };
  // Sleeping: the engine's next batch time, and that day's amount.
  assert.equal(maturingNextAction({ ...it, dailyWait: true, resumeAt: '2026-10-07T01:00:00.000Z' }, opts),
    'Next: 3 warm connections · Earliest start Wed 7 Oct, 03:00 CEST');
  assert.equal(maturingNextAction({ ...it, dailyWait: true, resumeAt: '2026-10-09T01:00:00.000Z' }, opts),
    'Next: 6 warm connections · Earliest start Fri 9 Oct, 03:00 CEST');
  // A sleeping campaign reads as sleeping even if the browser flag lags behind.
  assert.equal(maturingRowState({ bucket: 'running', dailyWait: true, live: true }).label, 'Sleeping');
  assert.equal(maturingNextAction({ ...it, live: true }, opts), "Now: sending today's 3 warm connections");
  assert.equal(maturingNextAction(it, opts), "Next: today's 3 warm connections · Waiting for attempt time");
  assert.equal(maturingNextAction({ ...it, bucket: 'queued' }, opts), 'Next: 3 warm connections today · Waiting for attempt time');
  assert.equal(maturingNextAction({ ...it, matureKind: 'cold', bucket: 'queued', scheduledAt: '2026-10-12T07:00:00Z', warmSchedule: { startAt: '2026-10-12T07:00:00Z', amounts: [3, 5] } }, opts),
    'Next: 3 cold connections · Earliest start Mon 12 Oct, 09:00 CEST');
  // Right after the batch, the next thing is the receiving accounts accepting.
  assert.equal(maturingNextAction({ ...it, dailyWait: true, resumeAt: '2026-10-07T01:00:00.000Z', acceptPending: 3, acceptDueAt: '2026-10-05T19:40:00Z' }, opts),
    'Next: accept 3 connection requests in the receiving accounts · Earliest start Mon 5 Oct, 21:40 CEST');
  for (const ended of [{ bucket: 'done' }, { paused: true }, { needsReview: true }, { stopping: true }]) assert.equal(maturingNextAction({ ...it, ...ended }, opts), '');
});

import { maturingWaitLines } from '../public/js/mature-profile-board.mjs';
test('due starts, daily batches and acceptance waits log every 30 seconds', () => {
  const due = Date.parse('2026-10-05T19:35:58Z');
  for (const details of [
    {bucket:'queued', startedAt:due},
    {bucket:'queued', scheduledAt:new Date(due).toISOString()},
    {bucket:'running', dailyWait:true, resumeAt:new Date(due).toISOString()},
    {bucket:'running', acceptPending:3, acceptDueAt:new Date(due).toISOString()},
  ]) {
    const it={name:'cat@x.io',matureKind:'warm',...details};
    assert.deepEqual(maturingWaitLines([it],due-1),[]);
    const lines=maturingWaitLines([it],due+65000);
    assert.deepEqual(lines.map(l=>l.t-due),[0,30000,60000]);
    assert.match(lines[0].text,/Waiting for a worker/);
    assert.match(lines[2].text,/1m 00s elapsed/);
    assert.match(maturingNextAction(it,{now:due+65000}),/Waiting for a worker.*1m 05s elapsed/);
    assert.deepEqual(maturingWaitLines([{...it,live:true}],due+65000),[]);
    assert.deepEqual(maturingWaitLines([{...it,paused:true}],due+65000),[]);
    assert.deepEqual(maturingWaitLines([{...it,accountBlocks:[{reason:'throttle',until:new Date(due+3600000).toISOString()}]}],due+65000),[]);
    assert.ok(maturingWaitLines([it],due+86400000).length<=12);
  }
});

import { logClock } from '../public/js/mature-profile-board.mjs';
test('every log line can carry its time of day', () => {
  assert.equal(logClock(Date.parse('2026-10-05T19:20:58Z'), 'Europe/Rome'), '21:20:58');
  assert.equal(logClock(0), '');
});

import { retainMaturingLog } from '../public/js/mature-profile-board.mjs';
test('shared history retains earlier accounts when another account starts and deduplicates polling', () => {
  const first = { t: 1, text: 'Pauline · start — Saving the plan…' };
  const second = { t: 3, text: 'Riccardo · start — Saving the plan…' };
  let history = retainMaturingLog([], [first]);
  history = retainMaturingLog(history, [second]);
  history = retainMaturingLog(history, [second, { t: 2, text: 'Pauline · warm — Browser ready' }]);
  assert.deepEqual(history.map(x => x.t), [1, 2, 3]);
  assert.deepEqual(retainMaturingLog(history, []), history);
  assert.deepEqual(retainMaturingLog([], JSON.parse(JSON.stringify(history))), history);
});
test('same-time events from separate accounts remain and history is bounded', () => {
  const lines = [{ t: 1, text: 'A · warm — Ready' }, { t: 1, text: 'B · warm — Ready' }];
  assert.equal(retainMaturingLog([], lines).length, 2);
  assert.deepEqual(retainMaturingLog(lines, [{ t: 2, text: 'C · start' }], 2), [lines[1], { t: 2, text: 'C · start' }]);
  assert.deepEqual(retainMaturingLog([], [null, {}, { t: 'bad', text: 'bad' }]), []);
});

test('reported acceptance activity marks its parent maturing campaign active during daily sleep', () => {
  const it = {name:'Pauline',bucket:'running',dailyWait:true,live:true,liveProgress:{phase:'accepting',stepAt:Date.now()}};
  assert.equal(maturingRowState(it).label,'Active');
  assert.equal(maturingNextAction(it),'Now: accepting connection requests');
  assert.equal(maturingRowState({...it,liveProgress:null}).label,'Sleeping');
});

test('weekly block outranks a future cold stage and displays the actual Monday retry', () => {
  const until = '2099-10-12T00:00:00Z';
  const warm = { name: 'Eryca', matureKind: 'warm', bucket: 'running', live: true,
    accountBlocks: [{ reason: 'weekly', until }] };
  const cold = { name: 'Eryca', matureKind: 'cold', bucket: 'queued', scheduledAt: '2099-10-13T09:00:00Z' };
  assert.equal(maturingRowState(warm).label, 'Weekly limit · paused');
  assert.equal(groupMaturingAccounts([warm, cold])[0].state.label, 'Weekly limit · paused');
  assert.match(maturingNextAction(warm, { viewerTimeZone: 'Europe/Rome' }), /Weekly limit reached · Retry .*12 Oct, 02:00/);
  const suspected = {...warm, accountBlocks: [{ reason: 'weekly_suspected', until }]};
  assert.match(maturingNextAction(suspected), /^Possible weekly limit/);
  assert.deepEqual(maturingWaitLines([{...warm, dailyWait:true, resumeAt:'2000-01-01'}]), []);
  assert.doesNotMatch(maturingNextAction({...warm, accountBlocks:[{reason:'weekly',until:'2000-01-01'}]}), /Weekly limit/);
});

test('finished warm sends show acceptance next even while the browser-open flag lingers', () => {
  const warm = {matureKind:'warm',bucket:'running',live:true,batchDoneToday:true};
  assert.match(maturingNextAction(warm), /^Next: the receiving accounts accept/);
  assert.equal(maturingRowState(warm).label, 'Waiting for acceptance');
  const pending = {...warm,acceptPending:3,acceptDueAt:'2099-10-06T16:15:00Z'};
  assert.match(maturingNextAction(pending), /^Next: accept 3 connection requests/);
  assert.equal(maturingRowState(pending).label, 'Waiting for acceptance');
  assert.doesNotMatch(maturingNextAction({...warm,matureKind:'cold'}), /accept/);
  assert.match(maturingNextAction({...warm,dailyWait:true,resumeAt:'2099-10-07T07:00:00Z'}), /next|Next/);
});

test('running campaigns still waiting for their first worker report the queue every 30 seconds', () => {
  const t = Date.parse('2026-10-07T14:20:16Z');
  const item = {name:'Amit',bucket:'running',engineStatus:'running',startedAt:t,log:[{t,line:'📦 Campaign received by the engine — waiting for a VM worker to pick it up…'}]};
  const lines = maturingWaitLines([item],t+61000);
  assert.match(lines.at(-1).text,/Still waiting for a worker/);
  assert.equal(lines.at(-1).t,t+60000);
});
test('quiet running stages repeat the last real activity without inventing progress', () => {
  const t = Date.parse('2026-10-07T14:22:00Z');
  const item = {name:'Amit',bucket:'running',engineStatus:'running',log:[{t,line:'Checking login…'},{t:t-30000,line:'Opening browser'}]};
  assert.equal(maturingWaitLines([item],t+29000).length,0);
  const lines = maturingWaitLines([item],t+61000);
  assert.equal(lines.length,1);
  assert.match(lines[0].text,/Status check: engine reports running.*1m 00s ago: Checking login/);
  for (const override of [{paused:true},{stopping:true},{needsReview:true},{dailyWait:true},{bucket:'done'}]) {
    assert.equal(maturingWaitLines([{...item,...override}],t+61000).length,0);
  }
  assert.equal(maturingWaitLines([{...item,log:[{t:t+60000,line:'Sending invitation'}]}],t+61000).length,0);
});

test('future daily runs stay quiet, but active between-batch rests receive updates', () => {
  const now = Date.parse('2026-10-07T14:00:00Z');
  const base = {name:'Amit',bucket:'running',engineStatus:'running',log:[{t:now-60000,line:'Browser closed · rests ~3 min before its next turn'}]};
  assert.match(maturingWaitLines([base],now)[0].text,/rests ~3 min/);
  assert.deepEqual(maturingWaitLines([{...base,dailyWait:true,resumeAt:'2026-10-08T07:00:00Z'}],now),[]);
  assert.deepEqual(maturingWaitLines([{...base,bucket:'queued',engineStatus:'scheduled',scheduledAt:'2026-10-08T07:00:00Z'}],now),[]);
});

test('completed daily target stays quiet during final cooldown even before engine status changes', () => {
 const now=Date.parse('2026-10-07T14:48:00Z');
 const item={name:'Amit',bucket:'running',engineStatus:'running',live:false,log:[{t:now-150000,line:'⏹ browser closed · 3 sent this turn (10/10 today) · rests ~3 min before its next turn'}]};
 assert.deepEqual(maturingWaitLines([item],now),[]);
 assert.match(maturingWaitLines([{...item,log:[{...item.log[0],line:'browser closed · 3 sent this turn (6/10 today) · rests ~3 min before its next turn'}]}],now)[0].text,/Status check/);
 assert.match(maturingWaitLines([{...item,acceptPending:3,acceptDueAt:new Date(now-60000).toISOString()}],now).at(-1).text,/accept 3 connection requests/);
 assert.deepEqual(maturingWaitLines([{...item,acceptPending:3,acceptDueAt:new Date(now+60000).toISOString()}],now),[]);
});
