// ⑫ Account warm-up mode — pure schedule math (no I/O; persistence lives in
// src/warmup-store.js). Design: public/sketches/account-warmup-A.html +
// the warm-up section of public/sketches/master-all-features.html.
//
// Fresh/cold LinkedIn accounts ramp instead of jumping straight to the
// campaign's daily limit:
//   week 1 → 5/day · week 2 → 10/day · week 3 → 20/day · week 4+ → normal
//   campaign limit.
// The cap only ever LOWERS the limit — it's min(configured, weekly cap), so a
// campaign configured below the week's cap keeps its own (lower) limit.
// Weeks are calendar weeks (7×24h) from startedAt; pausing a campaign does
// not reset the week (the clock is wall time, not activity).

export const WARMUP_SCHEDULE = [5, 10, 20]; // per-day caps for weeks 1..3
export const WARMUP_WEEKS = WARMUP_SCHEDULE.length;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// 1-based warm-up week for a given start date, or null if startedAt is
// missing/unparseable. Week 4+ means the ramp is complete.
export function warmupWeek(startedAt, now = new Date()) {
  const start = new Date(startedAt).getTime();
  const at = new Date(now).getTime();
  if (!startedAt || !Number.isFinite(start) || !Number.isFinite(at)) return null;
  if (at < start) return 1; // clock skew / future start — treat as week 1
  return Math.floor((at - start) / WEEK_MS) + 1;
}

// Collapse an {enabled, startedAt} entry into one verdict:
//   { active, complete, week, cap }
//   active   — warm-up is currently capping this account
//   complete — enabled + past the final week (badge: "✓ warm-up complete")
//   week     — 1-based week (present whenever startedAt parses)
//   cap      — this week's per-day cap (only while active)
export function warmupStatus({ enabled, startedAt, now = new Date() } = {}) {
  const none = { active: false, complete: false, week: null, cap: null };
  if (!enabled) return none;
  const week = warmupWeek(startedAt, now);
  if (week === null) return none;
  if (week > WARMUP_WEEKS) return { active: false, complete: true, week, cap: null };
  return { active: true, complete: false, week, cap: WARMUP_SCHEDULE[week - 1] };
}

// The number the campaign loop should enforce for one profile.
// warmupStartedAt is null/undefined when warm-up is disabled for the profile.
export function effectiveDailyLimit({ configuredLimit, warmupStartedAt, now = new Date() }) {
  const configured = Number(configuredLimit);
  const st = warmupStatus({ enabled: Boolean(warmupStartedAt), startedAt: warmupStartedAt, now });
  if (!st.active) return configured;
  return Math.min(configured, st.cap);
}
