/**
 * Central log writer — forwards bot events to two external Google Sheets
 * via dedicated Apps Script web apps.
 *
 * The bot's existing log/error paths are NOT replaced. This module adds
 * a parallel, fire-and-forget side channel:
 *
 *   - opsLogEvent(campaignKey, event) — buffered, flushed every 30s.
 *     Routes to the "Ortus Operations Log" sheet (one tab per campaign).
 *
 *   - campaignLogAppendRun(entry) — single immediate POST, called at
 *     campaign-end alongside the existing appendHistory disk write.
 *     Routes to the "Ortus Campaign Activity" sheet (one row per run).
 *
 * Both functions are no-ops if their respective env URL is unset. This
 * keeps the app working for operators who haven't completed the sheets
 * setup yet. All network failures are swallowed (warn-logged only) — the
 * campaign loop is never blocked or aborted by a log-writer failure.
 */

import { OPS_LOG_WEBAPP_URL, CAMPAIGN_LOG_WEBAPP_URL } from './sheets-webapp-url.js';

const FLUSH_INTERVAL_MS = 30_000;
const FETCH_TIMEOUT_MS = 15_000;

let _opsBuffer = [];
let _flushTimer = null;

// Test seam: allow tests to inject a fake fetch. Production uses globalThis.fetch.
let _fetchImpl = (...args) => globalThis.fetch(...args);

// v2.56.0 — URL source. Production reads from the centralized constants
// (sheets-webapp-url.js) so EVERY operator's app — Antonio, Sam, anyone —
// posts to the same team-wide log sheets. The previous .env-driven pattern
// silently no-op'd for any operator who hadn't pasted OPS_LOG_WEBAPP_URL +
// CAMPAIGN_LOG_WEBAPP_URL into their local .env. The _envImpl test seam
// is preserved verbatim — when a test calls _setEnvImpl with an env stub,
// the stub overrides the constants for the duration of the test.
let _envImpl = null; // null = use centralized constants (production)

// Alert seam — invoked when ops flushes fail repeatedly so a logging outage
// surfaces instead of dying silently (the 2026-06-10 → 06-11 blackout, where
// the Ops Log was frozen 33h and nobody noticed). Fires once per outage.
let _alertImpl = null;
let _consecutiveFlushFailures = 0;
let _flushAlerted = false;
const FLUSH_FAILURE_ALERT_THRESHOLD = 3;

export function _setFetchImpl(fn) { _fetchImpl = fn; }
export function _setEnvImpl(fn) { _envImpl = fn; }
export function _setAlertImpl(fn) { _alertImpl = fn; }
export function _resetForTest() {
  _opsBuffer = [];
  if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
  _fetchImpl = (...args) => globalThis.fetch(...args);
  _envImpl = null;
  _alertImpl = null;
  _consecutiveFlushFailures = 0;
  _flushAlerted = false;
}
export function _peekBufferForTest() { return _opsBuffer.slice(); }

// Reset the failure streak after any successful flush.
function _noteFlushSuccess() {
  _consecutiveFlushFailures = 0;
  _flushAlerted = false;
}
// Count a failed flush; raise the alert once the streak crosses the threshold.
function _noteFlushFailure() {
  _consecutiveFlushFailures++;
  if (_consecutiveFlushFailures >= FLUSH_FAILURE_ALERT_THRESHOLD && !_flushAlerted) {
    _flushAlerted = true;
    try {
      (_alertImpl || (() => {}))(
        'Operations Log is not writing — check the "OPS AND LOGS" sheet (likely full or auth expired).'
      );
    } catch (_) { /* never let the alert itself throw */ }
  }
}

function _opsLogUrl() {
  if (_envImpl) return _envImpl().OPS_LOG_WEBAPP_URL || '';
  return OPS_LOG_WEBAPP_URL || '';
}
function _campaignLogUrl() {
  if (_envImpl) return _envImpl().CAMPAIGN_LOG_WEBAPP_URL || '';
  return CAMPAIGN_LOG_WEBAPP_URL || '';
}

/**
 * Queue an event for the Operations Log. Buffered locally; flushed every
 * 30s. Safe to call from anywhere — never throws, never blocks.
 *
 * @param {Object} campaignKey - { name, startedAt, operator } identifying
 *   the campaign run; controls which Sheets tab the event lands on.
 * @param {Object} event - { severity, event, account, leadUrl, details }
 */
