const TERMINAL = new Set(['done', 'cancelled', 'error']);

// Canonical lifecycle projection shared by local and VM presentation code.
// Unknown states remain visible as `needsReview` instead of being silently
// rendered as finished; the suggested action tells the operator what to do.
export function normalizeLifecycle(value = {}) {
  const raw = String(value.state || value.status || value.bucket || '').toLowerCase();
  const state = value.stopping ? 'stopping'
    : value.monitoring || value.monitoringPhase ? 'monitoring'
    : raw || 'unknown';
  const known = ['draft', 'queued', 'running', 'pausing', 'paused', 'stopping', 'monitoring', 'interrupted', 'done', 'cancelled', 'error'].includes(state);
  return {
    id: value.id || null,
    executionId: value.executionId || value.runId || null,
    revision: Number(value.revision || 0),
    state,
    terminal: TERMINAL.has(state),
    needsReview: !known || state === 'interrupted' || state === 'error',
    reviewAction: !known ? 'Refresh status; if it remains unknown, use Resolve.'
      : state === 'interrupted' ? 'Choose Resume here or Stop here.'
      : state === 'error' ? 'Open the run log, fix the named issue, then Retry.'
      : '',
  };
}
