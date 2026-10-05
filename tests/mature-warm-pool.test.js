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
