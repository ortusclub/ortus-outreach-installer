export const DEFAULT_STOP_GRACE_MS = 15_000;

export function createStopWatchdog({ isRunning, onStuck, graceMs = DEFAULT_STOP_GRACE_MS,
  setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now } = {}) {
  if (typeof isRunning !== 'function') throw new TypeError('isRunning is required');
  if (typeof onStuck !== 'function') throw new TypeError('onStuck is required');
  let timer = null, requestedAt = null, activeKey = null;
  function cancel() { if (timer !== null) clearTimer(timer); timer = null; requestedAt = null; activeKey = null; }
  function arm(context = {}) {
    const key = context.generation ?? context.key ?? null;
    if (timer !== null && key === activeKey) return { armed: false, requestedAt, deadlineAt: requestedAt + graceMs, graceMs };
    if (timer !== null) cancel();
    requestedAt = now(); activeKey = key;
    timer = setTimer(async () => {
      timer = null;
      if (!isRunning(context)) { requestedAt = null; activeKey = null; return; }
      await onStuck({ ...context, requestedAt, graceMs });
    }, graceMs);
    timer?.unref?.();
    return { armed: true, requestedAt, deadlineAt: requestedAt + graceMs, graceMs };
  }
  function status() { return { armed: timer !== null, requestedAt, deadlineAt: requestedAt == null ? null : requestedAt + graceMs, graceMs }; }
  return { arm, cancel, status };
}
