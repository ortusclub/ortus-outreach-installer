import test from 'node:test';
import assert from 'node:assert/strict';
import {warmPreset,warmRampErrors,warmDailyAmount,warmSchedule} from '../public/js/mature-warm-ramp.mjs';
test('gentle ramp changes only on interval boundaries and respects ceiling and stop',()=>{
 const r=warmPreset('gentle');assert.equal(warmDailyAmount(r,1),3);assert.equal(warmDailyAmount(r,3),3);assert.equal(warmDailyAmount(r,4),5);assert.equal(warmDailyAmount(r,28),15);assert.equal(warmDailyAmount(r,29),0);
});
test('duration and fixed-date stops include the final day, including month rollover',()=>{
 const r=warmPreset('moderate');r.stopAfterDays=3;const s=warmSchedule(r,'2026-10-30');assert.equal(s.endDate,'2026-11-01');assert.equal(s.rows.length,3);
 r.stopMode='date';r.stopDate='2026-11-02';assert.equal(warmSchedule(r,'2026-10-30').rows.length,4);
 r.stopDate='2026-10-01';assert.equal(warmSchedule(r,'2026-10-30').rows.length,0);
});
test('no stop continues at cap and invalid parameters cannot produce a schedule',()=>{
 const r=warmPreset('aggressive');r.stopMode='none';assert.equal(warmDailyAmount(r,100),50);assert.equal(warmSchedule(r,'2026-10-05').endDate,null);
 r.everyDays=0;assert.ok(warmRampErrors(r).length);assert.equal(warmSchedule(r,'2026-10-05').rows.length,0);
 r.everyDays=3;r.stopMode='date';r.stopDate='2026-02-31';assert.ok(warmRampErrors(r).length);
});
