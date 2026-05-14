import { isTestModeOn } from './test-mode.js';

export const MONITORING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const PROD_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const TEST_CHECK_INTERVAL_MS = 60_000;

// Backward-compat for any caller that imports the constant by name (e.g. tests).
// New callers should use getCheckIntervalMs().
export const CHECK_INTERVAL_MS = PROD_CHECK_INTERVAL_MS;

export function getCheckIntervalMs() {
  return isTestModeOn() ? TEST_CHECK_INTERVAL_MS : PROD_CHECK_INTERVAL_MS;
}

function _toDate(d) {
  return d instanceof Date ? d : new Date(d);
}

export function computeMonitoringUntil(sendingEndedAt) {
  const s = _toDate(sendingEndedAt);
  return new Date(s.getTime() + MONITORING_WINDOW_MS);
}

/**
 * Returns the next 6h check boundary strictly AFTER `now`, measured from
 * `sendingEndedAt`. If `now` lands exactly on a boundary, returns the next
 * one (strict >).
 */
export function recomputeNextCheckAt(sendingEndedAt, now) {
  const s = _toDate(sendingEndedAt).getTime();
  const n = _toDate(now).getTime();
  const elapsed = n - s;
  const ticksPassed = Math.floor(elapsed / CHECK_INTERVAL_MS) + 1;
  return new Date(s + ticksPassed * CHECK_INTERVAL_MS);
}
