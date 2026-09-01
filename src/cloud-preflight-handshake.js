// Cloud primary-handshake — Path A (local pre-dispatch).
//
// Problem: a cloud CC+IC campaign with a LOCAL-ONLY primary never gets its
// senders connected to the primary. The engine's only sender→primary connect is
// lazy (fires per-lead at intro time, gated on a lead having been accepted), so a
// campaign that is monitoring with 0 accepted leads sends the primary NOTHING.
//
// Fix (Path A): run the handshake locally, on the Mac, BEFORE dispatching to the
// engine — drive the GoLogin senders to connect to the primary, then accept those
// invitations in the local primary browser. Once done, the senders are 1st-degree
// connections of the primary, so the engine's own gate re-checks on the VM, finds
// them connected, skips the connect, and sends intros normally. The campaign then
// runs 100% on the VM.
//
// This module edits NONE of the browser/campaign files — it imports and calls
// their exported primitives. It mirrors the orchestration of
// `runPreflightHandshake` in src/campaign.js (which is not extractable — it lives
// in the campaign runner's closure), reusing the SAME primary-status store and the
// SAME idle primary-task runner so a cloud handshake is indistinguishable from the
// local one to everything downstream.

import { planAccountsNeedingConnect, handshakeProgress, shouldProceed } from './preflight-handshake.js';
import { checkAndConnectPrimary, primaryConnState } from './linkedin/primary-connection.js';
import { readSelfIdentity, acceptInvitationFrom, acceptAllPendingInvitations } from './linkedin/accept-invitation.js';
import { capturePrimaryCookies } from './primary-cookie-capture.js';
import { postPrimarySession } from './campaigns-client.js';
import { buildAcceptTask, enqueuePrimaryTask } from './primary-tasks.js';
import { _shouldQueueAutoAccept } from './linkedin/auto-intro.js';
import {
  primaryKeyFromUrl, storeKey, getEntry, mergeLiveRead, resolveDisplayState,
  seedConnectedIds, staleConnectedIds, loadPrimaryStatus, savePrimaryStatus,
} from './primary-status-store.js';
import { launchProfile, closeProfile } from './gologin-launcher.js';
import { launchLocalBrowser, closeLocalBrowser } from './local-launcher.js';
import { dataPath } from './paths.js';

const PRIMARY_STATUS_FILE = dataPath('primary-status.json');
const CAP_MS = 120_000;   // bound the accept-wait, same as runPreflightHandshake
const POLL_MS = 30_000;
// Settle window between Phase 1 (senders send their connect requests) and Phase 2
// (the primary browser opens to accept them). LinkedIn does not surface a just-
// sent invite in the recipient's pending-invitations inbox instantly; opening the
// primary the moment the request was sent makes the first accept pass race ahead
// of propagation and find nothing ("too fast — it didn't work"). Waiting here lets
// the requests land; the Phase-2 retry loop still covers a slower invite.
const SEND_SETTLE_MS = 20_000;

/**
 * Pure trigger gate. Path A runs only for a cloud CC+IC campaign whose primary is
 * local-only and whose auto-accept is on — the exact case the engine can't handle.
 * (A GoLogin primary can accept itself on the VM; other modes have no primary.)
 */
export function needsCloudHandshake({ mode, autoAcceptPrimary, primarySource } = {}) {
  return mode === 'connect_and_introduce'
    && autoAcceptPrimary === true
    && (primarySource || 'local-browser') === 'local-browser';
}

// Real primitives, overridable in tests via opts.deps.
const DEFAULT_DEPS = {
  launchProfile, closeProfile, launchLocalBrowser, closeLocalBrowser,
  checkAndConnectPrimary, readSelfIdentity, acceptInvitationFrom, acceptAllPendingInvitations,
  capturePrimaryCookies, postPrimarySession,
  enqueuePrimaryTask, loadPrimaryStatus, savePrimaryStatus,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
};

/**
 * Run the local pre-dispatch handshake.
 *
 * @param {object} opts
 * @param {string[]} opts.senderProfileIds  GoLogin ids selected for the cloud run
 * @param {string}   opts.primaryUrl
 * @param {string}   [opts.primarySource='local-browser']
 * @param {boolean}  [opts.autoAcceptAllPending=false]
 * @param {string}   [opts.token]           GoLogin token (defaults to env)
 * @param {string}   [opts.sheetUrl]        stamped onto queued accept tasks
 * @param {(evt:{profileId:string,state:string,name?:string})=>void} [opts.onProgress]
 * @param {(msg:string)=>void} [opts.log]
 * @param {object}   [opts.deps]            injectable primitives (tests)
 * @returns {Promise<{ok:boolean, connected:number, accepted:number, pending:number,
 *                     senders:{profileId:string,name:string,state:string}[]}>}
 */
