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
  const cloud = it.where === 'cloud';
  const monitoring = !!it.monitoring;
  const state = monitoring ? 'monitoring'
    : it.bucket === 'done' ? 'done'
    : it.bucket === 'queued' ? 'queued'
    : undefined;
  return {
    _cloud: cloud,
    id: it.id,
    rawId: it.rawId,
    running: it.bucket === 'running' && !monitoring,
    state,
    name: it.name,
    mode: it.mode,
    isFG: !!it.isFG,
    totalTargets: Number(it.total) || 0,
    totalProcessed: Number(it.sent) || 0,
    accountsCount: Number(it.accounts) || 0,
    acceptedCount: (it.acceptedCount == null ? undefined : it.acceptedCount),
    paused: !!it.paused,
    logs: Array.isArray(it.logs) ? it.logs : [],
    nextCheckAt: it.nextCheckAt,
    monitoringUntil: it.monitoringUntil,
    autoChecksEnabled: it.autoChecksEnabled,
    checkIntervalMinutes: Number(it.checkIntervalMinutes) || 60,
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
  const done = Number(s.totalProcessed) || 0;
  const total = Number(s.totalTargets) || 0;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const accountsCount = (s.accountsCount != null)
    ? Number(s.accountsCount) || 0
    : (((isMonitor ? s.participatingProfileIds : s.profileIds) || s.profileIds || []).length);
  const accepted = (s.acceptedCount == null) ? '—' : String(s.acceptedCount);
  const eyebrow = s.bad ? (s.badLabel || 'Stopped')
    : isMonitor ? 'Monitoring'
    : isQueued ? 'Queued'
    : isDone ? 'Finished'
    : (s.paused ? 'Paused' : 'Running');
  const sendingLbl = isMonitor ? 'Watching'
    : isDone ? 'Finished'
    : isQueued ? 'Queued'
    : (s.paused ? 'Paused' : 'Sending');
  return {
    isMonitor, isDone, isQueued,
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
  const running = !monitor && !done && !queued;

  const openOnclick = cloud
    ? (queued ? `viewCloudCampaign('${id}')` : `openCloudLive('${id}')`)
    : (queued ? `window.editQueuedCampaign && window.editQueuedCampaign('${rawId}')` : 'viewRunningCampaign()');

  const c = {
    open: { onclick: openOnclick },
    pause: null, stop: null, restart: null, copy: null,
    bulk: null, monAuto: null, extra: [],
  };

  if (running && !cloud) {
    c.pause = { onclick: 'window.dashPauseActive && window.dashPauseActive()' };
    c.stop = { tip: 'Stop', onclick: 'window.dashStopActive && window.dashStopActive()' };
    c.restart = { onclick: 'window.dashRestartActive && window.dashRestartActive()' };
    c.copy = { onclick: 'window.dashCopyActiveToQueue && window.dashCopyActiveToQueue()' };
    c.bulk = { label: 'Run check now', onclick: 'window.dashRunCheck && window.dashRunCheck()' };
  } else if (running && cloud) {
    c.stop = { tip: 'Stop', onclick: `stopCloudCampaignUI('${id}')` };
    c.extra.push({ tip: 'Show', kind: 'show', onclick: `openCloudCampaignView('${id}','${id}')` });
  } else if (monitor && !cloud) {
    c.pause = { onclick: 'window.dashPauseActive && window.dashPauseActive()' };
    c.stop = { tip: 'Stop', onclick: 'window.dashStopActive && window.dashStopActive()' };
    c.bulk = { label: 'Run check now', onclick: 'window.dashRunCheck && window.dashRunCheck()' };
  } else if (monitor && cloud) {
    c.stop = { tip: 'Stop monitoring', onclick: `stopCloudCampaignUI('${id}')` };
    c.bulk = { label: 'Run check now', onclick: `cloudCheckNow('${id}')` };
    c.monAuto = { checked: s.autoChecksEnabled !== false, onclick: `setCloudAutoChecks('${id}',this.checked,this)` };
  } else if (done) {
    c.extra.push({ tip: 'Duplicate', kind: 'dup', onclick: `duplicateCampaign('${id}')` });
    if (!cloud && s.hist) c.extra.push({ tip: 'Debrief', kind: 'debrief', onclick: `window.openDebrief('${id}')` });
    c.extra.push({ tip: 'Dismiss', kind: 'dismiss', onclick: cloud ? `dismissCloudDone('${id}', this)` : `dismissLocalDone('${id}')` });
  } else if (queued) {
    c.extra.push({ tip: 'Cancel', kind: 'cancel', onclick: cloud ? `stopCloudCampaignUI('${id}')` : `window.cancelQueuedCampaign && window.cancelQueuedCampaign('${rawId}')` });
  }
  return c;
}
