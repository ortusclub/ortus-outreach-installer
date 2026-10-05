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
