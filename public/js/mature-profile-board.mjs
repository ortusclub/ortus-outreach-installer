import { maturingPreviewActivity } from './mature-preview-picker.mjs';
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

// "21:20:58" in the viewer's own time zone, for the start of a log line.
export function logClock(t, timeZone) {
  if (!Number.isFinite(Number(t)) || Number(t) <= 0) return '';
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, ...(timeZone ? { timeZone } : {}) }).format(new Date(Number(t)));
}

// Lines the app adds to the combined log while a due action waits for a cloud
// worker: nothing in the cloud is running then, so nothing else would log it.
// One "looking" line when the action falls due, then a "still looking" line
// every 15 seconds, each with how long this normally takes.
export const WORKER_WAKE_TYPICAL = 'usually about 2 minutes, because workers sleep when idle';
export function maturingWaitLines(items, now = Date.now(), maxLines = 12) {
  const lines = [];
  for (const it of items || []) {
    if (!it || it.live || it.needsReview || it.paused || it.stopping || it.bucket === 'done') continue;
    const tag = `${String(it.name || '').replace(/ · Cold$/, '')} · ${it.matureKind === 'cold' ? 'cold' : 'warm'}`;
    const accepts = Number(it.acceptPending) || 0;
    const acceptDue = Date.parse(it.acceptDueAt || ''), resumeDue = Date.parse(it.resumeAt || '');
    let since = NaN, what = '', after = '';
    if (accepts > 0 && acceptDue <= now) {
      since = acceptDue; what = `accept ${accepts} connection request${accepts === 1 ? '' : 's'} in the receiving account${accepts === 1 ? '' : 's'}`;
      after = ' Accepting then takes about 1 minute per account.';
    } else if (it.dailyWait && resumeDue <= now) {
      since = resumeDue; what = `send today's ${it.matureKind === 'cold' ? 'cold' : 'warm'} connections`;
      after = ' Sending then takes a few minutes per batch.';
    }
    if (!Number.isFinite(since)) continue;
    const waited = Math.max(0, Math.floor((now - since) / 1000));
    const mine = [{ t: since, text: `${tag} — 🔎 Looking for a VM worker to ${what}. This is ${WORKER_WAKE_TYPICAL}.${after}` }];
    const span = (sec) => (sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s`);
    for (let sec = 15; sec <= waited; sec += 15) {
      mine.push({ t: since + sec * 1000, text: `${tag} — ⏳ Still looking for a VM worker to ${what} — ${span(sec)} so far (${sec > 300 ? 'longer than usual; it keeps trying' : 'usually about 2 minutes'}).` });
    }
    // Keep the opening line and the most recent ticks.
    lines.push(...(mine.length > maxLines ? [mine[0], ...mine.slice(-(maxLines - 1))] : mine));
  }
  return lines.sort((a, b) => a.t - b.t);
}

// The one-word state a maturing campaign shows in the Profile Maturing list.
// `tone` picks the dot colour: green only while it is actually connecting.
export function maturingRowState(it) {
  if (it.needsReview) return { label: 'Needs attention', tone: 'red' };
  if (it.bucket === 'done') return it.bad ? { label: 'Stopped', tone: 'muted' } : { label: 'Finished', tone: 'done' };
  if (it.stopping) return { label: 'Stopping', tone: 'muted' };
  if (it.paused) return { label: 'Paused', tone: 'muted' };
  if (it.bucket === 'queued') return it.scheduledAt ? { label: 'Scheduled', tone: 'muted' } : { label: 'Starting', tone: 'amber' };
  if (maturingPreviewActivity(it)) return { label: 'Active', tone: 'green' };
  // The engine's own status wins over the browser-open flag, which can lag.
  if (it.dailyWait) return { label: 'Sleeping', tone: 'amber' };
  return { label: 'Awaiting its turn', tone: 'amber' };
}

// Has today's batch been fully sent? Read from the engine's own log: its send
// and turn lines end "n/m today". The newest such line decides.
export function maturingBatchDone(log) {
  const lines = (Array.isArray(log) ? log : []).map((e) => ({ t: Number(e && e.t) || 0, line: String((e && e.line) || '') })).sort((a, b) => b.t - a.t);
  for (const { line } of lines) {
    const m = line.match(/(\d+)\s*(?:\/|of)\s*(\d+)\s*(?:sent\s*)?today/i);
    if (m) return Number(m[1]) >= Number(m[2]) && Number(m[2]) > 0;
  }
  return false;
}

// What a maturing campaign does next and when, as one short line. The time is
// the engine's own next-batch time; it is always subject to the shared
// maturing worker being free. `viewerTimeZone` is for tests (default: this
// computer's zone).
export function maturingNextAction(it, { now = Date.now(), viewerTimeZone } = {}) {
  if (!it || it.needsReview || it.bucket === 'done' || it.stopping || it.paused) return '';
  if (maturingPreviewActivity(it, now) === 'Accepting') return 'Now: accepting connection requests';
  const what = `${it.matureKind === 'cold' ? 'cold' : 'warm'} connection`;
  const schedule = it.warmSchedule, amounts = Array.isArray(schedule?.amounts) ? schedule.amounts.map(Number) : [];
  const tz = it.matureTz || MATURE_DEFAULT_TIME_ZONE;
  const amountOn = (instant) => {
    if (!amounts.length || !Number.isFinite(Date.parse(schedule?.startAt || ''))) return null;
    const index = Math.round((Date.parse(`${localDay(instant, tz)}T00:00:00Z`) - Date.parse(`${localDay(schedule.startAt, tz)}T00:00:00Z`)) / 86400000);
    return amounts[Math.min(Math.max(index, 0), amounts.length - 1)] || 0;
  };
  const count = (n) => (n === null ? `${what}s` : `${n} ${what}${n === 1 ? '' : 's'}`);
  const at = (instant) => new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short', ...(viewerTimeZone ? { timeZone: viewerTimeZone } : {}) }).format(new Date(instant)).replace(/^(\w+),/, '$1');
  const due = (instant) => (Number.isFinite(Date.parse(instant || '')) ? instant : null);
  if (it.bucket === 'queued') {
    const start = due(it.scheduledAt);
    return start ? `Next: ${count(amountOn(start))} · Attempt at ${at(start)}` : `Next: ${count(amountOn(now))} today · Waiting for attempt time`;
  }
  // Today's batch is out: the receiving accounts accept it 15 minutes later.
  if (Number(it.acceptPending) > 0 && !(it.live && !it.dailyWait)) {
    const n = Number(it.acceptPending), when = due(it.acceptDueAt);
    return `Next: accept ${n} connection request${n === 1 ? '' : 's'} in the receiving account${n === 1 ? '' : 's'}${when ? ` · Attempt at ${at(when)}` : ' · Waiting for attempt time'}`;
  }
  if (it.dailyWait) {
    const resume = due(it.resumeAt);
    if (!resume) return `Next: ${what}s in the next daily batch · Waiting for attempt time`;
    const n = amountOn(resume);
    return n === 0 ? 'Plan complete — nothing further is planned' : `Next: ${count(n)} · Attempt at ${at(resume)}`;
  }
  const today = amountOn(now);
  if (today === 0) return 'Plan complete — nothing further is planned';
  // Today's batch is out but the engine has not closed the day yet (it rests a
  // few minutes first). The accepts are queued when it does.
  if (it.batchDoneToday && !it.live) return `Next: the receiving accounts accept today's requests · about 15 minutes after the batch closes, which takes a few minutes`;
  return it.live ? `Now: sending today's ${count(today)}` : `Next: today's ${count(today)} · Waiting for attempt time`;
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

// Keep display history when switching accounts or receiving a shorter engine
// snapshot. Account labels are part of the key, so separate accounts survive.
export function retainMaturingLog(previous, incoming, limit = 2000) {
  const events = new Map();
  for (const line of [...(Array.isArray(previous) ? previous : []), ...(Array.isArray(incoming) ? incoming : [])]) {
    if (!line || typeof line.text !== 'string' || !Number.isFinite(line.t)) continue;
    events.set(JSON.stringify([line.t, line.text]), { t: line.t, text: line.text });
  }
  return [...events.values()].sort((a, b) => a.t - b.t).slice(-limit);
}