export function opsLogEvent(campaignKey, event) {
  try {
    if (!_opsLogUrl()) return; // silent skip when unconfigured

    const ck = campaignKey || {};
    const evt = event || {};
    _opsBuffer.push({
      ts: new Date().toISOString(),
      operator: ck.operator || '',
      campaign: ck.name || '',
      campaignStartedAt: ck.startedAt || '',
      severity: evt.severity || 'INFO',
      account: evt.account || '',
      event: evt.event || '',
      leadUrl: evt.leadUrl || '',
      details: evt.details || '',
      // v2.93 — structured fields for the single-Events-tab Ops Log v2.
      // Optional + backward-compatible: old bridges ignore them; the new
      // bridge prefers them and falls back to event/severity when absent.
      phase: evt.phase || '',
      outcome: evt.outcome || '',
      reason: evt.reason || ''
    });

    _scheduleFlush();
  } catch (err) {
    console.warn('[log-writer] opsLogEvent threw:', err.message);
  }
}

function _scheduleFlush() {
  if (_flushTimer) return;
  _flushTimer = setTimeout(() => {
    _flushTimer = null;
    flushOpsLog().catch((err) => {
      console.warn('[log-writer] flushOpsLog threw:', err.message);
    });
  }, FLUSH_INTERVAL_MS);
  if (_flushTimer && typeof _flushTimer.unref === 'function') {
    _flushTimer.unref();
  }
}

/**
 * Force a flush of the ops buffer. Called by the 30s timer; also exposed
 * for callers that want to drain on shutdown / campaign end.
 *
 * On failure (network, Apps Script error), the events are pushed back to
 * the front of the buffer and a new flush timer is scheduled. This avoids
 * losing diagnostic data because the script was unreachable for a minute.
 */
export async function flushOpsLog() {
  const url = _opsLogUrl();
  if (!url || _opsBuffer.length === 0) return { ok: true, sent: 0 };

  const batch = _opsBuffer.splice(0);
  try {
    const res = await _post(url, { action: 'appendEvents', events: batch });
    if (res && res.success) {
      _noteFlushSuccess();
      return { ok: true, sent: batch.length };
    }
    // Apps Script returned an error envelope — keep events for retry.
    _opsBuffer.unshift(...batch);
    _scheduleFlush();
    _noteFlushFailure();
    return { ok: false, sent: 0, error: (res && res.error) || 'unknown' };
  } catch (err) {
    _opsBuffer.unshift(...batch);
    _scheduleFlush();
    _noteFlushFailure();
    return { ok: false, sent: 0, error: err.message };
  }
}

/**
 * Append one row to the Campaign Activity sheet. Called from the
 * campaign-end block, parallel to the existing appendHistory disk write.
 *
 * @param {Object} entry - shape mirrors what appendHistory writes:
 *   { ts, name, mode, profiles, operator, totalLeads, processed, errors,
 *     durationSec, endReason, templatePreview, sheetUrl }
 */
export async function campaignLogAppendRun(entry) {
  const url = _campaignLogUrl();
  if (!url) return { ok: true, skipped: true };

  try {
    const res = await _post(url, { action: 'appendRun', entry: entry || {} });
    if (res && res.success) return { ok: true, row: res.row };
    return { ok: false, error: (res && res.error) || 'unknown' };
  } catch (err) {
    console.warn('[log-writer] campaignLogAppendRun threw:', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Upsert one Dashboard row per campaign into the Ops Log "Dashboard" tab
 * (lives in the same OPS spreadsheet as the Events tab). Fire-and-forget;
 * never throws. Each row = the shape returned by summariseCampaign().
 */
export async function dashboardUpsert(rows) {
  const url = _opsLogUrl();
  if (!url || !Array.isArray(rows) || rows.length === 0) return { ok: true, skipped: true };
  try {
    const res = await _post(url, { action: 'upsertDashboard', rows });
    if (res && res.success) return { ok: true };
    return { ok: false, error: (res && res.error) || 'unknown' };
  } catch (err) {
    console.warn('[log-writer] dashboardUpsert threw:', err.message);
    return { ok: false, error: err.message };
  }
}

// ───────────────────────────────────────────────────────────────────────
// Shared POST helper — mirrors src/sheets-writer.js's postToWebApp
// pattern: handle 302 redirect manually, 15s per-leg timeout, swallow
// unknown response bodies.
// ───────────────────────────────────────────────────────────────────────
async function _post(url, payload) {
  const body = JSON.stringify(payload);
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const initial = await _fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    redirect: 'manual',
    signal
  });

  let res;
  if (initial.status >= 300 && initial.status < 400) {
    const location = initial.headers.get('location');
    res = await _fetchImpl(location, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } else {
    res = initial;
  }

  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    if (text && (text.includes('accounts.google.com') || text.includes('Sign in'))) {
      return { error: 'Authentication error — redeploy the Apps Script' };
    }
    return { raw: text };
  }
}
