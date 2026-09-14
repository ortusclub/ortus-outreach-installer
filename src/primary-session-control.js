import { registerPrimaryOperation } from './primary-task-control.js';

// Own queue waits and unresolved launches, not only the eventual send primitive.
// During preparation no task is sending, so any affected owner can cancel this
// shared preparation. Other owners' tasks remain pending for the next idle run.
export async function preparePrimarySession(tasks, { semaphore, launch, close, prepare = async () => false, signal }) {
  const controller = new AbortController();
  let acquired = false, launched = false, launchStarted = false, closed, handedOff = false, closureConfirmed = false;
  const operations = [];
  let launchFinished;
  const launchDone = new Promise(resolve => { launchFinished = resolve; });
  const closeOnce = () => closed ||= Promise.resolve().then(close).then(result => {
    closureConfirmed = result?.browserClosed === true;
    if (closureConfirmed) signal?.removeEventListener('abort', externalAbort);
    if (closureConfirmed) operations.forEach(operation => operation.finish());
    if (result?.browserClosed !== true) closed = null;
    return result;
  }, error => { closed = null; throw error; });
  const cancel = async () => {
    controller.abort();
    await launchDone;
    if (launched) return closeOnce();
    if (!launchStarted) operations.forEach(operation => operation.finish());
    return { browserClosed: !launchStarted };
  };
  const owners = new Map(tasks.map(task => [JSON.stringify([task.campaignId, task.campaignRunId, !!task.sourceTaskId]), task]));
  operations.push(...[...owners.values()].map(task => registerPrimaryOperation({
    campaignId: task.campaignId, campaignRunId: task.campaignRunId, sourceTaskId: task.sourceTaskId,
  }, cancel)));
  const externalAbort = () => { cancel().catch(() => {}); };
  signal?.addEventListener('abort', externalAbort, { once: true });
  if (signal?.aborted) externalAbort();
  for (const operation of operations) operation.signal.addEventListener('abort', () => controller.abort(), { once: true });
  try {
    await semaphore.acquire({ signal: controller.signal });
    acquired = true;
    if (controller.signal.aborted) throw new Error('Primary preparation cancelled');
    launchStarted = true;
    const session = await launch({ signal: controller.signal });
    launched = true;
    launchFinished();
    if (controller.signal.aborted) throw new Error('Primary launch cancelled');
    const prepared = await prepare(session.page);
    if (controller.signal.aborted) throw new Error('Primary preparation cancelled');
    handedOff = true;
    return { ...session, prepared, close: closeOnce };
  } catch (error) {
    if (controller.signal.aborted) error.primaryPreparationCancelled = true;
    launchFinished();
    try { if (launched) await closeOnce(); }
    finally { if (acquired) semaphore.release(); }
    throw error;
  } finally {
    launchFinished();
    // Keep session ownership between preparation and dispatch, and after a
    // failed normal close. A later Stop must still find and retry that closer.
    if (!handedOff && (!launchStarted || closureConfirmed)) {
      signal?.removeEventListener('abort', externalAbort);
      operations.forEach(operation => operation.finish());
    }
  }
}
