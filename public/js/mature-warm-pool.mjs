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
  return { name: String(row.name || '').trim(), linkedinUrl: LINKEDIN_PROFILE.test(row.linkedinUrl || '') ? row.linkedinUrl : '', restricted: !!row.restricted, loginEmail: String(row.loginEmail || '').trim().toLowerCase() };
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
  if (!account && pool !== 'all_available') return { targets: [], total: 0, missing: 0, restricted: 0 };
  const exclude = new Set(excludeProfileIds);
  const members = profiles.filter(p => (pool === 'all_available' || p.account === account) && !exclude.has(p.id));
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

// Choose a fresh order for each profile's plan, without mutating the shared pool.
// Shuffle before assigning planned days, then persist that order in the sheet.
export function shuffleWarmTargets(targets, random = Math.random) {
  const shuffled = [...targets];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

// Warm connections to send on a given day of the plan (day 1 = the start day).
export function matureWarmDailyAmount(plan, day) {
  if (!plan || plan.warmEnabled === false || !Number.isInteger(day) || day < 1) return 0;
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
// Cold connections to send on a given day of the plan. Cold has no
// until-exhausted rule: after its last stage it stops.
export function matureColdDailyAmount(plan, day) {
  if (!plan || plan.coldEnabled !== true || !Number.isInteger(day) || day < 1) return 0;
  const stages = plan.connectionStages?.cold
    || (plan.stages || []).map(s => ({ fromDay: s.fromDay, toDay: s.toDay, daily: s.coldDaily }));
  const stage = stages.find(s => day >= Number(s.fromDay) && day <= Number(s.toDay));
  const amount = Number(stage?.daily);
  return Number.isInteger(amount) && amount > 0 ? amount : 0;
}

// Cold usually begins some days into the plan. Returns the days to wait before
// its first send and the amounts from that day on, or null when the plan sends
// no cold connections at all.
export function matureColdSchedule(plan, maxDays = 365) {
  const amounts = [];
  for (let day = 1; day <= maxDays; day++) amounts.push(matureColdDailyAmount(plan, day));
  const first = amounts.findIndex(n => n > 0);
  if (first < 0) return null;
  const rest = amounts.slice(first);
  while (rest.length > 1 && rest.at(-1) === rest.at(-2)) rest.pop();
  return { delayDays: first, amounts: rest };
}

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

// ── The account's results tab ───────────────────────────────────────────────
// One tab per matured account, named after its login email. It lists everyone
// the plan intends to connect with and when; the campaign reads its leads from
// it and stamps each row's request status, dates and acceptance back into it.
// ("Date", "Status" and "Time" are avoided as headers: the sheet tooling
// removes columns with those legacy names.)
// The tracking columns the campaign stamps are created up front, so the tab is
// complete from the start and nothing depends on another script adding them.
export const MATURE_TAB_HEADER = Object.freeze(['Type', 'Full Name', 'LinkedIn URL', 'Pool Account', 'Pool Profile ID', 'Planned Day', 'Planned Date',
  'Connection Request Status', 'Connection Accepted Status', 'Account Used', 'Date of Last Action', 'Time of Last Action']);
const TAB_PLAN_COLUMNS = 7; // Type … Planned Date; the rest start blank

// Which plan day each person in a list falls on: day 1 takes amounts[0] people,
// day 2 the next amounts[1], and so on. Past the list the last amount repeats;
// if that is 0 the plan has ended and the rest are left unplanned (0).
export function plannedDays(count, amounts, firstDay = 1) {
  const days = [];
  for (let i = 0; days.length < count && i < 100000; i++) {
    const amount = Number(amounts[Math.min(i, amounts.length - 1)]) || 0;
    if (amount <= 0 && i >= amounts.length - 1) break;
    for (let n = 0; n < amount && days.length < count; n++) days.push(firstDay + i);
  }
  while (days.length < count) days.push(0);
  return days;
}

const addDays = (startDate, days) => new Date(Date.parse(`${startDate}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

// Rows for the tab: warm pool accounts first, then cold leads, each with the
// day the plan expects to reach them. `cold` is matureColdSchedule()'s result.
export function buildMatureTabRows({ startDate, warmTargets = [], warmAmounts = [], coldLeads = [], cold = null }) {
  const rows = [];
  const add = (type, list, days, cells) => list.forEach((item, i) => {
    const day = days[i];
    rows.push([type, ...cells(item), day || '', day ? addDays(startDate, day - 1) : 'After the plan ends',
      ...Array(MATURE_TAB_HEADER.length - TAB_PLAN_COLUMNS).fill('')]);
  });
  add('Warm', warmTargets, plannedDays(warmTargets.length, warmAmounts), t => [t.name, t.linkedinUrl, t.profile, t.profileId]);
  if (cold) add('Cold', coldLeads, plannedDays(coldLeads.length, cold.amounts, cold.delayDays + 1), l => [l.name, l.linkedinUrl, '', '']);
  return rows;
}
