import { recomputeNextCheckAt } from './monitoring-time.js';

/**
 * Pure helper. Given a hydrated campaign and "now", decides what to do
 * with respect to its Monitoring phase.
 *
 * Returns one of:
 *   { action: 'noop' }                            — campaign isn't in monitoring state
 *   { action: 'expire' }                          — monitoringUntil <= now
 *   { action: 'resume', recomputedNextCheckAt }   — still inside the window
 */
export function decideResumeAction(campaign, now) {
  if (!campaign || campaign.state !== 'monitoring') return { action: 'noop' };
  const until = new Date(campaign.monitoringUntil).getTime();
  const t = new Date(now).getTime();
  if (until <= t) return { action: 'expire' };
  // v2.14.x: honor the operator-configured cadence. Without explicitly
  // passing it, recomputeNextCheckAt falls back to its 360-minute (6 h)
  // default — which silently overrode a 15/30/60-minute wizard setting
  // every time monitoring rehydrated from disk (boot, laptop wake). Smoking
  // gun in live log 2026-05-15 13:15:39Z: "Monitoring resumed · next check
  // at 20:27" (6 h after sendingEndedAt) instead of the configured 15 min.
  const cadenceMin = campaign.checkIntervalMinutes || 60;
  const recomputedNextCheckAt = recomputeNextCheckAt(campaign.sendingEndedAt, now, cadenceMin);
  return { action: 'resume', recomputedNextCheckAt };
}
