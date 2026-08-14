/**
 * One lane for every POST to the central Apps Script web app.
 *
 * Google enforces a per-spreadsheet limit on SIMULTANEOUS invocations that is
 * far tighter than the 1000-concurrent-executions quota its warning emails
 * talk about. Cross it and the bridge answers "Troppe chiamate simultanee:
 * Fogli di lavoro" — and, until 2026-08-12, that string matched none of the
 * transient-error patterns, so those writes were dropped without a retry.
 *
 * Five modules POST to that one endpoint — sheets-writer, soo-writer, soo,
 * sheets and drive-sync — from up to five parallel account workers plus the
 * cloud reconcile. Serialising inside any one of them fixes nothing, because
 * the limit counts executions per spreadsheet, not per module. So the lane
 * lives here and they all queue in it.
 *
 * It only orders the network hop. Retry backoff must happen OUTSIDE the lane
 * (call onWebappLane once per attempt, not once per retry loop), or a sleeping
 * attempt blocks every other caller for the length of its backoff.
 */

let _lane = Promise.resolve();

/**
 * Run `fn` when no other lane user is mid-flight. Returns whatever `fn`
 * returns; a rejection propagates to the caller and does NOT wedge the lane.
 */
export function onWebappLane(fn) {
  const out = _lane.then(fn, fn);
  _lane = out.then(() => {}, () => {});
  return out;
}

/**
 * The same discipline for the FG Apps Script — a SEPARATE deployment bound to
 * a different spreadsheet, so it needs its own lane rather than sharing the one
 * above (queueing FG reads behind campaign writes would help nobody).
 *
 * FG's constraint is a script lock rather than a quota: doPost serialises
 * writers with LockService, and fgState is a ~78s read, so two overlapping
 * calls means the second waits out waitLock() and dies with an HTML error page.
 * One lane per process removes the overlap this app causes itself. Same rule as
 * above: retry backoff belongs OUTSIDE the lane.
 */
let _fgLaneP = Promise.resolve();
export function onFgLane(fn) {
  const out = _fgLaneP.then(fn, fn);
  _fgLaneP = out.then(() => {}, () => {});
  return out;
}
