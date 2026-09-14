// Single-flight job manager for the Path A cloud handshake.
//
// The handshake drives the local browser + GoLogin senders serially, so only ONE
// runs at a time. The client POSTs to start it and polls the status endpoint for
// live per-sender progress (the wizard). This module owns that singleton state so
// the server routes stay thin and the logic is unit-testable (inject `run`).

import { runCloudPreflightHandshake } from './cloud-preflight-handshake.js';

let _job = null; // { senders:Map<id,{profileId,state,name}>, done, summary, error, lines, controller }
const unsettled = new Set();

// Keep the handshake's own narration. runCloudPreflightHandshake takes a `log`
// and this module never passed one, so it defaulted to `() => {}` — the entire
// Path A handshake ran SILENTLY: nothing in the console, nothing in the campaign
// log, nothing in the wizard. When an operator asked "did all four senders
// actually send a request to the primary?" there was no record to answer from
// (2026-08-06); the only trace was data/primary-status.json, written at the end.
// Mirror every line to the console AND keep the last N for the status endpoint.
const MAX_LINES = 200;

// Overall watchdog ends the UI wait and requests cancellation. A hung run
// retains admission: a timeout alone is not evidence that its browser stopped.
const MAX_MS = 8 * 60 * 1000;

/** Current job snapshot for the status endpoint. The final summary (if present)
 *  is authoritative — overlay it so the last poll shows real per-sender states
 *  even for senders that never streamed progress (already-connected path). */
export function getHandshakeJob() {
  if (!_job) return { active: false };
  let senders = [..._job.senders.values()];
  if (_job.summary && Array.isArray(_job.summary.senders)) {
    const byId = new Map(senders.map((s) => [s.profileId, s]));
    for (const fs of _job.summary.senders) {
      const cur = byId.get(fs.profileId) || { profileId: fs.profileId, state: 'pending', name: '' };
      byId.set(fs.profileId, {
        profileId: fs.profileId,
        state: fs.state || cur.state,
        name: fs.name || cur.name,
        reason: fs.reason || cur.reason || '',
        attempt: Number(fs.attempt) || cur.attempt || 0,
        maxAttempts: Number(fs.maxAttempts) || cur.maxAttempts || 0,
        deadlineAt: Number(fs.deadlineAt) || cur.deadlineAt || 0,
      });
    }
    senders = [...byId.values()];
  }
  return { active: true, done: _job.done, stopping: _job.done && unsettled.has(_job), error: _job.error, summary: _job.summary, senders, lines: _job.lines.slice() };
}

/** Reset (tests / after the client consumes a finished job). */
export function resetHandshakeJob() {
  if (_job && !_job.done) {
    try { _job.controller?.abort(new Error('Handshake reset')); } catch { /* */ }
  }
  _job = null;
}

/** Stop the real browser work, not just the wizard that is displaying it. */
export function cancelHandshakeJob(reason = 'Handshake cancelled — no campaign was dispatched.') {
  if (!_job || _job.done) return { ok: true, cancelled: false };
  const job = _job;
  try { job.controller?.abort(new Error(reason)); } catch { /* */ }
  job.error = reason;
  job.done = true;
  const line = `[handshake] STOP REQUESTED — ${reason} Waiting for browser work to settle.`;
  try { console.log(line); } catch { /* */ }
  job.lines.push(line);
  if (job.lines.length > MAX_LINES) job.lines.splice(0, job.lines.length - MAX_LINES);
  return { ok: true, cancelled: true };
}

/**
 * Validate + start a handshake. Returns `{ ok, status, ... }` for the route to
 * relay. Fire-and-forget: progress lands in the singleton, polled via
 * getHandshakeJob(). `run` is injectable for tests.
 */
