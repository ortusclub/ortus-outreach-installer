import test from 'node:test';
import assert from 'node:assert/strict';
import { splitMaturingCampaigns } from '../public/js/mature-profile-board.mjs';
test('maturing runs are separate without duplicating or moving drafts',()=>{
  const items=[{id:'regular',mode:'connect_only',bucket:'running'},{id:'mature',mode:'mature_profile',bucket:'running'},{id:'draft',mode:'mature_profile',bucket:'draft'},{id:'saved',mode:'mature_profile',bucket:'saved'},{id:'paused',mode:'mature_profile',bucket:'running',paused:true}];
  const {regular,maturing}=splitMaturingCampaigns(items);
  assert.deepEqual(regular.map(x=>x.id),['regular','draft','saved']);assert.deepEqual(maturing.map(x=>x.id),['mature','paused']);
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
