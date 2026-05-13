/**
 * Returns true exactly when:
 *   - every account's lead queue is empty
 *   - no requests are in flight
 *   - AND at least one account has sent ≥1 connection request
 *     (a campaign that processed zero leads is "skipped", not "end-of-list")
 */
export function isEndOfList(state) {
  const queues = state.queuesByProfile || {};
  for (const k of Object.keys(queues)) {
    if (queues[k] && queues[k].length > 0) return false;
  }
  if (state.inFlight && state.inFlight.size > 0) return false;
  const counts = state.connectionSentCount || {};
  let total = 0;
  for (const k of Object.keys(counts)) total += counts[k] || 0;
  return total > 0;
}
