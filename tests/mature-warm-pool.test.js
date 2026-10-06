import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWarmPool, lvProfileIdentity, matureWarmDailyAmount, matureWarmSchedule } from '../public/js/mature-warm-pool.mjs';
import { warmPreset } from '../public/js/mature-warm-ramp.mjs';

const soo = [
  { email: 'ana@ortus.solutions', 'Name as it appears on LinkedIn': 'Ana A', 'LinkedIn URL': 'https://www.linkedin.com/in/ana-a/' },
  { email: 'ben@ortus.solutions', 'Name as it appears on LinkedIn': 'Ben B', 'LinkedIn URL': 'https://www.linkedin.com/in/ben-b/' },
];
const lv = [
  { gologinProfileId: 'lv1', loginEmail: '', name: 'Cy C', linkedinUrl: 'https://www.linkedin.com/in/cy-c', restricted: false },
  { gologinProfileId: '', loginEmail: 'dee@klabber.co', name: 'Dee D', linkedinUrl: 'https://www.linkedin.com/in/dee-d', restricted: false },
  { gologinProfileId: 'lv3', loginEmail: 'eve@klabber.co', name: 'Eve E', linkedinUrl: 'https://www.linkedin.com/in/eve-e', restricted: true },
];
const profiles = [
  { id: 'o1', name: 'ana@ortus.solutions', account: 'ortus' },
  { id: 'o2', name: 'ben@ortus.solutions', account: 'ortus' },
  { id: 'o3', name: 'nobody@ortus.solutions', account: 'ortus' },
  { id: 'lv1', name: 'renamed profile', account: 'linkedvelocity' },
  { id: 'lv2', name: 'dee@klabber.co', account: 'linkedvelocity' },
  { id: 'lv3', name: 'eve@klabber.co', account: 'linkedvelocity' },
  { id: 'lv4', name: 'ghost@klabber.co', account: 'linkedvelocity' },
];

test('a Linked Velocity profile is matched by GoLogin id, then by login email', () => {
  assert.equal(lvProfileIdentity(profiles[3], lv).name, 'Cy C');
  assert.equal(lvProfileIdentity(profiles[4], lv).linkedinUrl, 'https://www.linkedin.com/in/dee-d');
  assert.equal(lvProfileIdentity(profiles[6], lv), null);
});

test('the Ortus pool is the Ortus workspace matched to the SoO, minus the warming account', () => {
  const pool = buildWarmPool({ pool: 'ortus_owned', profiles, sooAccounts: soo, lvAccounts: lv, excludeProfileIds: ['o1'] });
  assert.deepEqual(pool.targets.map(t => t.name), ['Ben B']);
  assert.deepEqual({ total: pool.total, missing: pool.missing }, { total: 2, missing: 1 });
});

test('the LV pool leaves out restricted accounts and accounts with no known URL', () => {
  const pool = buildWarmPool({ pool: 'linkedvelocity_owned', profiles, sooAccounts: soo, lvAccounts: lv });
  assert.deepEqual(pool.targets.map(t => t.profileId), ['lv1', 'lv2']);
  assert.deepEqual({ total: pool.total, missing: pool.missing, restricted: pool.restricted }, { total: 4, missing: 1, restricted: 1 });
});

test('an unknown pool has no targets', () => {
  assert.equal(buildWarmPool({ pool: '', profiles }).targets.length, 0);
});

test('the daily amount follows the ramp, then stops', () => {
  const plan = { warmRamp: { ...warmPreset('gentle'), stopAfterDays: 7 } };
  assert.deepEqual([1, 3, 4, 7, 8].map(d => matureWarmDailyAmount(plan, d)), [3, 3, 5, 7, 0]);
  assert.deepEqual(matureWarmSchedule(plan, '2026-10-05'), [3, 3, 3, 5, 5, 5, 7, 0]);
});

test('an until-exhausted ramp ends on its maximum so the engine keeps that rate', () => {
  const plan = { warmUntilExhausted: true, warmRamp: { ...warmPreset('gentle'), maximumDaily: 5 } };
  assert.deepEqual(matureWarmSchedule(plan, '2026-10-05'), [3, 3, 3, 5]);
});

test('a stop date ends the schedule on that date inclusive', () => {
  const plan = { warmRamp: { ...warmPreset('gentle'), stopMode: 'date', stopDate: '2026-10-07' } };
  assert.deepEqual(matureWarmSchedule(plan, '2026-10-05'), [3, 3, 3, 0]);
});

test('manual warm stages give each day its stage amount', () => {
  const plan = { connectionStages: { warm: [{ fromDay: 1, toDay: 2, daily: 4 }, { fromDay: 3, toDay: 4, daily: 9 }] } };
  assert.deepEqual(matureWarmSchedule(plan, '2026-10-05'), [4, 4, 9, 9, 0]);
});

