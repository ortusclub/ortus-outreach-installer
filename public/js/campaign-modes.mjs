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

// RETIRED modes — removed from the product, local AND cloud (operator decision,
// 2026-08-06). They had been greyed "Unavailable" in the picker for a while;
// this makes it structural instead of cosmetic.
//
// Why these two: docs/HANDOFF-message-modes-on-vm.md lists six gaps across the
// message-sending modes. Steven's engine PR #4 closed gaps 1-3 for
// `open_profile_only` (Message Campaign) ONLY and explicitly left these two
// alone — so on the VM they still have no re-send guard: a re-launch on a sheet
// where rows already read "DM Sent" would message every one of them again.
//
// NOT deleted from the engine or from src/linkedin/*: `connect_and_message` and
// `introduce_back` reuse the same send primitives, so ripping them out would
// break two modes that are very much alive. Retiring is a launch-path decision,
// not a code deletion. Existing history/board rows keep their labels.
// `check_status` is retired as a standalone CAMPAIGN TYPE only. The acceptance
// sweep itself is untouched and still runs everywhere it mattered: the idle
// bulk-check inside CC+IC / CC+DM, the "Run check now" button (dashBulkCheck →
// /api/bulk-check-*, which never launched a check_status campaign), and the
// cloud monitor sweep. Only the wizard card goes.
export const RETIRED_MODES = new Set([
  'message_only',   // wizard: "Direct Messages"
  'inmail_only',    // wizard: "InMail Only"
  'check_status',   // wizard: "Check Status" — the sweep lives on, the card doesn't
]);

export function isRetiredMode(mode) {
  return RETIRED_MODES.has(String(mode || ''));
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
