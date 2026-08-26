export function terminalPresentation(status = {}) {
  const processed = Math.max(0, Number(status.totalProcessed) || 0);
  const total = Math.max(0, Number(status.totalTargets) || 0);
  const pending = status.pendingCount == null ? Math.max(0, total - processed) : Math.max(0, Number(status.pendingCount) || 0);
  const reason = String(status.endNotice?.reason || status.endReason || status.stopReason || '').toLowerCase();
  if (['error', 'errored', 'failed'].includes(reason)) return { label: 'Failed', activity: 'Failed', explanation: 'A system error ended the campaign.', pending, complete: false };
  if (reason.includes('interrupt') || reason.includes('timeout') || status.interrupted) return { label: 'Interrupted', activity: 'Recovery needed', explanation: 'The machine or campaign engine became unavailable before cleanup completed.', pending, complete: false };
  if (['operator_stopped', 'operator-stopped', 'stopped', 'cancelled'].includes(reason)) return { label: pending ? 'Stopped early' : 'Stopped', activity: pending ? `${pending} pending` : 'Stopped', explanation: pending ? 'The operator stopped the campaign before all actionable leads were processed.' : 'The operator stopped the campaign.', pending, complete: false };
  if (pending > 0 || reason === 'all_parked') return { label: 'Stopped early', activity: `${pending} pending`, explanation: 'The campaign ended with actionable leads remaining.', pending, complete: false };
  return { label: 'Finished', activity: 'Finished', explanation: 'No actionable leads remain.', pending: 0, complete: true };
}
