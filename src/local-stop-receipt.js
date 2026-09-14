// Acceptance is not shutdown confirmation. Keep independent evidence for the
// foreground loop, browser closure, and cancellation of future owned work.
export function localStopStatus(receipt, { generation, running }) {
  if (!receipt || receipt.generation !== generation) return null;
  const confirmed = !running && receipt.browsersClosed === true && receipt.tracking?.ok === true
    && !(receipt.unverifiedScopes?.length)
    && !(receipt.dependents || []).some(runner => runner.running || runner._stopReceipt?.browsersClosed !== true);
  return { stopConfirmed: confirmed, stopping: !confirmed,
    stopRequestedAt: receipt.requestedAt, tracking: receipt.tracking,
    browserShutdownConfirmed: receipt.browsersClosed === true,
    stopError: receipt.error || receipt.tracking?.error || (receipt.unverifiedScopes?.length
      ? `Shutdown still needs confirmation for: ${receipt.unverifiedScopes.join(', ')}` : '') };
}
