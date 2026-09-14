// A cold reload has no cached account list. Recognize the native runner's
// ended execution from its own snapshot, without changing live/recovery phases.
export function normalizeTerminalStatus(status) {
  if (!status || status.running || status.paused || status.pauseRequested
      || status.interrupted || status.waitingForLocal || status.queued
      || status.monitoringCheckInProgress || status.phase === 'preflight') return status;
  if (status.state !== 'idle' || status._cloud
      || !['legacy-singleton', 'local-active'].includes(status.id)) return status;
  if (!status.executionId || !Array.isArray(status.logs) || !status.logs.length) return status;
  return { ...status, state: 'done' };
}

export function terminalPresentation(status = {}) {
  const processed = Math.max(0, Number(status.totalProcessed) || 0);
  const total = Math.max(0, Number(status.totalTargets) || 0);
  const pending = status.pendingCount == null ? Math.max(0, total - processed) : Math.max(0, Number(status.pendingCount) || 0);
  const explicit = String(status.endReason || status.stopReason || '').toLowerCase();
  const reason = ['stopped', 'cancelled', 'errored', 'failed', 'interrupted'].includes(explicit)
    ? explicit : String(status.endNotice?.reason || explicit).toLowerCase();
  if (['operator_stopped', 'operator-stopped', 'stopped', 'cancelled'].includes(reason)) return { label: pending ? 'Stopped early' : 'Stopped', activity: pending ? `${pending} pending` : 'Stopped', explanation: pending ? 'The operator stopped the campaign before all actionable leads were processed.' : 'The operator stopped the campaign.', pending, complete: false };
  if (['error', 'errored', 'failed'].includes(reason)) return { label: 'Failed', activity: 'Failed', explanation: 'A system error ended the campaign.', pending, complete: false };
  if (status.needsOutcomeReview || status.endReason === 'needs_review') return { label: 'Needs verification', activity: 'Outcome unresolved', explanation: 'At least one attempted action needs verification. Do not resend an uncertain invitation.', pending, complete: false };
  if (reason === 'all_parked' || status.endReason === 'blocked') return { label: 'Blocked', activity: 'Accounts unavailable', explanation: status.endNotice?.detail || 'Accounts could not continue. Review login or limit recovery before resuming.', pending, complete: false };
  if (['error', 'errored', 'failed'].includes(reason)) return { label: 'Failed', activity: 'Failed', explanation: 'A system error ended the campaign.', pending, complete: false };
  if (reason.includes('interrupt') || reason.includes('timeout') || status.interrupted) return { label: 'Interrupted', activity: 'Recovery needed', explanation: 'The machine or campaign engine became unavailable before cleanup completed.', pending, complete: false };
  if (['operator_stopped', 'operator-stopped', 'stopped', 'cancelled'].includes(reason)) return { label: pending ? 'Stopped early' : 'Stopped', activity: pending ? `${pending} pending` : 'Stopped', explanation: pending ? 'The operator stopped the campaign before all actionable leads were processed.' : 'The operator stopped the campaign.', pending, complete: false };
  if (pending > 0 || reason === 'all_parked') return { label: 'Stopped early', activity: `${pending} pending`, explanation: 'The campaign ended with actionable leads remaining.', pending, complete: false };
  if (status.totalKnown === false) return { label: 'Review result', activity: 'Total unavailable', explanation: 'The original eligible total was not recorded. Completion cannot be certified from the processed count alone.', pending, complete: false };
  return { label: 'Finished', activity: 'Finished', explanation: 'No actionable leads remain.', pending: 0, complete: true };
}
