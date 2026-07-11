// Single-flight job manager for the Path A cloud handshake.
//
// The handshake drives the local browser + GoLogin senders serially, so only ONE
// runs at a time. The client POSTs to start it and polls the status endpoint for
// live per-sender progress (the wizard). This module owns that singleton state so
// the server routes stay thin and the logic is unit-testable (inject `run`).

import { runCloudPreflightHandshake } from './cloud-preflight-handshake.js';

let _job = null; // { senders:Map<id,{profileId,state,name}>, done, summary, error }

/** Current job snapshot for the status endpoint. */
export function getHandshakeJob() {
  if (!_job) return { active: false };
  return {
    active: true,
    done: _job.done,
    error: _job.error,
    summary: _job.summary,
    senders: [..._job.senders.values()],
  };
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

  Promise.resolve()
    .then(() => run({
      senderProfileIds,
      primaryUrl: body.primaryUrl,
      primarySource: body.primarySource || 'local-browser',
      autoAcceptAllPending: !!body.autoAcceptAllPending,
      onProgress,
    }))
    .then((summary) => { if (_job) { _job.summary = summary || null; _job.done = true; } })
    .catch((e) => { if (_job) { _job.error = String((e && e.message) || e); _job.done = true; } });

  return { ok: true, status: 200, started: true, senderProfileIds };
}
