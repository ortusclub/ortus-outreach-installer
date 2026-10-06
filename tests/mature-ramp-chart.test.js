import test from 'node:test';
import assert from 'node:assert/strict';
import { warmRampPreview } from '../public/js/mature-ramp-chart.mjs';
import { newMaturePlan } from '../public/js/mature-profile-plan.mjs';
test('chart uses the configured stage schedule and updates with edits',()=>{
  const plan=newMaturePlan();
  assert.deepEqual(warmRampPreview(plan).filter(r=>[1,4,8,15,28].includes(r.day)).map(r=>r.amount),[3,6,10,20,20]);
  plan.connectionStages={warm:[{fromDay:1,toDay:2,daily:4},{fromDay:3,toDay:7,daily:8}]};
  assert.deepEqual(warmRampPreview(plan,4).map(r=>r.amount),[4,4,8,8]);
  plan.connectionStages.warm[0].daily=7;
  assert.equal(warmRampPreview(plan)[0].amount,7);
  plan.warmEnabled=false;
  assert(warmRampPreview(plan).every(r=>r.amount===0));
});