export async function runCloudPreflightHandshake(opts = {}) {
  const {
    senderProfileIds = [],
    primaryUrl = '',
    primarySource = 'local-browser',
    autoAcceptAllPending = false,
    token = process.env.GOLOGIN_API_TOKEN,
    sheetUrl = '',
    onProgress = () => {},
    log = () => {},
    deps: injected = {},
  } = opts;
  const deps = { ...DEFAULT_DEPS, ...injected };
  const pUrl = (primaryUrl || '').trim();

  const nameById = new Map();
  const reasonById = new Map();
  const emit = (profileId, state, name, reason) => {
    if (name) nameById.set(profileId, name);
    if (reason) reasonById.set(profileId, reason);
    try {
      onProgress({
        profileId,
        state,
        name: nameById.get(profileId) || '',
        reason: reasonById.get(profileId) || '',
      });
    } catch { /* progress is best-effort */ }
  };

  /**
   * Put a freshly-launched sender window off-screen.
   *
   * The wizard promises "an off-screen GoLogin browser" and an operator watched
   * one open on their screen (2026-09-01). --window-position=-2400,-2400 is
   * passed at launch, but GoLogin's SDK passes its own --window-position=0,0 and
   * appends --restore-last-session, which restores the previous run's window
   * bounds. campaign.js has always followed the flag with this CDP call for
   * exactly that reason; the handshake never did.
   *
   * Best-effort: a window that refuses to move is a cosmetic problem, and it
   * must not fail a handshake.
   */
  const tuckAway = async (page) => {
    try {
      const client = await page.target().createCDPSession();
      const { windowId } = await client.send('Browser.getWindowForTarget');
      await client.send('Browser.setWindowBounds', { windowId, bounds: { left: -2400, top: -2400 } });
    } catch { /* cosmetic only */ }
  };

  /**
   * Why a sender's page could not be read.
   *
   * checkAndConnectPrimary returns connected:null for several different reasons
   * and the handshake used to treat them all the same. The one that actually
   * happens is a logged-out account: LinkedIn bounces it to the sign-in wall, no
   * degree badge exists, nothing is sent. Operator 2026-09-01 watched
   * somnath.mandal@ortus.solutions sit on that wall while the wizard said the
   * invitation had been sent and asked why "accept all pending" hadn't accepted
   * it — there was nothing to accept.
   */
  const whyUnreadable = async (page) => {
    let url = '';
    try { url = String((page && page.url && page.url()) || ''); } catch { /* page may be gone */ }
    let path = '';
    try { path = new URL(url).pathname || ''; } catch { path = url; }
    if (/\/authwall|\/login|\/uas\//.test(path)) return 'logged out';
    if (/\/checkpoint/.test(path)) return 'stopped by a LinkedIn security checkpoint';
    return '';
  };
  const buildSenders = (primaryConn) => senderProfileIds.map((id) => ({
    profileId: id, name: nameById.get(id) || '', state: primaryConn.get(id) || 'unverified',
  }));

  const summary = { ok: false, connected: 0, accepted: 0, pending: 0, senders: [] };
  if (!pUrl || !senderProfileIds.length) {
    // Nothing to do (misconfig or no senders): don't block the launch.
    summary.ok = true;
    summary.senders = buildSenders(new Map());
    return summary;
  }

  // ── seed from the persistent store: senders already connected skip the check ──
  const primaryConn = new Map();
  const primaryKey = primaryKeyFromUrl(pUrl);
  let store = {};
  try { store = await deps.loadPrimaryStatus(PRIMARY_STATUS_FILE); } catch { store = {}; }
  if (primaryKey) {
    const runSet = new Set(senderProfileIds);
    for (const pid of seedConnectedIds(store, primaryKey)) {
      if (runSet.has(pid)) primaryConn.set(pid, 'connected');
    }
    // Say out loud when a remembered 'connected' has expired, otherwise the
    // re-check looks like an unexplained extra browser launch in the log.
    const stale = staleConnectedIds(store, primaryKey).filter((pid) => runSet.has(pid));
    if (stale.length) {
      log(`  ⓘ ${stale.length} account(s) were last confirmed connected to the primary over a week ago — checking them against LinkedIn again rather than taking it on trust.`);
    }
  }
  // Surface already-connected senders to the wizard immediately (they never enter
  // the connect loop, so without this they'd stay stuck on "Waiting").
  for (const [pid, st] of primaryConn) emit(pid, st === 'connected' ? 'connected' : st);

  const need = planAccountsNeedingConnect(senderProfileIds, primaryConn);

  // Self-eliminating: every sender already connected and no accept-all sweep asked
  // for → launch nothing, dispatch straight through.
  if (need.length === 0 && !autoAcceptAllPending) {
    summary.ok = true;
    summary.senders = buildSenders(primaryConn);
    for (const s of summary.senders) emit(s.profileId, s.state);
    summary.connected = summary.senders.filter((s) => s.state === 'connected').length;
    return summary;
  }

  // ── Phase 1: each sender sends a connect-request to the primary ──
  const queuedAccepts = [];
  for (const profileId of need) {
    emit(profileId, 'connecting');
    let launched = null;
    try {
      launched = await deps.launchProfile(profileId, token);
    } catch (e) {
      log(`  ⚠ [${profileId}] could not launch to connect: ${e.message}`);
      primaryConn.set(profileId, 'unverified');
      emit(profileId, 'error');
      continue;
    }
    const page = launched && launched.page;
    if (page) await tuckAway(page);
    try {
      const res = await deps.checkAndConnectPrimary(page, pUrl, { log, pName: profileId, attemptConnect: true });
      const live = primaryConnState(res.connected);
      if (primaryKey && live !== 'unverified') {
        const entry = getEntry(store, profileId, primaryKey);
        store[storeKey(profileId, primaryKey)] = mergeLiveRead(entry, live, new Date(deps.now()).toISOString(), pUrl);
        primaryConn.set(profileId, resolveDisplayState(entry, live).state);
      } else {
        primaryConn.set(profileId, live);
      }

      if (_shouldQueueAutoAccept({ autoAcceptPrimary: true, connectAttempted: res.connectAttempted, connectResult: res.connectResult })) {
        const self = await deps.readSelfIdentity(page, { log }).catch(() => ({}));
        const name = (self && self.name) || '';
        if (self && (self.name || self.profileUrl)) {
          primaryConn.set(profileId, 'sent'); // transient: request out, not yet accepted
          queuedAccepts.push(buildAcceptTask({
            campaignProfileId: profileId, campaignProfileName: name || profileId,
            sheetId: '', sheetUrl, account: self, primaryUrl: pUrl, sender: primarySource, now: deps.now(),
          }));
          emit(profileId, 'sent', name);
        } else {
          // Invite is outstanding but we can't identify this account → the primary
          // can't match it. Surface rather than silently drop (2026-06-16 bug).
          log(`  ⚠ [${profileId}] couldn't read this account's identity — not queuing its auto-accept.`);
          emit(profileId, 'sent-no-identity');
        }
      } else if (primaryConn.get(profileId) === 'connected') {
        emit(profileId, 'connected');
      } else if (primaryConn.get(profileId) === 'unverified') {
        // NOTHING WAS SENT. checkAndConnectPrimary could not read the page, so it
        // deliberately did not send a connect ("leaving unverified, not sending a
        // connect"). Reporting 'sent' here told the wizard an invitation existed:
        // it then blamed the primary for not accepting an invitation that was
        // never sent, and the operator's accept-all sweep correctly found nothing
        // to accept (2026-09-01).
        const why = await whyUnreadable(page);
        log(why
          ? `  🔒 [${profileId}] ${why} — no invitation was sent. Reconnect this account in GoLogin, then try the primary again.`
          : `  ❓ [${profileId}] couldn't read this account against the primary — no invitation was sent.`);
        emit(profileId, 'not-sent', '', why || 'this account could not be read');
      } else {
        emit(profileId, 'sent');
      }
    } catch (e) {
      log(`  ⚠ [${profileId}] connect error: ${e.message}`);
      primaryConn.set(profileId, 'unverified');
      emit(profileId, 'error');
    } finally {
      try { await deps.closeProfile(profileId); } catch { /* */ }
    }
  }

  // ── Phase 2: the local primary browser accepts the queued invitations ──
  if (queuedAccepts.length || autoAcceptAllPending) {
    // Give the just-sent connect requests time to LAND in the primary's invites
    // before opening it to accept — removes the guaranteed-miss first pass (see
    // SEND_SETTLE_MS). The senders stay on "Request sent" in the wizard meanwhile.
    // Only wait when we actually just sent something (a pure accept-all sweep of
    // already-outstanding invites needs no settle).
    if (queuedAccepts.length) {
      log(`⏳ Letting ${queuedAccepts.length} connect request(s) reach the primary's invites (${Math.round(SEND_SETTLE_MS / 1000)}s) before accepting…`);
      await deps.sleep(SEND_SETTLE_MS);
    }
    const startedAt = deps.now();
    let primaryPage = null;
    try {
      const launched = (primarySource === 'local-browser')
        ? await deps.launchLocalBrowser()
        : await deps.launchProfile(primarySource, token);
      primaryPage = launched && launched.page;

      let pending = [...queuedAccepts];

      // Accept-all runs FIRST when it is on. The slow, retry-prone part of this
      // phase is identifying one specific person's invitation card; a blanket
      // sweep needs no identification at all. If it leaves the received list
      // empty then nothing we sent is still outstanding, so every sender is
      // accepted and the campaign dispatches now instead of waiting out the
      // matcher (up to CAP_MS). It used to run last, after that whole wait,
      // which made the option strictly slower than leaving it off.
      if (autoAcceptAllPending) {
        log('🧹 Accept-all: clearing every pending invitation on the primary in one pass…');
        let swept = null;
        try { swept = await deps.acceptAllPendingInvitations(primaryPage, { log }); }
        catch (e) { log(`  ⚠ Accept-all sweep error: ${e.message}`); }
        if (swept && Number(swept.remaining) === 0) {
          if (pending.length) {
            log(`  ✓ Nothing is left waiting on the primary, so all ${pending.length} sender invitation(s) are accepted — skipping the per-sender wait.`);
          }
          for (const t of pending) {
            primaryConn.set(t.campaignProfileId, 'connected');
            emit(t.campaignProfileId, 'connected');
          }
          pending = [];
        }
      }

      while (pending.length) {
        const still = [];
        for (const t of pending) {
          primaryConn.set(t.campaignProfileId, 'accepting');
          emit(t.campaignProfileId, 'accepting');
          const r = await deps.acceptInvitationFrom(primaryPage, t.account, { log })
            .catch((e) => { log(`  ⚠ [${t.campaignProfileName}] primary accept errored: ${e.message}`); return { accepted: false }; });
          if (r && r.accepted) {
            primaryConn.set(t.campaignProfileId, 'connected');
            emit(t.campaignProfileId, 'connected');
          } else {
            primaryConn.set(t.campaignProfileId, 'sent');
            still.push(t);
          }
        }
        pending = still;
        const { accepted, total } = handshakeProgress(primaryConn, queuedAccepts.map((t) => t.campaignProfileId));
        if (shouldProceed({ startedAt, now: deps.now(), capMs: CAP_MS, accepted, total })) break;
        if (pending.length) await deps.sleep(POLL_MS);
      }

      // Leftover accepts finish in the background via the existing idle runner.
      // Say so — this is the only place the wizard's per-attempt "looking again"
      // lines turn into a real, final outcome.
      if (pending.length) {
        log(`  ⚠ ${pending.length} invitation(s) never appeared on the primary within ${Math.round(CAP_MS / 1000)}s — handed to the background accept runner, they will be accepted the next time your primary browser opens.`);
      }
      for (const t of pending) { try { await deps.enqueuePrimaryTask(t); } catch { /* */ } }
      summary.pending = pending.length;

      // Best-effort: capture the primary's session so a follow-up can later run
      // AS the primary on the VM. A capture/post failure must never fail the
      // handshake — the whole thing is wrapped and swallowed here.
      try {
        const cap = await deps.capturePrimaryCookies(primaryPage);
        if (cap) { await deps.postPrimarySession(cap); log(`  🔑 primary session captured for ${cap.publicIdentifier} — follow-ups can run on the VM`); }
      } catch (e) { log(`  ⚠ primary session capture failed (${e.message}) — follow-ups will park until next handshake`); }
    } catch (e) {
      log(`  ⚠ primary accept session failed (${e.message}) — queuing for the idle runner`);
      for (const t of queuedAccepts) { try { await deps.enqueuePrimaryTask(t); } catch { /* */ } }
      summary.pending = queuedAccepts.length;
    } finally {
      try {
        (primarySource === 'local-browser') ? await deps.closeLocalBrowser() : await deps.closeProfile(primarySource);
      } catch { /* */ }
    }
  }

  try { await deps.savePrimaryStatus(PRIMARY_STATUS_FILE, store); } catch { /* */ }

  summary.ok = true;
  summary.senders = buildSenders(primaryConn);
  summary.connected = summary.senders.filter((s) => s.state === 'connected').length;
  summary.accepted = queuedAccepts.filter((t) => primaryConn.get(t.campaignProfileId) === 'connected').length;
  return summary;
}