import { matureColdSchedule } from '../public/js/mature-warm-pool.mjs';
test('cold waits for its first planned day, then follows its stages and stops', () => {
  const plan = { coldEnabled: true, connectionStages: { cold: [{ fromDay: 8, toDay: 9, daily: 4 }, { fromDay: 10, toDay: 11, daily: 7 }] } };
  assert.deepEqual(matureColdSchedule(plan), { delayDays: 7, amounts: [4, 4, 7, 7, 0] });
});
test('cold sends nothing when switched off or when every amount is 0', () => {
  const stages = { cold: [{ fromDay: 1, toDay: 5, daily: 6 }] };
  assert.equal(matureColdSchedule({ coldEnabled: false, connectionStages: stages }), null);
  assert.equal(matureColdSchedule({ coldEnabled: true, connectionStages: { cold: [{ fromDay: 1, toDay: 5, daily: 0 }] } }), null);
  assert.deepEqual(matureColdSchedule({ coldEnabled: true, connectionStages: stages }), { delayDays: 0, amounts: [6, 6, 6, 6, 6, 0] });
});

import { plannedDays, buildMatureTabRows, MATURE_TAB_HEADER } from '../public/js/mature-warm-pool.mjs';
test('people are planned day by day at each day\'s amount', () => {
  assert.deepEqual(plannedDays(7, [2, 3, 0]), [1, 1, 2, 2, 2, 0, 0]);       // plan ends: the rest are unplanned
  assert.deepEqual(plannedDays(7, [2, 3]), [1, 1, 2, 2, 2, 3, 3]);          // open-ended: last amount repeats
  assert.deepEqual(plannedDays(3, [2, 2, 0], 8), [8, 8, 9]);                // cold starts on its own day
});
test('the results tab lists warm then cold with the day each is planned for', () => {
  const rows = buildMatureTabRows({ startDate: '2026-10-05',
    warmTargets: [{ name: 'Ana A', linkedinUrl: 'https://www.linkedin.com/in/ana', profile: 'ana@ortus.solutions', profileId: 'p-ana' },
                  { name: 'Ben B', linkedinUrl: 'https://www.linkedin.com/in/ben', profile: 'ben@ortus.solutions', profileId: 'p-ben' }],
    warmAmounts: [1, 0],
    coldLeads: [{ name: 'Cy C', linkedinUrl: 'https://www.linkedin.com/in/cy' }], cold: { delayDays: 7, amounts: [5, 0] } });
  assert.equal(rows[0].length, MATURE_TAB_HEADER.length);
  assert.deepEqual(rows.map(r => r.slice(0, 7)), [
    ['Warm', 'Ana A', 'https://www.linkedin.com/in/ana', 'ana@ortus.solutions', 'p-ana', 1, '2026-10-05'],
    ['Warm', 'Ben B', 'https://www.linkedin.com/in/ben', 'ben@ortus.solutions', 'p-ben', '', 'After the plan ends'],
    ['Cold', 'Cy C', 'https://www.linkedin.com/in/cy', '', '', 8, '2026-10-12'],
  ]);
  // Status columns exist from the start and are blank until the campaign stamps them.
  assert.ok(MATURE_TAB_HEADER.includes('Connection Request Status') && MATURE_TAB_HEADER.includes('Connection Accepted Status'));
  assert.ok(rows.every(r => r.slice(7).every(cell => cell === '')));
});

test('all available combines accessible workspaces, excludes self/restricted/missing and deduplicates URLs', () => {
  const pool = buildWarmPool({ pool:'all_available', profiles:[...profiles, {id:'duplicate',account:'linkedvelocity',name:'dee@klabber.co'}], sooAccounts:soo, lvAccounts:lv, excludeProfileIds:['o1'] });
  assert.deepEqual(pool.targets.map(t=>t.profileId), ['o2','lv1','lv2']);
  assert.equal(pool.restricted, 1);
  assert.equal(pool.missing, 2);
});


import { shuffleWarmTargets } from '../public/js/mature-warm-pool.mjs';
test('each warm plan gets its own shuffled order, persisted before planned-day assignment', () => {
  const targets = Array.from({length:12}, (_,i)=>({profileId:`p${i}`,name:`Person ${i}`,linkedinUrl:`https://www.linkedin.com/in/person-${i}`,profile:`profile-${i}`}));
  const original = [...targets];
  const first = shuffleWarmTargets(targets,()=>0);
  const second = shuffleWarmTargets(targets,()=>0.5);
  assert.deepEqual(targets,original,'shared pool is never reordered');
  assert.notDeepEqual(first,targets);
  assert.notDeepEqual(first,second,'independent random draws give independent plans');
  assert.deepEqual([...first].sort((a,b)=>a.profileId.localeCompare(b.profileId)),[...targets].sort((a,b)=>a.profileId.localeCompare(b.profileId)));
  const rows=buildMatureTabRows({startDate:'2026-10-06',warmTargets:first,warmAmounts:[3,6]});
  assert.deepEqual(rows.map(r=>r[4]),first.map(t=>t.profileId),'sheet retains the randomized execution order');
  assert.deepEqual(rows.map(r=>r[5]),[1,1,1,2,2,2,2,2,2,3,3,3]);
  assert.deepEqual(shuffleWarmTargets([]),[]);
  assert.deepEqual(shuffleWarmTargets(targets.slice(0,1)),targets.slice(0,1));
});
