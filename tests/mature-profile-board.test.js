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
    'Next: 3 warm connections · Attempt at Wed 7 Oct, 03:00 CEST');
  assert.equal(maturingNextAction({ ...it, dailyWait: true, resumeAt: '2026-10-09T01:00:00.000Z' }, opts),
    'Next: 6 warm connections · Attempt at Fri 9 Oct, 03:00 CEST');
  // A sleeping campaign reads as sleeping even if the browser flag lags behind.
  assert.equal(maturingRowState({ bucket: 'running', dailyWait: true, live: true }).label, 'Sleeping');
  assert.equal(maturingNextAction({ ...it, live: true }, opts), "Now: sending today's 3 warm connections");
  assert.equal(maturingNextAction(it, opts), "Next: today's 3 warm connections · Waiting for attempt time");
  assert.equal(maturingNextAction({ ...it, bucket: 'queued' }, opts), 'Next: 3 warm connections today · Waiting for attempt time');
  assert.equal(maturingNextAction({ ...it, matureKind: 'cold', bucket: 'queued', scheduledAt: '2026-10-12T07:00:00Z', warmSchedule: { startAt: '2026-10-12T07:00:00Z', amounts: [3, 5] } }, opts),
    'Next: 3 cold connections · Attempt at Mon 12 Oct, 09:00 CEST');
  // Right after the batch, the next thing is the receiving accounts accepting.
  assert.equal(maturingNextAction({ ...it, dailyWait: true, resumeAt: '2026-10-07T01:00:00.000Z', acceptPending: 3, acceptDueAt: '2026-10-05T19:40:00Z' }, opts),
    'Next: accept 3 connection requests in the receiving accounts · Attempt at Mon 5 Oct, 21:40 CEST');
  for (const ended of [{ bucket: 'done' }, { paused: true }, { needsReview: true }, { stopping: true }]) assert.equal(maturingNextAction({ ...it, ...ended }, opts), '');
});

import { maturingWaitLines } from '../public/js/mature-profile-board.mjs';
test('the log says it is looking for a VM worker, and keeps saying so every 15 seconds', () => {
  const due = Date.parse('2026-10-05T19:35:58Z');
  const it = { bucket: 'running', name: 'cat@x.io', matureKind: 'warm', dailyWait: true, acceptPending: 3, acceptDueAt: new Date(due).toISOString(), resumeAt: '2026-10-07T01:00:00Z' };
  assert.deepEqual(maturingWaitLines([it], due - 1000), []);                       // not due yet
  const first = maturingWaitLines([it], due + 5000);
  assert.equal(first.length, 1);
  assert.match(first[0].text, /^cat@x\.io · warm — 🔎 Looking for a VM worker to accept 3 connection requests in the receiving accounts\. This is usually about 2 minutes/);
  const later = maturingWaitLines([it], due + 47000);
  assert.deepEqual(later.map((l) => l.text.includes('Still looking')), [false, true, true, true]);
  assert.match(later.at(-1).text, /45s so far \(usually about 2 minutes\)/);
  assert.match(maturingWaitLines([it], due + 400000).at(-1).text, /6m 30s so far \(longer than usual/);
  // Once a browser is open the worker has been found: no more waiting lines.
  assert.deepEqual(maturingWaitLines([{ ...it, live: true }], due + 47000), []);
  // A daily batch that has fallen due waits for a worker the same way.
  assert.match(maturingWaitLines([{ ...it, acceptPending: 0 }], Date.parse('2026-10-07T01:00:20Z'))[0].text, /Looking for a VM worker to send today's warm connections/);
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
