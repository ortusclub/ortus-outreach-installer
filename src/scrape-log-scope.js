// Scoping a scrape's log lines to the scrape they belong to.
//
// The engine keeps ONE global live log buffer for every job on the box. The
// board asks for a single campaign's log, so something has to decide which of
// those lines are that campaign's. That decision used to be a tab-name prefix
// match, which was wrong in two ways that both fired in production on
// 2026-08-13:
//
//   - 83 live campaigns shared the tab "Results", so every "Results *" scrape
//     rendered every other one's events. A scrape collecting normally showed
//     18 unrelated "this LinkedIn account is logged out" failures from a batch
//     of "Results 1111 N" runs, and read as broken. "A" also matched "A.".
//   - Engine-derived strips (every `eng_…`) have no local record, so the tab
//     name arrived empty — and the guard `!tabName || …` turned the filter into
//     a no-op that returned the ENTIRE global buffer.
//
// The engine stamps every line with the jobId that produced it, and a campaign
// knows its own jobs, so job identity is the only thing that actually scopes a
// line. These are pure so the rule is testable without an engine.

/**
 * The engine job ids belonging to one campaign record.
 *
 * A job carries `id` and `runId`; today they're the same value, but both are
 * collected so a future split can't silently empty the set (which would blank
 * every log rather than mis-scope it).
 *
 * @param {{jobs?: Array<{id?: string, runId?: string}>}|null} rec board record
 * @returns {Set<string>}
 */
export function jobIdsForCampaign(rec) {
  const jobs = (rec && rec.jobs) || [];
  const out = new Set();
  for (const j of jobs) {
    if (!j) continue;
    if (j.id) out.add(String(j.id));
    if (j.runId) out.add(String(j.runId));
  }
  return out;
}

/**
 * Keep only the live-buffer lines produced by this campaign's own jobs.
 *
 * Fails CLOSED, deliberately. An unidentifiable campaign (no jobs yet) and an
 * unlabelled line (no jobId) both yield nothing rather than everything: a log
 * that is missing lines reads as "nothing happened yet", while a log carrying
 * another scrape's failures reads as "this scrape is broken" and sends the
 * operator to fix an account that was never involved. The campaign's own
 * persisted + per-run history are unaffected either way.
 *
 * @param {Array<{ts?: number, message?: string, jobId?: string, tabName?: string}>} lines
 * @param {Set<string>} jobIds
 */
export function scopeLiveLines(lines, jobIds) {
  if (!Array.isArray(lines) || !jobIds || jobIds.size === 0) return [];
  return lines
    .filter((ln) => ln && ln.jobId && jobIds.has(String(ln.jobId)))
    .map((ln) => ({ ts: ln.ts, message: ln.message, jobId: ln.jobId, tabName: ln.tabName }));
}
