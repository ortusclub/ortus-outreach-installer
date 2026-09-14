import { AsyncLocalStorage } from 'node:async_hooks';

// Serializes foreground preparation, not workers inside a campaign. A request
// owns its reservation through asynchronous preflight; Stop invalidates it.
export function createStartupAdmission() {
  const context = new AsyncLocalStorage();
  let ready = true, closing = false, active = null;
  const assertCurrent = () => {
    const mine = context.getStore();
    if (closing || !ready || mine?.cancelled || (active && active !== mine)) {
      const error = new Error(closing ? 'App is closing' : !ready ? 'App is still restoring saved state' : mine?.cancelled ? 'Startup was cancelled; start again explicitly' : 'Another operation is preparing to start');
      error.code = 'STARTUP_NOT_ADMITTED'; throw error;
    }
  };
  return {
    assertCurrent,
    state() { return closing ? 'closing' : !ready ? 'restoring' : 'ready'; },
    assertRuntimeReady() {
      if (closing || !ready) throw new Error(closing ? 'App is closing; no new browser may launch' : 'App is still restoring saved state');
    },
    available() { try { assertCurrent(); return true; } catch { return false; } },
    setReady(value) { ready = !!value; },
    cancel() { if (active) active.cancelled = true; },
    close() { closing = true; if (active) active.cancelled = true; },
    enter(fn) {
      assertCurrent();
      if (active) {
        const mine = context.getStore();
        if (active !== mine) throw new Error('Startup reservation is already held');
        return fn(() => {}); // Only this reservation may nest into its own queue drain.
      }
      const ticket = { cancelled: false }; active = ticket;
      const release = () => { if (active === ticket) active = null; };
      try { return context.run(ticket, () => fn(release)); }
      catch (error) { release(); throw error; }
    },
  };
}
export const startupAdmission = createStartupAdmission();
