import { pausePrimaryTasksForOwner } from './primary-task-control.js';
import { resumeTaskOwner } from './primary-tasks.js';

// Initiate cancellation synchronously; a receipt, not the click, authorizes Resume.
export function requestLocalPause({ owner, controller, hold, drained }, deps = {}) {
  const receipt = { confirmed: false, pending: true, owner: { ...owner }, commandId: null, error: '' };
  controller?.abort(new DOMException('Campaign paused', 'AbortError'));
  receipt.done = (async () => {
    try {
      const [control] = await Promise.all([
        (deps.pause || pausePrimaryTasksForOwner)(owner), hold(),
      ]);
      receipt.commandId = control.commandId;
      if (!control.stopped) throw new Error('Browser or task shutdown remains unconfirmed');
      if (!(await drained())) throw new Error('Foreground work is still settling; Pause is not yet confirmed');
      receipt.confirmed = true;
    } catch (error) { receipt.error = error.message; }
    finally { receipt.pending = false; }
    return receipt.confirmed;
  })();
  return receipt;
}

export async function releaseLocalPause(receipt, isCurrent, deps = {}) {
  if (!receipt?.confirmed || !isCurrent()) return false;
  const released = await (deps.resume || resumeTaskOwner)(receipt.owner, receipt.commandId);
  return released && isCurrent();
}
