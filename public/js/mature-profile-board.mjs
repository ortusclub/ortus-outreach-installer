// Called after ownership, deletion and dashboard filters have been applied.
export function splitMaturingCampaigns(items) {
  const regular = [], maturing = [];
  for (const item of items) {
    // A running warm stage is an ordinary Connection campaign flagged `maturing`.
    (item.mode === 'mature_profile' || item.maturing ? maturing : regular).push(item);
  }
  return { regular, maturing };
}

// Where a running warm stage is in its plan. `schedule` is the campaign's
// { startDate, amounts } (see mature-warm-pool.mjs); days are UTC dates, the
// clock the engine counts sends on. Past the list, the last amount applies.
// The calendar date an instant falls on in a time zone (YYYY-MM-DD).
export function localDay(instant, timeZone) {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(instant)); }
  catch { return new Date(instant).toISOString().slice(0, 10); }
}
// The engine's default zone for a campaign that names none (its 09:00 batch).
export const MATURE_DEFAULT_TIME_ZONE = 'Europe/Rome';

// A schedule with `startAt` counts days in the campaign's time zone (pass
// `timeZone` and `now`), matching the engine; an older one with only
// `startDate` counts UTC dates from `today`.
export function maturingStatus({ kind = 'warm', schedule, today, now = Date.now(), timeZone = '', sentToday = null, sent = 0, total = 0 }) {
  const cold = kind === 'cold', what = `${cold ? 'cold' : 'warm'} connections`, who = cold ? 'leads' : 'pool accounts';
  const amounts = Array.isArray(schedule?.amounts) ? schedule.amounts.map(Number) : [];
  const zoned = Number.isFinite(Date.parse(schedule?.startAt || ''));
  const tz = timeZone || MATURE_DEFAULT_TIME_ZONE;
  const from = zoned ? localDay(schedule.startAt, tz) : schedule?.startDate;
  const to = zoned ? localDay(now, tz) : today;
  const index = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
  if (!amounts.length || !Number.isFinite(index)) return null;
  const at = i => amounts[Math.min(Math.max(i, 0), amounts.length - 1)] || 0;
  const day = Math.max(index, 0) + 1;
  // A plan that ends lists a final 0; an open-ended one ends on its steady rate.
  const planDays = amounts.at(-1) === 0 ? amounts.length - 1 : null;
  const finished = planDays !== null && day > planDays;
  const poolDone = total > 0 && sent >= total;
  const parts = [];
  if (poolDone) parts.push(cold ? 'Every lead in the cold sheet has been invited' : 'Every account in the pool has been invited');
  else if (finished) parts.push(`Plan complete after ${planDays} day${planDays === 1 ? '' : 's'} — no more ${what} will be sent`);
  else {
    parts.push(`Day ${day}${planDays ? ` of ${planDays}` : ''}`);
    parts.push(sentToday === null ? `up to ${at(index)} ${what} today` : `${Math.min(sentToday, at(index))} of ${at(index)} ${what} sent today`);
    const tomorrow = at(index + 1);
    parts.push(tomorrow === at(index) ? 'same amount tomorrow' : tomorrow === 0 ? 'last day of the plan' : `${tomorrow} tomorrow`);
  }
  if (total > 0 && !poolDone) parts.push(`${sent} of ${total} ${who} invited`);
  return { day, planDays, todayLimit: finished ? 0 : at(index), finished: finished || poolDone, text: parts.join(' · ') };
}

// One log for every maturing campaign. Each campaign's engine log is
// [{ t, line }]; lines are merged in time order and tagged with the account
// (the campaign's name) and whether it is the warm or the cold stage.
export function mergeMaturingLogs(campaigns, limit = 60) {
  const all = [];
  for (const c of campaigns || []) {
    const tag = `${String(c.name || '').replace(/ · Cold$/, '')} · ${c.kind === 'cold' ? 'cold' : 'warm'}`;
    for (const e of c.log || []) {
      const line = String((e && e.line) || '').trim();
      if (line) all.push({ t: Number(e.t) || 0, text: `${tag} — ${line}` });
    }
  }
  return all.sort((a, b) => a.t - b.t).slice(-limit);
}

