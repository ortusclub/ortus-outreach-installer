// The adaptive acceptance-check cadence, local half.
//
// Ported from the engine's campaign-monitor.js (checkCadenceMin / nextEmptyStreak)
// so a campaign moved onto the operator's Mac keeps the same behaviour. Kept as a
// separate module, not inlined into campaign.js, so the two implementations can be
// diffed against each other: every cloud bug this project has had was a divergence
// between a local primitive and its VM copy.
//
// Checks cost a real LinkedIn login on every account, and on a quiet campaign
// almost all of them find nothing. So: base interval below 3 consecutive empty
// sweeps, doubled at 3-5, quadrupled at 6+, and any acceptance resets it.

export const CHECK_CADENCE_CAP_MIN = 240;

export function checkCadenceMin({ baseMin, emptyStreak } = {}) {
  const base = Number(baseMin) > 0 ? Number(baseMin) : 60;
  const n = Math.max(0, Number(emptyStreak) || 0);
  const factor = n >= 6 ? 4 : n >= 3 ? 2 : 1;
  if (factor === 1) return base;
  // Math.max, not Math.min alone: the cap must never return a cadence SHORTER
  // than the operator's own interval. A 6h campaign checked every 4h for going
  // quiet is the opposite of the intent.
  return Math.max(base, Math.min(base * factor, CHECK_CADENCE_CAP_MIN));
}

export function nextEmptyStreak({ newlyAccepted = 0, current = 0 } = {}) {
  if ((Number(newlyAccepted) || 0) > 0) return 0;
  return Math.max(0, Number(current) || 0) + 1;
}

// Reduces runMonitoringCheckAll()'s per-account results into what
// nextEmptyStreak needs. Pulled out of tickMonitoringNow so the aggregation
// is unit-testable without a browser (see tests/monitoring-cadence.test.js).
//
// Two things a naive `results.reduce((s, r) => s + r.matched, 0)` gets wrong:
//   - `looked`: a result is only a genuine "checked and found nobody" when
//     `r.ok && !r.error`. `ok:false` is launch failure / needs-login / abort;
//     `ok:true` with `error` set is bulkCheckConnections failing mid-flight
//     (session-expired, sheet-fetch, batch-update) while still returning
//     ok:true. Either way nothing was actually looked at, so the streak must
//     not advance — a campaign whose accounts all need re-login must not
//     silently stretch to 4h with nothing flagged.
//   - `newlyAccepted`: sums `freshConnected`, not `matched`. `matched` also
//     counts pre-existing 1st-degree connections re-queued for a retried
//     intro (stamped 'Already connected', not new) — see
//     tests/bulk-check-fresh-count.test.js. Using `matched` would let those
//     re-queues reset the streak every sweep, same as if nobody ever slowed.
export function summarizeMonitoringSweep(results = []) {
  const looked = (Array.isArray(results) ? results : []).filter((r) => r && r.ok && !r.error);
  const newlyAccepted = looked.reduce((sum, r) => sum + (Number(r.freshConnected) || 0), 0);
  return { looked: looked.length > 0 || newlyAccepted > 0, newlyAccepted };
}
