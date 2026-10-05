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
export function maturingStatus({ kind = 'warm', schedule, today, sentToday = null, sent = 0, total = 0 }) {
  const cold = kind === 'cold', what = `${cold ? 'cold' : 'warm'} connections`, who = cold ? 'leads' : 'pool accounts';
  const amounts = Array.isArray(schedule?.amounts) ? schedule.amounts.map(Number) : [];
  const index = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${schedule?.startDate}T00:00:00Z`)) / 86400000);
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
