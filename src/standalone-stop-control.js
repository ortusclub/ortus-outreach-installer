import { interruptPrimaryOperationsForOwner } from './primary-task-control.js';
import { localStopStatus } from './local-stop-receipt.js';

export function requestStandaloneStop(runner, deps = {}) {
  if (!runner.running && !runner.taskOwner && !runner._stopReceipt) return { ok: true, stopConfirmed: true, stopping: false, nothingRunning: true };
  runner._abort = true;
  runner._abortController?.abort();
  const receipt = { generation: runner.startedAt, requestedAt: Date.now(), browsersClosed: false, tracking: { ok: true } };
  runner._stopReceipt = receipt;
  receipt.done = (deps.interrupt || interruptPrimaryOperationsForOwner)(runner.taskOwner).then(result => {
    receipt.browsersClosed = result.stopped === true;
    receipt.error = result.error || '';
    return receipt.browsersClosed;
  }, error => { receipt.error = error.message; return false; });
  return { ok: false, accepted: true, stopConfirmed: false, stopping: true };
}

export function standaloneStopStatus(runner) {
  return localStopStatus(runner._stopReceipt, { generation: runner.startedAt, running: runner.running }) || {};
}
