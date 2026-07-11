// Single-flight job manager for the Path A cloud handshake.
//
// The handshake drives the local browser + GoLogin senders serially, so only ONE
// runs at a time. The client POSTs to start it and polls the status endpoint for
// live per-sender progress (the wizard). This module owns that singleton state so
// the server routes stay thin and the logic is unit-testable (inject `run`).

import { runCloudPreflightHandshake } from './cloud-preflight-handshake.js';

let _job = null; // { senders:Map<id,{profileId,state,name}>, done, summary, error }

// Overall watchdog: even if a browser primitive hangs and run() never settles,
// the job must eventually flip `done` — otherwise startHandshakeJob's single-
// flight guard returns 409 forever and the feature is bricked until restart.
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
      byId.set(fs.profileId, { profileId: fs.profileId, state: fs.state || cur.state, name: fs.name || cur.name });
    }
    senders = [...byId.values()];
  }
  return { active: true, done: _job.done, error: _job.error, summary: _job.summary, senders };
}

/** Reset (tests / after the client consumes a finished job). */
export function resetHandshakeJob() { _job = null; }

/**
 * Validate + start a handshake. Returns `{ ok, status, ... }` for the route to
 * relay. Fire-and-forget: progress lands in the singleton, polled via
 * getHandshakeJob(). `run` is injectable for tests.
 */
export function startHandshakeJob(body = {}, { run = runCloudPreflightHandshake } = {}) {
  const senderProfileIds = Array.isArray(body.senderProfileIds)
    ? body.senderProfileIds.filter(Boolean) : [];
  if (!senderProfileIds.length) return { ok: false, status: 400, error: 'senderProfileIds required' };
  if (!body.primaryUrl) return { ok: false, status: 400, error: 'primaryUrl required' };
  if (_job && !_job.done) return { ok: false, status: 409, error: 'a handshake is already running' };

  const senders = new Map(senderProfileIds.map((id) => [id, { profileId: id, state: 'pending', name: '' }]));
  _job = { senders, done: false, summary: null, error: null };

  const onProgress = (evt) => {
    if (!evt || !evt.profileId) return;
    const cur = _job.senders.get(evt.profileId) || { profileId: evt.profileId, state: 'pending', name: '' };
    _job.senders.set(evt.profileId, {
      profileId: evt.profileId,
      state: evt.state || cur.state,
      name: evt.name || cur.name,
    });
  };

  // Capture THIS job so a late-settling run() can't clobber a newer job that
  // replaced it (e.g. after a watchdog timeout + a fresh start).
  const job = _job;
  const settle = (patch) => { if (_job === job && !job.done) Object.assign(job, patch); };

  const runP = Promise.resolve().then(() => run({
    senderProfileIds,
    primaryUrl: body.primaryUrl,
    primarySource: body.primarySource || 'local-browser',
    autoAcceptAllPending: !!body.autoAcceptAllPending,
    onProgress,
  }));
  const timeoutP = new Promise((_res, rej) => {
    const h = setTimeout(() => rej(new Error('handshake timed out — the local browsers may be stuck; dispatch anyway or retry')), MAX_MS);
    if (h && typeof h.unref === 'function') h.unref();
  });
  Promise.race([runP, timeoutP])
    .then((summary) => settle({ summary: summary || null, done: true }))
    .catch((e) => settle({ error: String((e && e.message) || e), done: true }));

  return { ok: true, status: 200, started: true, senderProfileIds };
}
