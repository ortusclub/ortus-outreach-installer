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
  const recomputedNextCheckAt = recomputeNextCheckAt(campaign.sendingEndedAt, now);
  return { action: 'resume', recomputedNextCheckAt };
}
