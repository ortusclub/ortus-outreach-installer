import { stopTaskOwner, pauseTaskOwner, controlCloudTaskOwner } from './primary-tasks.js';

const active = new Set();
const matches = (a, b) => a?.campaignId && a?.campaignRunId
  && a.campaignId === b?.campaignId && a.campaignRunId === b?.campaignRunId;

export function registerPrimaryOperation(owner, close) {
  const controller = new AbortController();
  let done;
  const entry = { owner: { ...owner }, controller, close, didFinish: false, closureRequired: false, closureConfirmed: false,
    finished: new Promise(resolve => { done = resolve; }) };
  active.add(entry);
  return { signal: controller.signal, finish() {
    entry.didFinish = true;
    if (!entry.closureRequired || entry.closureConfirmed) active.delete(entry);
    done();
  } };
}

export async function stopPrimaryTasksForOwner(owner, { file, timeoutMs = 2000 } = {}) {
  if (!owner?.campaignId || !owner?.campaignRunId) throw new Error('Background task ownership is unavailable; stop cannot be confirmed');
  const mine = [...active].filter(entry => matches(entry.owner, owner));
  return interruptOperations(mine, () => stopTaskOwner(owner, file), timeoutMs);
}

export async function pausePrimaryTasksForOwner(owner, { file, timeoutMs = 2000 } = {}) {
  if (!owner?.campaignId || !owner?.campaignRunId) throw new Error('Pause ownership is unavailable');
  const mine = [...active].filter(entry => matches(entry.owner, owner));
  return interruptOperations(mine, () => pauseTaskOwner(owner, file), timeoutMs);
}

// Interrupt the current owned browser work without cancelling future tasks.
// Used by Stop sending + keep monitoring; no global profile-list kill.
export async function interruptPrimaryOperationsForOwner(owner, { timeoutMs = 2000 } = {}) {
  if (!owner?.campaignId || !owner?.campaignRunId) return { stopped: false, error: 'Campaign ownership is unavailable' };
  const mine = [...active].filter(entry => matches(entry.owner, owner));
  return interruptOperations(mine, async () => ({ inProgress: [] }), timeoutMs);
}

export async function stopCloudPrimaryTasks(campaignId, { pause = false, file, timeoutMs = 2000 } = {}) {
  if (!campaignId) throw new Error('Cloud campaign ID required');
  const mine = [...active].filter(entry => entry.owner.sourceTaskId && entry.owner.campaignId === campaignId);
  return interruptOperations(mine, () => controlCloudTaskOwner(campaignId, { pause }, file), timeoutMs);
}

async function interruptOperations(mine, persist, timeoutMs) {
  // Flip all signals before any await; close only the browser currently used
  // by this owner's task, never an unrelated task sharing the account later.
  const closing = mine.map(entry => {
    entry.closureRequired = true;
    entry.controller.abort();
    return Promise.resolve().then(() => entry.close()).then(result => {
      entry.closureConfirmed = result?.browserClosed === true;
      if (entry.didFinish && entry.closureConfirmed) active.delete(entry);
      return entry.closureConfirmed;
    }, () => false);
  });
  const result = await persist();
  let timer;
  try {
    const settled = await Promise.race([
      Promise.all([...closing, ...mine.map(entry => entry.finished.then(() => true))])
        .then(values => values.every(Boolean)),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
    // A persisted in-progress task with no registered operation could belong
    // to an earlier process. Do not label that uncertain task stopped.
    const unresolved = result.inProgress.filter(id => !mine.some(entry => entry.owner.taskId === id));
    return { ...result, stopped: settled && unresolved.length === 0, unresolved };
  } finally { clearTimeout(timer); }
}
