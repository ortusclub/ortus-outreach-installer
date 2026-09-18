// Owns only browser launches requested by the manual "Open GoLogin profile"
// button. Campaign-owned launches are never entered in this map.
export function createManualProfileOpenControl({ resolve, getPid, focus, launch, unhide, close }) {
  const openings = new Map();

  async function open(ref) {
    const key = String(ref || '');
    if (!key) throw new Error('profileId required');
    if (openings.has(key)) throw new Error('GoLogin profile launch is already in progress');
    const entry = { controller: new AbortController(), startedNew: false, closed: true, existing: false };
    openings.set(key, entry);
    entry.promise = (async () => {
      try {
        const profileId = await resolve(key);
        if (!profileId) throw new Error(`No exact GoLogin profile matches ${key}`);
        entry.profileId = profileId;
        if (entry.controller.signal.aborted) throw new Error('Profile opening cancelled');
        const existingPid = getPid(profileId);
        if (existingPid) {
          entry.existing = true;
          await focus(profileId);
          return { ok: true, action: 'focused-existing', pid: existingPid };
        }
        await launch(profileId, entry.controller.signal, () => { entry.startedNew = true; });
        if (entry.controller.signal.aborted) throw new Error('Profile opening cancelled');
        const pid = getPid(profileId);
        if (pid) await unhide(pid);
        if (entry.controller.signal.aborted) throw new Error('Profile opening cancelled');
        return { ok: true, action: 'launched', pid };
      } catch (error) {
        if (entry.controller.signal.aborted) {
          if (entry.startedNew) {
            try {
              const evidence = await close(entry.profileId);
              entry.closed = evidence?.browserClosed === true;
            } catch {
              entry.closed = false;
            }
          }
          const cancelled = new Error(entry.closed
            ? 'Profile opening cancelled'
            : 'Stop requested, but browser shutdown is not confirmed');
          cancelled.cancelled = true;
          cancelled.browserClosed = entry.closed;
          throw cancelled;
        }
        throw error;
      } finally {
        if (openings.get(key) === entry) openings.delete(key);
      }
    })();
    return entry.promise;
  }

  async function cancel(ref) {
    const entry = openings.get(String(ref || ''));
    if (!entry) return { ok: false, pending: false, error: 'No manual profile opening is in progress' };
    if (entry.existing) {
      await entry.promise.catch(() => {});
      return { ok: false, alreadyOpen: true, error: 'This profile was already open; nothing was closed' };
    }
    entry.controller.abort(new Error('Profile opening cancelled by operator'));
    await entry.promise.catch(() => {});
    return entry.closed
      ? { ok: true, cancelled: true, browserClosed: true }
      : { ok: false, pending: true, browserClosed: false, error: 'Stop requested, but browser shutdown is not confirmed' };
  }

  return { open, cancel };
}
