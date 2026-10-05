import test from 'node:test';
import assert from 'node:assert/strict';
import { newMaturePlan, restoreMaturePlan, maturePlanErrors, matureStageForDay } from '../public/js/mature-profile-plan.mjs';
test('new plans require operator limits and begin with warm connections only',()=>{
  const p=newMaturePlan();assert.equal(p.stages[0].coldDaily,0);assert.equal(p.stages[0].likesDaily,0);assert.ok(maturePlanErrors(p).length);
  assert.equal(matureStageForDay(p,1).id,'warm');assert.equal(matureStageForDay(p,8).id,'cold');assert.equal(matureStageForDay(p,15).id,'engage');
});
test('round trip retains pools, account starts and limits without shared references',()=>{
  const p=newMaturePlan();p.warmPool='Team';p.accounts.a={startDate:'2026-10-06'};p.stages[0].warmDaily=3;
  const restored=restoreMaturePlan(JSON.parse(JSON.stringify(p)));assert.deepEqual(restored,p);
  restored.accounts.a.startDate='2026-11-01';assert.equal(p.accounts.a.startDate,'2026-10-06');
  assert.deepEqual(restoreMaturePlan(null).accounts,{});
});
test('reject overlaps, negative limits and missing sources',()=>{
  const p=newMaturePlan();for(const stage of p.stages)for(const k of ['warmDaily','coldDaily','likesDaily'])stage[k]=0;
  assert.deepEqual(maturePlanErrors(p),[]);p.stages[1].fromDay=3;p.stages[0].warmDaily=-1;p.stages[2].coldDaily=2;
  const errors=maturePlanErrors(p).join(' ');assert.match(errors,/overlaps/);assert.match(errors,/daily limit/);assert.match(errors,/cold connection sheet/);
});

test('legacy custom sheets retain their source and new order choices survive restore',()=>{
  const old = newMaturePlan();delete old.coldPoolSource;delete old.coldPoolOrder;old.coldPool='https://docs.google.com/spreadsheets/d/example/edit#gid=12';
  const restored=restoreMaturePlan(old);assert.equal(restored.coldPoolSource,'custom');assert.equal(restored.coldPool,old.coldPool);
  restored.coldPoolOrder='descending';assert.deepEqual(restoreMaturePlan(JSON.parse(JSON.stringify(restored))),restored);
});

test('changing a stage end advances subsequent starts and cascades overruns', async () => {
  const { updateMatureStageEnd } = await import('../public/js/mature-profile-plan.mjs');
  const plan = newMaturePlan();
  updateMatureStageEnd(plan, 0, 4);
  assert.equal(plan.stages[1].fromDay, 5);
  assert.equal(plan.stages[1].toDay, 7);
  updateMatureStageEnd(plan, 0, 16);
  assert.deepEqual(plan.stages.map(s => [s.fromDay,s.toDay]), [[1,16],[17,17],[18,18],[19,28]]);
  updateMatureStageEnd(plan, 0, '');
  assert.equal(plan.stages[1].fromDay, 17, 'blank edits do not corrupt following stages');
});

test('a new plan defaults to 3, 6, 10 then 20 warm connections a day until the pool is exhausted', async () => {
  const { newMaturePlan, restoreMaturePlan, maturePlanErrors } = await import('../public/js/mature-profile-plan.mjs');
  const plan = newMaturePlan();
  assert.deepEqual(plan.stages.map(s => [s.fromDay, s.toDay, s.warmDaily]), [[1, 3, 3], [4, 7, 6], [8, 14, 10], [15, 28, 20]]);
  assert.equal(plan.warmUntilExhausted, true);
  assert.deepEqual(maturePlanErrors({ ...plan, warmPool: 'ortus_owned' }), []);
  // A plan saved before this default keeps its own fixed end.
  assert.equal(restoreMaturePlan({ version: 1, stages: plan.stages }).warmUntilExhausted, false);
});
