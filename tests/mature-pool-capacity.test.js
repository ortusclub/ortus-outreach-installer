import test from 'node:test';
import assert from 'node:assert/strict';
import { warmPoolCapacity, coldStageRequirements } from '../public/js/mature-pool-capacity.mjs';
import { selectMatureColdLeads } from '../src/mature-cold-pool.js';
import { buildMatureTabRows, matureColdSchedule } from '../public/js/mature-warm-pool.mjs';
const plan = { coldEnabled: true, coldPoolOrder: 'random', connectionStages: { cold: [{fromDay:8,toDay:9,daily:2},{fromDay:10,toDay:12,daily:3}] } };
test('cold list exactly fills stages, excludes self/managed/duplicates and has planned days',()=>{
  const rows=Array.from({length:30},(_,i)=>({'Full Name':`Person ${i}`,'LinkedIn URL':`https://www.linkedin.com/in/person-${i}`}));
  rows.push({...rows[0]});
  const result=selectMatureColdLeads({plan,rows,excludedUrls:[rows[0]['LinkedIn URL']],random:()=>0});
  assert.equal(result.required,13);assert.equal(result.available,29);assert.equal(result.leads.length,13);
  assert(!result.leads.some(l=>l.linkedinUrl===rows[0]['LinkedIn URL']));
  assert.equal(new Set(result.leads.map(l=>l.linkedinUrl)).size,13);
  assert.deepEqual(coldStageRequirements(plan).map(s=>s.count),[4,9]);
  const written=buildMatureTabRows({startDate:'2026-10-06',coldLeads:result.leads,cold:matureColdSchedule(plan)});
  assert.deepEqual(written.map(r=>r[5]),[8,8,9,9,10,10,10,11,11,11,12,12,12]);
  assert.throws(()=>selectMatureColdLeads({plan,rows:rows.slice(0,4)}),/needs 13.*only 4/);
});
test('warm capacity identifies exhaustion, zero pool, exact fit and finite plans longer than chart',()=>{
  const warm={warmUntilExhausted:true,connectionStages:{warm:[{fromDay:1,toDay:28,daily:3}]}};
  assert.deepEqual(warmPoolCapacity(warm,7),{available:7,planned:84,openEnded:true,exceeds:true,lastAvailableDay:3,firstUnavailableDay:3});
  assert.equal(warmPoolCapacity(warm,0).exceeds,true);
  const finite={connectionStages:{warm:[{fromDay:1,toDay:40,daily:2}]}};
  assert.equal(warmPoolCapacity(finite,80).exceeds,false);assert.equal(warmPoolCapacity(finite,79).exceeds,true);
});
