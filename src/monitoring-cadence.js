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
