export const DEFAULT_STOP_GRACE_MS = 20_000;

// A campaign stop is cooperative: the worker must return from its current await
// before it can observe `_abort`. This watchdog is the hard boundary. If the
// worker is still live after the grace period, the caller can restart the host
// process so no abandoned promise can mutate the next campaign's singleton.
export function createStopWatchdog({
  isRunning,
  onStuck,
  graceMs = DEFAULT_STOP_GRACE_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (typeof isRunning !== 'function') throw new TypeError('isRunning is required');
  if (typeof onStuck !== 'function') throw new TypeError('onStuck is required');

  let timer = null;
  let requestedAt = null;
  let activeKey = null;

  function cancel() {
    if (timer !== null) clearTimer(timer);
    timer = null;
    requestedAt = null;
    activeKey = null;
  }

  function arm(context = {}) {
    // Repeated Stop clicks must not keep moving the hard deadline away.
    // A different campaign generation, however, must replace a leftover timer
    // from a prior run that happened to finish gracefully just before this one.
    const key = context.generation ?? context.key ?? null;
    if (timer !== null && key === activeKey) return { armed: false, requestedAt, graceMs };
    if (timer !== null) cancel();
    requestedAt = Date.now();
    activeKey = key;
    timer = setTimer(async () => {
      timer = null;
      if (!isRunning(context)) { requestedAt = null; activeKey = null; return; }
      await onStuck({ ...context, requestedAt, graceMs });
    }, graceMs);
    timer?.unref?.();
    return { armed: true, requestedAt, graceMs };
  }

  function status() {
    return {
      armed: timer !== null,
      requestedAt,
      deadlineAt: requestedAt == null ? null : requestedAt + graceMs,
      graceMs,
    };
  }

  return { arm, cancel, status };
}
