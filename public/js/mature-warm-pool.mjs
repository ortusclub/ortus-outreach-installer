import { matureProfileIdentity } from './mature-profile-identity.mjs';
import { warmDailyAmount } from './mature-warm-ramp.mjs';

// A warm pool is a whole GoLogin workspace: the profile's `account` says which
// API key loaded it, and that is the ownership test.
export const WARM_POOL_ACCOUNT = Object.freeze({ ortus_owned: 'ortus', linkedvelocity_owned: 'linkedvelocity' });

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g;
const LINKEDIN_PROFILE = /^https?:\/\/(?:[a-z]+\.)?linkedin\.com\/in\/[^\s/]+/i;
const urlKey = url => String(url || '').toLowerCase().replace(/^https?:\/\/(?:[a-z]+\.)?linkedin\.com\/in\//, '').replace(/[/?#].*$/, '');

// Linked Velocity keeps its own account list. Match on the GoLogin profile id
// first; the login email (which names the GoLogin profile) is the fallback.
export function lvProfileIdentity(profile, lvAccounts) {
  const list = Array.isArray(lvAccounts) ? lvAccounts : [];
  let row = list.find(a => a.gologinProfileId && a.gologinProfileId === profile.id);
  if (!row) {
    const emails = `${profile.email || ''} ${profile.name || ''}`.toLowerCase().match(EMAIL) || [];
    const rows = list.filter(a => a.loginEmail && emails.includes(String(a.loginEmail).trim().toLowerCase()));
    if (rows.length === 1) row = rows[0];
  }
  if (!row) return null;
  return { name: String(row.name || '').trim(), linkedinUrl: LINKEDIN_PROFILE.test(row.linkedinUrl || '') ? row.linkedinUrl : '', restricted: !!row.restricted };
}

// The SoO only lists Ortus accounts, so a Linked Velocity profile is looked up
// in the Linked Velocity list and everything else in the SoO.
export function warmProfileIdentity(profile, { sooAccounts = [], lvAccounts = [] } = {}) {
  return profile.account === WARM_POOL_ACCOUNT.linkedvelocity_owned
    ? lvProfileIdentity(profile, lvAccounts)
    : matureProfileIdentity(profile, sooAccounts);
}

// Everyone in the pool the warming account can be sent to. An account without
// a known LinkedIn URL cannot be invited, so it is counted and left out.
export function buildWarmPool({ pool, profiles = [], sooAccounts = [], lvAccounts = [], excludeProfileIds = [] }) {
  const account = WARM_POOL_ACCOUNT[pool];
  if (!account) return { targets: [], total: 0, missing: 0, restricted: 0 };
  const exclude = new Set(excludeProfileIds);
  const members = profiles.filter(p => p.account === account && !exclude.has(p.id));
  const targets = [], seen = new Set();
  let missing = 0, restricted = 0;
  for (const profile of members) {
    const identity = warmProfileIdentity(profile, { sooAccounts, lvAccounts });
    if (!identity?.linkedinUrl) { missing++; continue; }
    if (identity.restricted) { restricted++; continue; }
    const key = urlKey(identity.linkedinUrl);
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ profileId: profile.id, profile: profile.name || profile.id, name: identity.name, linkedinUrl: identity.linkedinUrl });
  }
  return { targets, total: members.length, missing, restricted };
}

// Warm connections to send on a given day of the plan (day 1 = the start day).
export function matureWarmDailyAmount(plan, day) {
  if (!plan || !Number.isInteger(day) || day < 1) return 0;
  if (plan.warmRamp) return warmDailyAmount(plan.warmUntilExhausted ? { ...plan.warmRamp, stopMode: 'none' } : plan.warmRamp, day);
  const stages = plan.connectionStages?.warm
    || (plan.stages || []).map(s => ({ fromDay: s.fromDay, toDay: s.toDay, daily: s.warmDaily }));
  const last = stages.at(-1);
  const stage = stages.find(s => day >= Number(s.fromDay) && (day <= Number(s.toDay) || (plan.warmUntilExhausted && s === last)));
  const amount = Number(stage?.daily);
  return Number.isInteger(amount) && amount > 0 ? amount : 0;
}

// The plan's warm amounts as one list, day 1 first. The engine reads this to
// change the daily limit each day; an open-ended plan repeats its last amount.
export function matureWarmSchedule(plan, startDate, maxDays = 365) {
  // "Stop on a date" is the one rule that depends on when the plan starts.
  let lastDay = Infinity;
  if (plan?.warmRamp?.stopMode === 'date' && !plan.warmUntilExhausted) {
    const days = Math.round((Date.parse(`${plan.warmRamp.stopDate}T12:00:00Z`) - Date.parse(`${startDate}T12:00:00Z`)) / 86400000);
    lastDay = Number.isFinite(days) ? days + 1 : 0;
  }
  const amounts = [];
  for (let day = 1; day <= maxDays; day++) amounts.push(day > lastDay ? 0 : matureWarmDailyAmount(plan, day));
  while (amounts.length > 1 && amounts.at(-1) === amounts.at(-2)) amounts.pop();
  return amounts;
}
