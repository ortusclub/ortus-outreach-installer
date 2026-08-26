import { terminalPresentation } from './campaign-terminal.mjs';
import { normalizeLifecycle } from './campaign-lifecycle.mjs';

// Pure helpers for rendering card #2 (the .vj-card live-status card) inside an
// EXPANDED dashboard strip — browser-safe (no DOM), so app.js imports them and
// node --test unit-tests them. The DOM parts (vjCardSkeleton clone + fillVjCard)
// live in app.js. See docs/superpowers/specs/2026-07-11-expanded-strip-card2-parity-design.md
//
// The look comes entirely from the shared .vj-* CSS; these helpers only compute
// the field values + the control-button matrix so an expanded strip is identical
// to the campaign-tab card, driven per-campaign.

/** Map a board item (renderUnifiedStrip `it`) → the status shape fillVjCard/
 *  renderActiveCard consume. Mirrors _buildCloudActiveStatus's shape. */
export function statusFromItem(it = {}) {
  const lifecycle = normalizeLifecycle(it);
  const ownedLocal = String(it.runsOn || '') === 'local';
  const cloud = it.where === 'cloud' && !ownedLocal;
  // Monitoring is a campaign phase, not a VM-only location and not a synonym
  // for Pause. The same durable phase must select the same card on either side
  // of a handover.
  const monitoring = !!it.monitoring || !!it.monitoringPhase;
  const stopping = !!it.stopping;
  const state = (it.interrupted || it.waitingForLocal) ? 'interrupted'
    : stopping ? 'stopping'
    : it.dailyWait ? 'waiting_daily_reset'
    : it.needsReview ? 'needs_review'
    : monitoring ? 'monitoring'
    : it.bucket === 'done' ? 'done'
    : it.bucket === 'queued' ? 'queued'
    : undefined;
  return {
    lifecycle,
    executionId: lifecycle.executionId,
    needsReview: lifecycle.needsReview,
    reviewAction: lifecycle.reviewAction,
    _cloud: cloud,
    id: it.id,
    rawId: it.rawId,
    // A released VM row can remain status='running' while ownership is local.
    // When the local singleton is not actually active that word is only the
    // engine's frozen handover record, not proof that work is happening here.
    running: it.bucket === 'running' && !monitoring && !it.waitingForLocal && !it.dailyWait && !it.needsReview,
    state,
    name: it.name,
    mode: it.mode,
    isFG: !!it.isFG,
    totalTargets: Number(it.total) || 0,
    totalProcessed: Number(it.sent) || 0,
    pending: Number(it.pending) || 0,
    pendingCount: it.pending == null ? undefined : Math.max(0, Number(it.pending) || 0),
    endNotice: it.endNotice || (it.hist && it.hist.endNotice) || null,
    endReason: it.endReason || (it.hist && it.hist.endReason)
      || (it.bad ? 'stopped' : (it.bucket === 'done' ? 'completed' : '')),
    stopReason: it.stopReason || (it.hist && it.hist.stopReason) || '',
    dailyWait: !!it.dailyWait,
    needsReview: !!it.needsReview,
    engineStatus: it.engineStatus || '',
    resumeAt: it.resumeAt || null,
    accountsCount: Number(it.accounts) || 0,
    // The live stage counts accounts from these, not from accountsCount — a
    // board strip that only carried the number showed "0 accounts" beside a
    // stats line reading "3 accounts".
    profileIds: Array.isArray(it.profileIds) ? it.profileIds : [],
    participatingProfileIds: (Array.isArray(it.participatingProfileIds) && it.participatingProfileIds.length)
      ? it.participatingProfileIds
      : (Array.isArray(it.profileIds) ? it.profileIds : []),
    sheetUrl: it.sheetUrl || it.sheet_url || '',
    acceptedCount: (it.acceptedCount == null ? undefined : it.acceptedCount),
    paused: (!!it.paused && !monitoring) || !!it.interrupted || !!it.waitingForLocal,
    monitoringPhase: !!it.monitoringPhase || (!!it.monitoring && ownedLocal),
    // Live-browser flag + the engine's per-person phase tick. The strip's card
    // is a clone of #active-card, so it renders the same live stage — without
    // these it can only fall back to the one-line "Working…".
    live: !!it.live,
    liveAccount: it.liveAccount || '',
    currentAction: it.currentAction || null,
    logs: Array.isArray(it.logs) ? it.logs : [],
    nextCheckAt: it.nextCheckAt,
    monitoringUntil: it.monitoringUntil,
    followUp: it.followUp,
    autoChecksEnabled: it.autoChecksEnabled,
    checkIntervalMinutes: Number(it.checkIntervalMinutes) || 60,
    // The adaptive check cadence. checkSlowdown() is `effective > base`, nothing
    // else — so BOTH numbers have to survive this whitelist or the board's card
    // says "checks every 4h · nothing running right now" and presents a
    // temporary slowdown as the operator's own setting.
    //
    // Base falls back to the effective interval, NOT to 60: a local campaign set
    // to 2h carries no base at all, and defaulting it to 60 would report a
    // slowdown that isn't happening. Equal ⇒ not slowed, which is the truth.
    checkIntervalBaseMinutes: Number(it.checkIntervalBaseMinutes) || Number(it.checkIntervalMinutes) || 60,
    emptyCheckStreak: Number(it.emptyCheckStreak) || 0,
    // Which side owns the campaign + when it last changed hands, for the card's
    // RUNNING ON control. Whitelisted here so a board item that carries them
    // reaches the card. Every campaign that existed before this feature was
    // cloud-dispatched, so an absent value must read as the VM, never as ''
    // (which _whSide would otherwise have to re-guess from `_cloud`, and a
    // board item builder that forgets to set runsOn on a LOCAL item would then
    // silently show the control in the wrong position).
    // monitorHeroState reads these three to decide CHECKING vs waking vs a plain
    // countdown. statusFromItem is a whitelist, so leaving them out meant a board
    // strip could never show a sweep in progress: it said "nothing running right
    // now" with a browser open. Same trap that dropped the cadence fields.
    monitoringCheckInProgress: !!it.monitoringCheckInProgress,
    // The stop flag and the banner's counters. Same whitelist trap: every one of
    // these is invisible on the board's card unless it is named here.
    checkStopping: !!it.checkStopping,
    // Absent stays absent, never 0: a sweep on its third account would read
    // "1 of 3" and the operator has no way to know the number is a placeholder.
    accountsDone: it.accountsDone == null ? null : Number(it.accountsDone) || 0,
    accountsTotal: Number(it.accountsTotal) || Number(it.accounts) || 0,
    batchDone: it.batchDone == null ? null : Number(it.batchDone) || 0,
    batchSize: Number(it.batchSize) || 8,
    sentToday: Number(it.sentToday) || 0,
    dailyLimit: Number(it.dailyLimit) || 0,
    elapsedSec: it.elapsedSec == null ? null : Number(it.elapsedSec),
    // The per-account panel. Absent from this whitelist it never reaches the
    // board's card and the panel is dashboard-only for no visible reason.
    accountPanel: Array.isArray(it.accountPanel) ? it.accountPanel : [],
    monitorTaskStatus: it.monitorTaskStatus || null,
    monitorTaskDueAt: it.monitorTaskDueAt || null,
    monitorCheckStartedAt: it.monitorCheckStartedAt || null,
    monitorCheckCompletedAt: it.monitorCheckCompletedAt || null,
    runsOn: it.runsOn || 'vm',
    handoverAt: it.handoverAt || null,
    waitingForLocal: !!it.waitingForLocal,
    interrupted: !!it.interrupted || !!it.waitingForLocal,
    interruption: it.interruption || (it.waitingForLocal ? {
      title: 'Stopped because this Mac became unavailable',
      detail: 'Nothing is running on this Mac. The remaining leads are safe. Choose where to continue.',
      reason: 'local-runtime-missing',
    } : null),
    // The finished-FG reason line reads all three of these. Leaving them out of
    // this whitelist is why a done FG card on the board never explained itself:
    // _fgFinishedNote returns null the moment `bucket` is undefined, so the
    // "ran out of invite credits" note was dead everywhere it mattered.
    bucket: it.bucket,
    benchAccounts: it.benchAccounts || null,
    dupes: Number(it.dupes) || 0,
    bad: !!it.bad,
    badLabel: it.badLabel,
    histIdx: it.histIdx,
    hist: it.hist,
  };
}