export function startHandshakeJob(body = {}, { run = runCloudPreflightHandshake, maxMs = MAX_MS } = {}) {
  const senderProfileIds = Array.isArray(body.senderProfileIds)
    ? body.senderProfileIds.filter(Boolean) : [];
  if (!senderProfileIds.length) return { ok: false, status: 400, error: 'senderProfileIds required' };
  if (!body.primaryUrl) return { ok: false, status: 400, error: 'primaryUrl required' };
  if (unsettled.size || (_job && !_job.done)) return { ok: false, status: 409, error: 'a handshake is already running or still stopping' };

  const senders = new Map(senderProfileIds.map((id) => [id, {
    profileId: id, state: 'pending', name: '', reason: '', attempt: 0, maxAttempts: 2, deadlineAt: 0,
  }]));
  const controller = new AbortController();
  _job = { senders, done: false, summary: null, error: null, lines: [], controller };
  const job = _job;
  unsettled.add(job);

  const log = (msg) => {
    if (_job !== job || job.done) return;
    const line = `[handshake] ${msg}`;
    try { console.log(line); } catch { /* */ }
    if (job.lines) {
      job.lines.push(line);
      if (job.lines.length > MAX_LINES) job.lines.splice(0, job.lines.length - MAX_LINES);
    }
  };
  log(`starting — ${senderProfileIds.length} sender(s) → ${body.primaryUrl}${body.autoAcceptAllPending ? ' (accept-all sweep on)' : ''}`);

  const onProgress = (evt) => {
    if (_job !== job || job.done || !evt || !senders.has(evt.profileId)) return;
    const cur = job.senders.get(evt.profileId);
    const next = {
      profileId: evt.profileId,
      state: evt.state || cur.state,
      name: evt.name || cur.name,
      // Why this sender is where it is — carried through so the wizard can say
      // "logged out" instead of blaming the primary for not accepting an
      // invitation that was never sent.
      reason: evt.reason || cur.reason || '',
      attempt: Number(evt.attempt) || cur.attempt || 0,
      maxAttempts: Number(evt.maxAttempts) || cur.maxAttempts || 0,
      deadlineAt: Number(evt.deadlineAt) || cur.deadlineAt || 0,
    };
    // Log only real transitions — onProgress can re-emit the same state.
    if (next.state !== cur.state || next.attempt !== cur.attempt) {
      log(`  ${next.name || next.profileId}: ${next.state}${next.reason ? ` — ${next.reason}` : ''}`);
    }
    job.senders.set(evt.profileId, next);
  };

  // Capture THIS job so a late-settling run() can't clobber a newer job that
  // replaced it (e.g. after a watchdog timeout + a fresh start).
  const settle = (patch) => { if (_job === job && !job.done) Object.assign(job, patch); };

  const runP = Promise.resolve().then(() => {
    controller.signal.throwIfAborted();
    return run({
    senderProfileIds,
    primaryUrl: body.primaryUrl,
    primarySource: body.primarySource || 'local-browser',
    autoAcceptAllPending: !!body.autoAcceptAllPending,
    onProgress,
    log,
    signal: controller.signal,
    });
  });
  // A watchdog/cancel changes the presentation, not resource ownership.
  // Even reset must not allow overlapping jobs while the previous run lives.
  runP.then(() => unsettled.delete(job), () => unsettled.delete(job));
  let timeoutHandle;
  const timeoutP = new Promise((_res, rej) => {
    timeoutHandle = setTimeout(() => {
      const error = new Error('Handshake stopped because the local browser work did not respond in time. No campaign was dispatched.');
      controller.abort(error);
      rej(error);
    }, maxMs);
    if (timeoutHandle && typeof timeoutHandle.unref === 'function') timeoutHandle.unref();
  });
  Promise.race([runP, timeoutP])
    .then((summary) => {
      if (_job !== job || job.done) return;
      const s = summary || {};
      log(`done — ${s.connected || 0} connected, ${s.accepted || 0} accepted, ${s.pending || 0} still pending`);
      settle({ summary: summary || null, done: true });
    })
    .catch((e) => {
      if (_job !== job || job.done) return;
      log(`FAILED — ${String((e && e.message) || e)}`);
      settle({ error: String((e && e.message) || e), done: true });
    })
    .finally(() => clearTimeout(timeoutHandle));

  return { ok: true, status: 200, started: true, senderProfileIds };
}
