// Only inspect/terminate the child handle supplied by this app's launcher.
// A sent signal (`killed`) or a disconnected CDP socket is not exit evidence.
export async function confirmOwnedProcessExit(child, {
  probe = pid => process.kill(pid, 0), timeoutMs = 1500, forceAfterMs = 250, pollMs = 25,
} = {}) {
  if (!Number.isInteger(child?.pid) || child.pid <= 0) return { browserClosed: false };
  const started = Date.now();
  let forced = false;
  do {
    if (child.exitCode != null || child.signalCode != null) return { browserClosed: true };
    try { probe(child.pid); }
    catch (error) { return { browserClosed: error?.code === 'ESRCH' }; }
    if (!forced && Date.now() - started >= forceAfterMs) {
      forced = true;
      try { child.kill('SIGKILL'); } catch (_) { /* must still prove exit */ }
    }
    await new Promise(resolve => setTimeout(resolve, pollMs));
  } while (Date.now() - started < timeoutMs);
  return { browserClosed: false };
}
