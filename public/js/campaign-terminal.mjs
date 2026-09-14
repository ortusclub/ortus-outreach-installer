// Decide what a non-running campaign means. "Finished" is reserved for a run
// that actually exhausted its target set; an ended process with work remaining
// is stopped early even when the backend exited cleanly.
export function terminalPresentation(status = {}) {
  const processed = Math.max(0, Number(status.totalProcessed) || 0);
  const total = Math.max(0, Number(status.totalTargets) || 0);
  const pending = status.pendingCount == null
    ? Math.max(0, total - processed)
    : Math.max(0, Number(status.pendingCount) || 0);
  const reason = String(status.endNotice?.reason || status.endReason || '').toLowerCase();

  if (reason === 'error' || reason === 'errored') {
    return { label: 'Failed', activity: 'Failed', pending, complete: false };
  }
  if (reason === 'operator_stopped' || reason === 'stopped') {
    return { label: 'Stopped', activity: 'Stopped', pending, complete: false };
  }
  if (pending > 0 || reason === 'all_parked') {
    return { label: 'Stopped early', activity: `${pending} pending`, pending, complete: false };
  }
  return { label: 'Finished', activity: 'Finished', pending: 0, complete: true };
}
