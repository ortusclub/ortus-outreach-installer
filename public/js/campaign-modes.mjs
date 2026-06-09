// Campaign-mode predicates — single source of truth shared by the wizard UI
// and the launch payload builder so mode-dependent behaviour can't drift.

// Modes that send a connection request and then MONITOR for acceptance on a
// cadence, auto-firing a follow-up once a lead connects:
//   - connect_and_introduce (CC+IC) → fires the 3-way intro DM
//   - connect_and_message   (CC+DM) → fires the post-acceptance DM
// These are the ONLY modes that expose the "check cadence" control, and they
// are the ONLY modes whose launch payload should carry checkIntervalMinutes.
// Keeping both behaviours behind this one predicate prevents the regression
// where the dropdown was shown for CC+DM but its value was silently dropped.
const MONITORING_CADENCE_MODES = new Set([
  'connect_and_introduce',
  'connect_and_message',
]);

export function usesMonitoringCadence(mode) {
  return MONITORING_CADENCE_MODES.has(mode);
}

// Cadence bounds — single source of truth for the wizard dropdown, the server
// intake clamp, and the engine backstop. The dropdown's smallest/largest
// options MUST equal these (see public/index.html #check-cadence-select).
// Min == 60 means "the picker never offers a value the engine won't honor."
export const MIN_CADENCE_MINUTES = 60;   // 1 hour
export const MAX_CADENCE_MINUTES = 720;  // 12 hours

// Clamp a raw cadence (minutes) into [MIN, MAX]. Non-numeric / missing → MIN.
export function clampCadenceMinutes(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return MIN_CADENCE_MINUTES;
  return Math.max(MIN_CADENCE_MINUTES, Math.min(MAX_CADENCE_MINUTES, n));
}