// The one-word state a maturing campaign shows in the Profile Maturing list.
// `tone` picks the dot colour: green only while it is actually connecting.
export function maturingRowState(it) {
  if (it.needsReview) return { label: 'Needs attention', tone: 'red' };
  if (it.bucket === 'done') return it.bad ? { label: 'Stopped', tone: 'muted' } : { label: 'Finished', tone: 'done' };
  if (it.stopping) return { label: 'Stopping', tone: 'muted' };
  if (it.paused) return { label: 'Paused', tone: 'muted' };
  if (it.bucket === 'queued') return it.scheduledAt ? { label: 'Scheduled', tone: 'muted' } : { label: 'Starting', tone: 'amber' };
  // The engine's own status wins over the browser-open flag, which can lag.
  if (it.dailyWait) return { label: 'Sleeping', tone: 'amber' };
  if (it.live) return { label: 'Active', tone: 'green' };
  return { label: 'Awaiting its turn', tone: 'amber' };
}

// What a maturing campaign does next and when, as one short line. The time is
// the engine's own next-batch time; it is always subject to the shared
// maturing worker being free. `viewerTimeZone` is for tests (default: this
// computer's zone).
export function maturingNextAction(it, { now = Date.now(), viewerTimeZone } = {}) {
  if (!it || it.needsReview || it.bucket === 'done' || it.stopping || it.paused) return '';
  const what = `${it.matureKind === 'cold' ? 'cold' : 'warm'} connection`;
  const schedule = it.warmSchedule, amounts = Array.isArray(schedule?.amounts) ? schedule.amounts.map(Number) : [];
  const tz = it.matureTz || MATURE_DEFAULT_TIME_ZONE;
  const amountOn = (instant) => {
    if (!amounts.length || !Number.isFinite(Date.parse(schedule?.startAt || ''))) return null;
    const index = Math.round((Date.parse(`${localDay(instant, tz)}T00:00:00Z`) - Date.parse(`${localDay(schedule.startAt, tz)}T00:00:00Z`)) / 86400000);
    return amounts[Math.min(Math.max(index, 0), amounts.length - 1)] || 0;
  };
  const count = (n) => (n === null ? `${what}s` : `${n} ${what}${n === 1 ? '' : 's'}`);
  const at = (instant) => new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, ...(viewerTimeZone ? { timeZone: viewerTimeZone } : {}) }).format(new Date(instant)).replace(/^(\w+),/, '$1');
  const free = 'when the worker is free';
  const due = (instant) => (Number.isFinite(Date.parse(instant || '')) ? instant : null);
  if (it.bucket === 'queued') {
    const start = due(it.scheduledAt);
    return start ? `Next: ${count(amountOn(start))} · ${at(start)} · ${free}` : `Next: ${count(amountOn(now))} today · as soon as the worker is free`;
  }
  if (it.dailyWait) {
    const resume = due(it.resumeAt);
    if (!resume) return `Next: ${what}s in the next daily batch · ${free}`;
    const n = amountOn(resume);
    return n === 0 ? 'Plan complete — nothing further is planned' : `Next: ${count(n)} · ${at(resume)} · ${free}`;
  }
  const today = amountOn(now);
  if (today === 0) return 'Plan complete — nothing further is planned';
  return it.live ? `Now: sending today's ${count(today)}` : `Next: today's ${count(today)} · as soon as the worker is free`;
}

// One entry per matured account: its warm and cold campaigns side by side, with
// how many connections each has attempted. The newest run of each kind wins.
export function groupMaturingAccounts(items) {
  const groups = new Map();
  for (const it of items || []) {
    const name = String(it.name || '(unnamed)').replace(/ · Cold$/, '');
    const g = groups.get(name) || { name, warm: null, cold: null, items: [] };
    const kind = it.matureKind === 'cold' ? 'cold' : 'warm';
    if (!g[kind] || (it.startedAt || 0) > (g[kind].startedAt || 0)) g[kind] = it;
    g.items.push(it);
    groups.set(name, g);
  }
  return [...groups.values()].map(g => {
    // The account's state is its most "alive" campaign's state.
    const order = ['Active', 'Needs attention', 'Starting', 'Awaiting its turn', 'Sleeping', 'Scheduled', 'Paused', 'Stopping', 'Stopped', 'Finished'];
    const states = [g.warm, g.cold].filter(Boolean).map(maturingRowState);
    states.sort((a, b) => order.indexOf(a.label) - order.indexOf(b.label));
    return { ...g, state: states[0] || { label: '', tone: 'muted' }, warmSent: g.warm ? (g.warm.sent || 0) : null, coldSent: g.cold ? (g.cold.sent || 0) : null };
  });
}
