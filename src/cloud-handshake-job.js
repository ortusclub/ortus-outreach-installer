// Single-flight job manager for the Path A cloud handshake.
//
// The handshake drives the local browser + GoLogin senders serially, so only ONE
// runs at a time. The client POSTs to start it and polls the status endpoint for
// live per-sender progress (the wizard). This module owns that singleton state so
// the server routes stay thin and the logic is unit-testable (inject `run`).

import { runCloudPreflightHandshake } from './cloud-preflight-handshake.js';

let _job = null; // { senders:Map<id,{profileId,state,name}>, done, summary, error, lines }

// Keep the handshake's own narration. runCloudPreflightHandshake takes a `log`
// and this module never passed one, so it defaulted to `() => {}` — the entire
// Path A handshake ran SILENTLY: nothing in the console, nothing in the campaign
// log, nothing in the wizard. When an operator asked "did all four senders
// actually send a request to the primary?" there was no record to answer from
// (2026-08-06); the only trace was data/primary-status.json, written at the end.
// Mirror every line to the console AND keep the last N for the status endpoint.
const MAX_LINES = 200;

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
  return { active: true, done: _job.done, error: _job.error, summary: _job.summary, senders, lines: _job.lines.slice() };
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
  _job = { senders, done: false, summary: null, error: null, lines: [] };

  const log = (msg) => {
    const line = `[handshake] ${msg}`;
    try { console.log(line); } catch { /* */ }
    if (_job && _job.lines) {
      _job.lines.push(line);
      if (_job.lines.length > MAX_LINES) _job.lines.splice(0, _job.lines.length - MAX_LINES);
    }
  };
  log(`starting — ${senderProfileIds.length} sender(s) → ${body.primaryUrl}${body.autoAcceptAllPending ? ' (accept-all sweep on)' : ''}`);

  const onProgress = (evt) => {
    if (!evt || !evt.profileId) return;
    const cur = _job.senders.get(evt.profileId) || { profileId: evt.profileId, state: 'pending', name: '', reason: '' };
    const next = {
      profileId: evt.profileId,
      state: evt.state || cur.state,
      name: evt.name || cur.name,
      // Why this sender is where it is — carried through so the wizard can say
      // "logged out" instead of blaming the primary for not accepting an
      // invitation that was never sent.
      reason: evt.reason || cur.reason || '',
    };
    // Log only real transitions — onProgress can re-emit the same state.
    if (next.state !== cur.state) log(`  ${next.name || next.profileId}: ${next.state}`);
    _job.senders.set(evt.profileId, next);
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
    log,
  }));
  const timeoutP = new Promise((_res, rej) => {
    const h = setTimeout(() => rej(new Error('handshake timed out — the local browsers may be stuck; dispatch anyway or retry')), MAX_MS);
    if (h && typeof h.unref === 'function') h.unref();
  });
  Promise.race([runP, timeoutP])
    .then((summary) => {
      const s = summary || {};
      log(`done — ${s.connected || 0} connected, ${s.accepted || 0} accepted, ${s.pending || 0} still pending`);
      settle({ summary: summary || null, done: true });
    })
    .catch((e) => {
      log(`FAILED — ${String((e && e.message) || e)}`);
      settle({ error: String((e && e.message) || e), done: true });
    });

  return { ok: true, status: 200, started: true, senderProfileIds };
}
