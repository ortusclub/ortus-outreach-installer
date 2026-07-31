/**
 * Throughput headline for a CLOUD campaign.
 *
 * The local forecast models wall-clock: leads ÷ (~50 leads/hr × parallel
 * browsers) → "2H 6M, finishes 18:15". That model does not describe the VM.
 * Cloud work is spread across autoscaled pods, the per-campaign parallelism
 * knob is never sent to the engine, and the shared account lock already keeps
 * each LinkedIn account to one action at a time fleet-wide. What actually
 * bounds a cloud campaign is the daily send cap the engine enforces per
 * account per day.
 *
 * So the cloud headline answers a different question — capacity per day, and
 * how many days the sheet needs — instead of inventing an hour count.
 */

/** Whole days needed to work `leads` at `perDay`. */
export function daysNeeded(leads, perDay) {
  if (!(perDay > 0) || !(leads > 0)) return 0;
  return Math.ceil(leads / perDay);
}

/**
 * @param {object} o
 * @param {number} o.accounts      selected sender accounts
 * @param {number} o.dailyLimit    per account, per day
 * @param {number|null} o.leadsInSheet  null until the sheet is previewed
 * @param {number} [o.now]         epoch ms, injectable for tests
 * @param {(d: Date) => string} [o.fmtDate]  date formatter, injectable
 */
export function cloudThroughputView({ accounts, dailyLimit, leadsInSheet, now = Date.now(), fmtDate }) {
  const fmt = fmtDate || ((d) => d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }));
  const n = Number(accounts) || 0;
  const limit = Number(dailyLimit) || 0;

  if (n <= 0) {
    return {
      actions: '—', actionsSub: 'select accounts to see forecast',
      durationK: 'Capacity', duration: '—', durationSub: '—',
      finishK: 'Finishes', finish: '—', finishSub: '—',
    };
  }

  const perDay = limit * n;
  const acctWord = n === 1 ? 'account' : 'accounts';

  // Sheet not previewed yet — state the capacity, promise no finish date.
  if (!(Number(leadsInSheet) > 0)) {
    return {
      actions: String(perDay),
      actionsSub: `${n} ${acctWord} × ${limit} per day`,
      durationK: 'Capacity',
      duration: `${perDay} / day`,
      durationSub: "the VM's real limit",
      finishK: 'Finishes',
      finish: '—',
      finishSub: 'preview the sheet to forecast',
    };
  }

  const leads = Number(leadsInSheet);
  const days = daysNeeded(leads, perDay);
  const done = new Date(now + days * 86_400_000);

  return {
    actions: String(perDay),
    actionsSub: `${n} ${acctWord} × ${limit} per day`,
    durationK: 'Capacity',
    duration: `${perDay} / day`,
    durationSub: "the VM's real limit",
    finishK: `${leads} leads`,
    finish: days === 1 ? '~1 day' : `~${days} days`,
    finishSub: `done by ${fmt(done)}`,
  };
}
