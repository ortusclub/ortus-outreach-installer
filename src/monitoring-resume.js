import { recomputeNextCheckAt } from './monitoring-time.js';
import { checkCadenceMin } from './monitoring-cadence.js';

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
  // v2.14.x honored checkIntervalMinutes here; this also honors a restored
  // emptyCheckStreak (finding 3, code review), same as the engine's
  // nextMonitorDecision (campaign-monitor.js:383) — otherwise every boot and
  // laptop wake snaps a quiet campaign back to hourly for a cycle.
  const cadenceMin = checkCadenceMin({
    baseMin: campaign.checkIntervalMinutes || 60,
    emptyStreak: campaign.emptyCheckStreak,
  });
  const recomputedNextCheckAt = recomputeNextCheckAt(campaign.sendingEndedAt, now, cadenceMin);
  return { action: 'resume', recomputedNextCheckAt };
}
