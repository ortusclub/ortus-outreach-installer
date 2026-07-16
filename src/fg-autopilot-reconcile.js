// Select Auto-Pilot run records that the local app hasn't reconciled yet. A run is
// reconcilable only once it has a perAccount map (dispatched successfully). Keyed by
// cloudId so reconcile stays idempotent across app restarts.
export function pickUnreconciled(serviceRuns, localReconciledCloudIds) {
  const done = localReconciledCloudIds instanceof Set ? localReconciledCloudIds : new Set(localReconciledCloudIds || []);
  return (serviceRuns || []).filter(
    (r) => r && r.cloudId && Array.isArray(r.perAccount) && r.perAccount.length && !done.has(r.cloudId),
  );
}
