export const MONITORING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

function _toDate(d) {
  return d instanceof Date ? d : new Date(d);
}

export function computeMonitoringUntil(sendingEndedAt) {
  const s = _toDate(sendingEndedAt);
  return new Date(s.getTime() + MONITORING_WINDOW_MS);
}

/**
 * Returns the next cadence boundary strictly AFTER `now`, measured from
 * `sendingEndedAt`. If `now` lands exactly on a boundary, returns the next
 * one (strict >). `cadenceMin` defaults to 360 (6h) for backward compat.
 * IMPORTANT: callers MUST pass cadenceMin explicitly when honouring the
 * operator-configured cadence — relying on the default silently overrode
 * a 15-minute wizard setting in monitoring-resume.js prior to v2.14.x.
 */
export function recomputeNextCheckAt(sendingEndedAt, now, cadenceMin = 360) {
  const s = _toDate(sendingEndedAt).getTime();
  const n = _toDate(now).getTime();
  const elapsed = n - s;
  const intervalMs = cadenceMin * 60_000;
  const ticksPassed = Math.floor(elapsed / intervalMs) + 1;
  return new Date(s + ticksPassed * intervalMs);
}