/** Computed field values for the card body (no time-based countdown here — that
 *  is filled live by the ticker). Pure + testable. */
export function vjCardFields(status = {}) {
  const s = status || {};
  const isMonitor = s.state === 'monitoring';
  const isDone = s.state === 'done';
  const isQueued = s.state === 'queued';
  const isInterrupted = s.state === 'interrupted' || !!s.interrupted;
  const isStopping = s.state === 'stopping';
  const done = Number(s.totalProcessed) || 0;
  const total = Number(s.totalTargets) || 0;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const accountsCount = (s.accountsCount != null)
    ? Number(s.accountsCount) || 0
    : (((isMonitor ? s.participatingProfileIds : s.profileIds) || s.profileIds || []).length);
  const accepted = (s.acceptedCount == null) ? '—' : String(s.acceptedCount);
  const terminal = isDone ? terminalPresentation(s) : null;
  // Asleep on the engine's blocked_until. The DB status stays 'running' so the
  // acceptance sweep keeps running, so EVERY status word here would otherwise
  // fall through to 'Running'/'Sending' — printed directly above a card that
  // says every account is capped. The strip chip already reads this; the card
  // eyebrow is a SEPARATE renderer and was still echoing the raw status.
  const isWaiting = !isMonitor && !isDone && !isQueued && !s.bad
    && !!(s.currentAction && s.currentAction.phase === 'waiting');
  const eyebrow = isInterrupted ? 'Stopped · This Mac unavailable'
    : isStopping ? 'Stopping…'
    : s.bad ? (s.badLabel || 'Stopped')
    : isMonitor ? 'Monitoring'
    : isQueued ? 'Queued'
    : isDone ? terminal.label
    : isWaiting ? 'Waiting'
    : (s.paused ? 'Paused' : 'Running');
  const sendingLbl = isInterrupted ? 'Stopped safely'
    : isStopping ? 'Finishing the current lead'
    : isMonitor ? (s.monitoringCheckInProgress ? 'Checking now' : 'Waiting between checks')
    : isDone ? terminal.activity
    : isQueued ? 'Queued'
    : isWaiting ? 'Waiting'
    : (s.paused ? 'Paused' : 'Sending');
  return {
    isMonitor, isDone, isQueued, isWaiting, isInterrupted,
    name: s.name || '(unnamed)',
    eyebrow, pct, done, total, accountsCount, accepted, sendingLbl,
  };
}

