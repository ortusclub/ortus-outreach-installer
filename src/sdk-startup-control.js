// GoLogin does not accept AbortSignal. Guard the SDK's prepare -> spawn
// boundary and retain ownership of children produced by an in-flight spawn.
import requestPolicy from './gologin-request-policy.cjs';
export function guardSdkStartup(sdk, { signal, onSpawn = () => {}, kill = child => child?.kill('SIGKILL') } = {}) {
  const requestController = new AbortController();
  let cancelled = false, spawnEntered = false, settled = false, child = sdk.processSpawned;
  let reason;
  const stopChild = () => { if (child) { try { kill(child); } catch { /* caller must verify exit */ } } };
  const cancel = error => {
    cancelled = true;
    reason = error instanceof Error ? error : new Error('GoLogin startup cancelled');
    requestController.abort(reason);
    stopChild();
  };
  const spawn = sdk.spawnBrowser;
  if (typeof spawn !== 'function') throw new Error('GoLogin SDK spawn boundary is unavailable; refusing an uncancellable launch');
  sdk.spawnBrowser = async function (...args) {
    if (cancelled || signal?.aborted) throw reason || new Error('GoLogin startup cancelled before browser spawn');
    spawnEntered = true;
    const result = await spawn.apply(this, args);
    if (cancelled || signal?.aborted) { stopChild(); throw reason || new Error('GoLogin startup cancelled'); }
    return result;
  };
  Object.defineProperty(sdk, 'processSpawned', {
    configurable: true, enumerable: true,
    get: () => child,
    set(value) { child = value; if (value) onSpawn(value); if (cancelled || signal?.aborted) stopChild(); },
  });
  const onAbort = () => cancel(signal.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  let rejectCancel;
  const cancellation = new Promise((_, reject) => { rejectCancel = reject; });
  const originalCancel = cancel;
  const cancelAndReject = error => { originalCancel(error); rejectCancel(reason); };
  const rejectOnAbort = () => cancelAndReject(signal.reason);
  signal?.addEventListener('abort', rejectOnAbort, { once: true });
  const source = Promise.resolve().then(() => {
    if (cancelled) throw reason;
    return requestPolicy.withRequestContext({ signal: requestController.signal, token: sdk.access_token }, () => sdk.start());
  }).finally(() => { settled = true; if (cancelled) stopChild(); });
  // Start cancellation is observed even when the caller has already returned.
  const promise = Promise.race([source, cancellation]);
  return {
    promise, source, cancel: cancelAndReject,
    get settled() { return settled; },
    async close(confirm) {
      cancelAndReject(new Error('GoLogin startup closed'));
      if (!spawnEntered) return { browserClosed: true, spawnPrevented: true };
      if (child) return confirm(child);
      return { browserClosed: settled };
    },
    detach() { signal?.removeEventListener('abort', onAbort); signal?.removeEventListener('abort', rejectOnAbort); },
  };
}