/** The control-button matrix for one strip's card, routed to THAT campaign by id
 *  (local vs cloud, per state). Pure — returns a spec; fillVjCard renders it.
 *  onclick strings reference the same global fns renderUnifiedStrip's footer uses. */
// Escape a campaign id for safe embedding in `onclick="fn('<here>')"` — a
// double-quoted HTML attribute holding a single-quoted JS string. A local done
// strip's id is `h-<campaign name>`, so it can carry quotes / angle brackets.
function _esc(v) {
  return String(v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export function vjCardControlsFor(status = {}) {
  const s = status || {};
  const cloud = !!s._cloud;
  const id = _esc(String(s.id || ''));
  const rawId = _esc(String(s.rawId || String(s.id || '')));
  const monitor = s.state === 'monitoring';
  const done = s.state === 'done';
  const queued = s.state === 'queued';
  const interrupted = s.state === 'interrupted' || !!s.interrupted;
  const dailyWait = s.state === 'waiting_daily_reset';
  const needsReview = s.state === 'needs_review';
  const running = !monitor && !done && !queued && !interrupted && !dailyWait && !needsReview;

  // Running cloud → read-only wizard WITH the campaign's Live Status card #2
  // bound and open; STOPPED/cancelled cloud → the setup wizard prefilled + fully
  // editable (edit & re-launch); cleanly-done cloud → the live cockpit. Both
  // editors fall back to openCloudLive when no launch config was snapshotted
  // (pre-2.133 campaigns).
  //
  // v2.160.134: running cloud used to call openRunningCampaignEditor, which is
  // the pre-2.160.46 path — it prefills the wizard but never binds the live card
  // (_bindLiveStatusToCampaign) or flips the run target to Cloud VM. So OPEN from
  // an EXPANDED strip landed on a "Runs on this Mac" wizard with NO Live Status
  // section, while OPEN from the COLLAPSED strip footer (which already called
  // openRunningCampaignReadOnly) showed it. Same button, two paths. One now.
  const openOnclick = cloud
    ? (queued ? `viewCloudCampaign('${id}')`
      : (running || monitor) ? `openRunningCampaignReadOnly('${id}')`
        : s.bad ? `openCampaignForEdit('${id}')`
          : `openCloudLive('${id}')`)
    : (queued ? `window.editQueuedCampaign && window.editQueuedCampaign('${rawId}')` : 'viewRunningCampaign()');

  const c = {
    open: { onclick: openOnclick },
    sheet: { onclick: 'window.openVjCardSheet && window.openVjCardSheet(this)' },
    pause: null, stop: null, restart: null, copy: null,
    resumeSending: null, bulk: null, monAuto: null, extra: [],
  };

  if (interrupted) {
    const interruptedPhase = s.interruption?.phase || (s.monitoringPhase ? 'monitoring' : 'sending');
    c.pause = { once: true, onclick: `window.openCampaignResumeDecision && window.openCampaignResumeDecision('${id || 'local-active'}','${interruptedPhase}','local',this)` };
    if (interruptedPhase === 'monitoring' && Number(s.pending) > 0) {
      c.resumeSending = { once: true, onclick: `window.openCampaignResumeDecision && window.openCampaignResumeDecision('${id || 'local-active'}','sending','local',this)` };
    }
    c.stop = { tip: 'End campaign', onclick: 'window.dashStopActive && window.dashStopActive()' };
    // This is still a durable cloud campaign even though ownership was handed
    // to a local runtime that has since disappeared. Open the durable record,
    // never the now-empty local singleton.
    if (id && id !== 'local-active') c.open = { onclick: `openRunningCampaignReadOnly('${id}')` };
    return c;
  }

  if (dailyWait || needsReview) {
    c.open = { onclick: cloud ? `openRunningCampaignReadOnly('${id}')` : 'viewRunningCampaign()' };
    c.stop = { tip: 'Stop permanently', onclick: cloud ? `stopCloudCampaignUI('${id}')` : 'window.dashStopActive && window.dashStopActive()' };
    return c;
  }

  if (running && !cloud) {
    c.pause = { onclick: s.paused
      ? `window.openCampaignResumeDecision && window.openCampaignResumeDecision('${id || 'local-active'}','sending','local',this)`
      : 'window.dashPauseActive && window.dashPauseActive()' };
    c.stop = { tip: 'Stop', onclick: 'window.dashStopActive && window.dashStopActive()' };
    c.restart = { onclick: 'window.dashRestartActive && window.dashRestartActive()' };
    c.copy = { onclick: 'window.dashCopyActiveToQueue && window.dashCopyActiveToQueue()' };
    c.bulk = { label: 'Run check now', onclick: 'window.dashRunCheck && window.dashRunCheck()' };
  } else if (running && cloud) {
    // Cloud pause/resume has shipped. Keep this matrix identical to Campaign
    // Builder instead of preserving the old read-only cloud dock.
    c.pause = { onclick: s.paused
      ? `window.openCampaignResumeDecision && window.openCampaignResumeDecision('${id}','sending','vm',this)`
      : `pauseCloudCampaignUI('${id}', false)` };
    c.stop = { tip: 'Stop', onclick: `stopCloudCampaignUI('${id}')` };
    // Keep the compact circular-arrow shortcut, but also expose the same
    // explicit action shown in Campaign Builder. An operator should not have
    // to guess that an unlabelled icon means "check pending connections".
    c.bulk = { label: 'Run check now', onclick: `cloudCheckNow('${id}',this)` };
    c.restart = { onclick: `cloudCheckNow('${id}',this)` };
    c.copy = { onclick: `duplicateCampaign('${id}')` };
    c.extra.push({ tip: 'Show', kind: 'show', onclick: `openCloudCampaignView('${id}','${id}')` });
  } else if (monitor && !cloud) {
    c.pause = { once: true, onclick: `window.openCampaignResumeDecision && window.openCampaignResumeDecision('${id || 'local-active'}','monitoring','local',this)` };
    c.stop = { tip: 'Stop', onclick: 'window.dashStopActive && window.dashStopActive()' };
    c.bulk = { label: 'Run check now', onclick: 'window.dashRunCheck && window.dashRunCheck()' };
    const remaining = Number(s.pending) > 0
      || Number(s.totalTargets) > Number(s.totalProcessed);
    if (remaining) {
      c.extra.push({ tip: 'Resume sending', kind: 'play', once: true,
        onclick: `window.openCampaignResumeDecision && window.openCampaignResumeDecision('${id || 'local-active'}','sending','local',this)` });
    }
  } else if (monitor && cloud) {
    c.stop = s.monitoringCheckInProgress
      ? { tip: 'Stop check', onclick: `stopCloudCheckUI('${id}',this)` }
      : { tip: 'Stop monitoring', onclick: `stopCloudCampaignUI('${id}')` };
    c.bulk = { label: 'Run check now', onclick: `cloudCheckNow('${id}',this)` };
    c.monAuto = { checked: s.autoChecksEnabled !== false, onclick: `setCloudAutoChecks('${id}',this.checked,this)` };
    // A campaign that switched to monitoring because nothing could send still has
    // leads waiting. The engine already accepts a restart in this state (it only
    // short-circuits when nothing is pending); the app just never offered it, so
    // the only way back was to wait for the scheduled resume. Continue-where-it-
    // left-off only: re-sending to leads already connected is not one click away.
    const remaining = Number(s.pending) > 0
      || Number(s.totalTargets) > Number(s.totalProcessed);
    if (remaining) {
      c.extra.push({ tip: 'Resume sending', kind: 'play', once: true,
        onclick: `window.openCampaignResumeDecision && window.openCampaignResumeDecision('${id}','sending','vm',this)` });
    }
  } else if (done) {
    // Restart controls — only for a STOPPED/CANCELLED/ERRORED campaign (never a
    // cleanly-completed one). ▶ Continue where it left off · ⟲ from the beginning.
    if (s.bad || terminalPresentation(s).pending > 0) {
      c.extra.push({ tip: 'Continue where it left off', kind: 'play', onclick: cloud ? `restartCloudCampaignUI('${id}', false)` : `restartLocalFromItem('${id}', false)` });
      c.extra.push({ tip: 'Restart from the beginning', kind: 'restart', onclick: cloud ? `restartCloudCampaignUI('${id}', true)` : `restartLocalFromItem('${id}', true)` });
    }
    c.extra.push({ tip: 'Duplicate', kind: 'dup', onclick: `duplicateCampaign('${id}')` });
    if (!cloud && s.hist) c.extra.push({ tip: 'Debrief', kind: 'debrief', onclick: `window.openDebrief('${id}')` });
    c.extra.push({ tip: 'Delete', kind: 'delete', onclick: `deleteBoardCampaign('${id}', this)` });
  } else if (queued) {
    c.extra.push({ tip: 'Cancel', kind: 'cancel', onclick: cloud ? `stopCloudCampaignUI('${id}')` : `window.cancelQueuedCampaign && window.cancelQueuedCampaign('${rawId}')` });
  }
  return c;
}
