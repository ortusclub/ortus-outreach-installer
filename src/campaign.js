/**
 * Campaign orchestrator — v17.
 *
 * EXACT WORKFLOW:
 * 1. User selects 2-5 GoLogin accounts + lead list
 * 2. For each GoLogin profile:
 *    a. Open GoLogin profile
 *    b. Load LinkedIn home page
 *    c. Wait 20 seconds on home page
 *    d. Set zoom to 67%
 *    e. For each lead:
 *       - Open lead's LinkedIn profile
 *       - Wait 30 seconds for page to load
 *       - Ensure zoom is 67%
 *       - Execute Connect action
 *       - Wait 10 seconds after connection sent
 *       - Next lead
 *    f. Close all tabs + close GoLogin browser
 *    g. Open next GoLogin profile, repeat
 */

import { existsSync, mkdirSync, appendFileSync, statSync, renameSync } from 'fs';
import { readFile, writeFile, appendFile } from 'node:fs/promises';
import os from 'node:os';
import { launchProfile, closeProfile, closeAllProfiles, getProfiles, getProfilePid, applyFocusEmulation } from './gologin-launcher.js';
import { launchLocalBrowser, closeLocalBrowser } from './local-launcher.js';
import { fetchSheet as fetchSheetRows } from './sheets.js';
import { updateSheetRow, batchUpdateSheet, ensureTrackingColumns, prepareSheet, setOperatorTz } from './sheets-writer.js';
import { getPrefs as getOperatorPrefs } from './operator-prefs.js';
import { opsLogEvent, campaignLogAppendRun } from './log-writer.js';
import { performOutreach } from './linkedin/outreach.js';
import { getProfileUrn, captureProfileMeta } from './linkedin/helpers.js';
import { bulkCheckConnections } from './linkedin/bulk-check-connections.js';
import { runAutoIntros } from './linkedin/auto-intro.js';
import { registerSchedule as registerPostCampaignSweep } from './post-campaign-bulk-check.js';
import { transitionToMonitoring } from './campaign-state-transitions.js';
import { registerAppender, buildAppendLogger, unregisterAppender } from './campaign-log-bus.js';
import { computeStillPendingUrls, buildClosedNotConnectedUpdate } from './stop-monitoring.js';
import { writeMonitoringState, readMonitoringState, clearMonitoringState, extractMonitoringSlice } from './monitoring-persistence.js';
import { decideResumeAction } from './monitoring-resume.js';
import { enqueueDesktopNotification } from './notifier.js';
import { dataPath } from './paths.js';
import { CampaignRegistry } from './campaign-registry.js';
import { checkDiskFree } from './disk-check.js';
import {
  sample as rmSample,
  decideThrottle,
  cfg as rmCfg,
  computeDelayMultiplier,
  _resetSampleCache,
  getAmbient,
  readAvailableMemory,
} from './resource-monitor.js';
import * as browserSemaphore from './browser-semaphore.js';

const STATE_FILE = dataPath('state.json');
const HISTORY_PATH = dataPath('history.json');
// v2.14 — per-mode bulk-check cadence. connect_and_introduce mode lowers
// the in-campaign cooldown from 6h → 5 min so acceptances detected mid-run
// can trigger intro DMs before the campaign ends. Other modes keep the 6h
// floor via BULK_CHECK_INTERVAL_MS below.
const IN_CAMPAIGN_BULK_CHECK_INTERVAL_MS = 5 * 60 * 1000;
// Idle-account bulk-checks only fire for campaigns that have been running
// long enough to be worth optimizing. Short campaigns rely on the in-batch
// trigger alone. Used by the idle-bulk-check trigger added in a follow-up
// task; defined here so both triggers share one source of truth.
const IDLE_CAMPAIGN_MIN_DURATION_MS = 30 * 60 * 1000;
// Per-(profileId, sheetId) timestamp of the last bulk Connection Status
// check. Used to gate the bulk-check to once every BULK_CHECK_INTERVAL_MS
// per profile per sheet, avoiding redundant Voyager hits.
const BULK_CHECK_FILE = dataPath('bulk-check-cooldown.json');
const BULK_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const SUCCESS_ACTIONS = new Set(['connection_sent', 'message_sent', 'inmail_sent', 'op_message_sent', 'already_processed', 'status_accepted', 'status_pending', 'status_declined', 'already_connected']);

// ═══════════════════════════════════════════════════════════════════════════
// Phase 11.2: batch-loop constants + pure helpers
// ═══════════════════════════════════════════════════════════════════════════

/** Hard cap — 5 leads per batch per profile, for ALL modes (D-01). Not configurable. */
export const BATCH_SIZE = 5;

/** Phase 2.8.20 (W2-A1) — per-lead watchdog timeout. Catches Puppeteer hangs
 *  that the protocol-level 120s timeout would otherwise paper over. Default
 *  180s; env-overridable for stress-testing (LEAD_TIMEOUT_MS=2000 will time
 *  out almost every lead, useful for proving the path).
 */
export const LEAD_TIMEOUT_MS = Number(process.env.LEAD_TIMEOUT_MS) || 180000;

// Hard cap on simultaneously-open browsers (Orbita + local Chromium combined).
// 2.9.9: dropped from 3 → 2 per Q-protocol decision. Type-agnostic — every
// launch (GoLogin or local) acquires a slot via browser-semaphore.js.
// Override via .env only if you have ≥16GB RAM and know what you're doing.
const MAX_CONCURRENT_PROFILES = Number(process.env.MAX_CONCURRENT_PROFILES) || 2;

/** Phase 2.8.20 (W3-D1) — state.json `processed` retention window in days.
 *  Default 60. Entries older than this are dropped on next loadState; the
 *  pruned state persists on the next saveState call. Configurable via env.
 *  Semantics: a lead untouched for N days is "forgotten" — fair game to retry.
 */
const STATE_RETENTION_DAYS = Number(process.env.STATE_RETENTION_DAYS) || 60;

export function withWatchdog(promise, timeoutMs, profileId) {
  let timer;
  const watchdog = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(
      new Error('lead_timeout_watchdog'),
      { kind: 'watchdog', profileId, timeoutMs }
    )), timeoutMs);
  });
  return Promise.race([promise, watchdog]).finally(() => clearTimeout(timer));
}

/** Minimum between-batch wait — floor for the derived-from-bph math (D-03). */
const MIN_BETWEEN_BATCHES_MS = 60 * 1000;

/** Gap threshold past which we close the browser instead of parking (D-13). */
const PROFILE_CLOSE_GAP_MIN_DEFAULT = 15;
function getCloseGapMin() {
  const v = Number(process.env.PROFILE_CLOSE_GAP_MIN);
  return Number.isFinite(v) && v > 0 ? v : PROFILE_CLOSE_GAP_MIN_DEFAULT;
}

/**
 * Pure helper — close the profile between batches when the gap is long enough
 * that keeping Chromium warm costs more than the re-launch S3 round-trip.
 * Exported for tests/batch-loop.test.js.
 */
export function shouldCloseBetweenBatches({ waitMs, closeGapMin }) {
  const threshold = Number.isFinite(closeGapMin) && closeGapMin > 0
    ? closeGapMin
    : getCloseGapMin();
  return Number(waitMs) > threshold * 60 * 1000;
}

/**
 * Pure predicate — should the idle bulk-check fire for this profile right now?
 * All seven gates must pass. Exported for tests/idle-bulk-check.test.js.
 *
 * @param {object} ctx
 * @param {string}  ctx.mode                  - campaign mode (only connect_and_introduce triggers idle checks)
 * @param {number}  ctx.campaignStartTime     - epoch ms when campaign began
 * @param {boolean} ctx.profileBrowserOpen    - is this profile's browser currently open? (in-batch trigger handles those)
 * @param {boolean} ctx.profileWeeklyLimited  - is this profile parked permanently?
 * @param {number}  ctx.semaphoreAvailable    - remaining browserSemaphore slots (0 = full)
 * @param {number}  ctx.lastBulkCheckAt       - epoch ms of last bulk-check for this (sheet, profile); 0 if never
 * @param {number}  ctx.now                   - epoch ms (current time — injected for testability)
 * @returns {boolean}
 */
export function shouldFireIdleBulkCheck(ctx) {
  if (ctx.mode !== 'connect_and_introduce') return false;
  if (ctx.now - ctx.campaignStartTime < IDLE_CAMPAIGN_MIN_DURATION_MS) return false;
  if (ctx.profileBrowserOpen) return false;
  if (ctx.profileWeeklyLimited) return false;
  if (ctx.semaphoreAvailable <= 0) return false;
  if (ctx.now - ctx.lastBulkCheckAt < IN_CAMPAIGN_BULK_CHECK_INTERVAL_MS) return false;
  return true;
}

async function appendHistory(entry) {
  let history = [];
  try { history = JSON.parse(await readFile(HISTORY_PATH, 'utf8')); } catch { /* first run */ }
  // v2.58.x — same-name dedup. When a campaign ends, any earlier history
  // entry with the same `name` is removed so the dashboard shows one row
  // per campaign (latest run wins). Matches the operator's "I keep
  // seeing the same campaign twice" complaint. Case- and whitespace-
  // insensitive match; entries with blank names are never deduped (those
  // are typically one-off ad-hoc runs that shouldn't collapse together).
  const name = (entry?.name || '').toString().trim().toLowerCase();
  if (name) {
    const before = history.length;
    history = history.filter(h => ((h?.name || '').toString().trim().toLowerCase()) !== name);
    const removed = before - history.length;
    if (removed > 0) {
      console.log(`[history] same-name dedup: removed ${removed} older entr${removed === 1 ? 'y' : 'ies'} for "${entry.name}"`);
    }
  }
  history.push(entry);
  await writeFile(HISTORY_PATH, JSON.stringify(history, null, 2));
}

// Data directory creation is handled centrally in src/paths.js.

async function loadState() {
  let s;
  try { s = JSON.parse(await readFile(STATE_FILE, 'utf8')); }
  catch { return { processed: {}, dailyCounts: {} }; }
  // Phase 2.8.20 (W3-D1): prune entries older than retention window.
  // Done at load (not save) so the trim happens once per process startup
  // rather than on every campaign-step persistence.
  const cutoff = Date.now() - STATE_RETENTION_DAYS * 86400000;
  let pruned = 0;
  for (const [url, entry] of Object.entries(s.processed || {})) {
    const ts = entry?.date ? Date.parse(entry.date) : NaN;
    if (Number.isFinite(ts) && ts < cutoff) {
      delete s.processed[url];
      pruned++;
    }
  }
  if (pruned > 0) {
    console.log(`[state] pruned ${pruned} entries older than ${STATE_RETENTION_DAYS}d`);
  }
  return s;
}
async function saveState(s) { await writeFile(STATE_FILE, JSON.stringify(s, null, 2)); }

// Bulk-check cooldown helpers. Stored as { "<sheetId>|<profileId>": timestamp }
// so different sheets don't share a single profile's cooldown.
async function readBulkCheckCooldown() {
  try { return JSON.parse(await readFile(BULK_CHECK_FILE, 'utf8')); }
  catch { return {}; }
}
async function writeBulkCheckCooldown(map) {
  try { await writeFile(BULK_CHECK_FILE, JSON.stringify(map, null, 2)); }
  catch (err) { console.warn(`[bulk-check] cooldown write failed: ${err.message}`); }
}
function bulkCheckKey(sheetId, profileId) { return `${sheetId}|${profileId}`; }
// Extract spreadsheet ID from a Google Sheet URL.
function _extractSheetIdFromUrl(url) {
  const m = (url || '').match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : '';
}

/**
 * Host-resource preflight — non-blocking. Returns warnings if the host
 * is already under heavy load so the caller can surface them to the
 * operator before opening any browsers.
 */
async function checkHostHealth() {
  const warnings = [];
  const GB = 1024 * 1024 * 1024;
  // 2.9.8: use vm_stat-based "available" RAM on macOS instead of os.freemem(),
  // which only counts strictly-free pages and ignores reclaimable inactive +
  // file-cached pages. The strict-free metric is always tiny on a healthy
  // Mac, which used to falsely warn "0.1GB free" on machines with 2-3 GB of
  // actually-available RAM.
  const mem = await readAvailableMemory();
  const availableGB = mem.availableBytes / GB;
  const totalGB = mem.totalBytes / GB;
  const load1 = os.loadavg()[0];
  const cpuCount = os.cpus().length;
  const loadThreshold = cpuCount * 0.8;

  if (availableGB < 2) {
    warnings.push(`Available RAM is ${availableGB.toFixed(1)}GB / ${totalGB.toFixed(1)}GB total — low.`);
  }
  if (load1 > loadThreshold) {
    warnings.push(`1-min load average ${load1.toFixed(2)} exceeds ${loadThreshold.toFixed(2)} (${cpuCount} CPUs × 0.8).`);
  }
  return { ok: warnings.length === 0, warnings };
}

// v2.11.11: "Sender" is the canonical sheet column for sender attribution.
// Earlier versions of the bot wrote to both "Account Used" and "Sender";
// the Apps Script bridge schema dropped "Account Used" and the bot's
// writeback no longer fills it. This helper centralises the read so the
// next column-name change is a one-line edit instead of a grep + 3 sites.
//
// v2.58.x: The Introduction Campaign mode (introduce_back) lets operators
// point the bot at a non-canonical sender column — e.g. a sheet whose
// header is "LinkedIn 1st Connections" instead of "Sender". When a
// senderColumn is provided, read from it first; fall back to the canonical
// Sender/sender keys so existing campaigns keep working unchanged.
function getSenderName(row, senderColumn) {
  if (senderColumn && row && row[senderColumn] != null) {
    const v = row[senderColumn].toString().trim();
    if (v) return v;
  }
  return (row?.Sender || row?.sender || '').toString().trim();
}

// Campaign-scoped counters — reset every time a campaign starts
const campaignCounts = {};

// v2.14.x: Snapshot of the most recent startCampaign() options, captured
// at run-start. Used by restoreCampaign() to re-launch with the exact same
// settings after a force-reset. Survives until the next startCampaign;
// cleared explicitly is never necessary (next start overwrites). Lost on
// app restart — Restore-after-crash falls back to history.json's last
// entry, which carries the same shape via its settings snapshot.
let _lastRunSettings = null;

function getCampaignCount(profileId) {
  return campaignCounts[profileId] || 0;
}
function bumpCampaignCount(profileId) {
  campaignCounts[profileId] = (campaignCounts[profileId] || 0) + 1;
}

// 2.9.8: normalize any skip/failure reason to a "Skipped: <reason>" form
// for consistent display in the dashboard log and the Audit-Log "Action"
// column. Success messages pass through untouched.
function normalizeSkipReason(msg) {
  if (!msg) return msg;
  const s = String(msg);
  if (s.startsWith('Skipped:')) return s;
  // Success / non-skip cases — pass through untouched
  if (/^(Connection sent|Message sent|InMail sent|Open Profile message sent|Acceptance confirmed|sent IC|Already in target state|Already connected|Still pending)/i.test(s)) {
    return s;
  }
  const lower = s.toLowerCase();
  if (lower.includes('legacy sales nav')) return 'Skipped: Legacy Sales Nav URL';
  if (lower.includes('profile not found') || lower.includes('url not found')) return 'Skipped: URL not found';
  if (lower.includes('login page detected') || lower.includes('session expired')) return 'Skipped: Session expired';
  if (lower.includes('email required')) return 'Skipped: Email required';
  if (lower.includes('connect button not found')) return 'Skipped: Connect button not found';
  // v2.14.x: modal cross-check detected we clicked Connect for someone
  // other than the profile owner (e.g. a sidebar firstName collision).
  if (lower.includes('connect_modal_wrong_person')) return 'Skipped: Connect modal opened for wrong person';
  if (lower.includes('send not confirmed') || lower.includes('send_not_confirmed')) return 'Skipped: Send not confirmed';
  // v2.10.0 — VOYAGER_REJECTED carries the HTTP status + LinkedIn's own error reason.
  // v2.14.x — 429 is overwhelmingly the weekly invitation cap (see the
  // consecutive-429 park logic in startCampaign at ~line 1705). Surface the
  // operator-friendly cause for 429s directly so the first 1-2 attempts
  // before the account auto-parks don't read as cryptic "HTTP 429" lines.
  // Other statuses (400/403/etc.) are rare — keep the code visible for
  // diagnostics.
  if (lower.includes('voyager_rejected')) {
    const statusMatch = s.match(/HTTP\s+(\d+)/i);
    if (statusMatch && statusMatch[1] === '429') return 'Skipped: Weekly invitation limit reached';
    return statusMatch ? `Skipped: LinkedIn rejected (HTTP ${statusMatch[1]})` : 'Skipped: LinkedIn rejected';
  }
  if (lower.includes('weekly invitation limit') || lower.includes('weekly_limit')) return 'Skipped: Weekly limit reached';
  if (lower.includes('inmail credits') || lower.includes('inmail_no_credits')) return 'Skipped: InMail credits exhausted';
  if (lower.includes('not yet connected')) return 'Skipped: Not yet connected';
  if (lower.includes('not confirmed connected')) return 'Skipped: Not confirmed connected';
  if (lower.includes('linkedin error toast') || lower.includes('linkedin_error_toast')) return 'Skipped: LinkedIn error toast';
  if (lower.includes('not open profile') || lower.includes('not_open_profile')) return 'Skipped: Not Open Profile';
  if (lower.includes('rate_limited') || lower.includes('rate-limit')) return 'Skipped: Rate limited';
  if (lower.includes('lead_timeout_watchdog') || lower.includes('lead timeout')) return 'Skipped: Lead timed out';
  if (lower.includes('no modal appeared')) return 'Skipped: Connect modal did not appear';
  if (lower.includes('connect failed')) return 'Skipped: Connect failed';
  // Fallback for unknown errors — still prefix
  return `Skipped: ${s}`;
}

export function extractLinkedInUrl(row, linkedinColumn) {
  // 1. User-specified column takes priority
  if (linkedinColumn && row[linkedinColumn]) {
    let v = row[linkedinColumn].trim();
    // Already a full URL (http://linkedin.com, https://linkedin.com, linkedin.com/...)
    if (v.includes('linkedin.com')) {
      if (!v.startsWith('http')) v = 'https://' + v;
      return v;
    }
    // Slug or ID without domain — convert to URL
    if (v && !v.includes(' ') && !v.includes('@')) {
      return `https://www.linkedin.com/in/${v}`;
    }
  }

  // 2. Fallback: scan all columns for any value containing linkedin.com
  for (const key of Object.keys(row)) {
    const v = (row[key] || '').trim();
    if (v.includes('linkedin.com')) {
      return v.startsWith('http') ? v : 'https://' + v;
    }
  }
  return null;
}

export function getModeHint(mode, prevAction) {
  if (mode === 'connect_only') return 'force_connect';
  // Phase 1 of connect_and_introduce is identical to connect_only — send the
  // connection request. Phase 2 (the intro DM after acceptance) is handled
  // by the bulk-check sweep + a follow-up pass; this mode hint just covers
  // the per-lead connect step.
  if (mode === 'connect_and_introduce') return 'force_connect';
  if (mode === 'message_only' || mode === 'introduce_back') return 'force_message';
  if (mode === 'check_status') return 'check_only';
  if (mode === 'inmail_only') return 'force_inmail';
  if (mode === 'open_profile_only') return 'force_open_profile';
  return null;
}

// v2.14.x — Pure predicate: is this v2-schema row eligible for a standalone
// DM (message_only) or IB (introduce_back) send?
//
// History: the original filter only matched Stage === 'Connected · DM Now',
// which is written by ONE code path — the per-lead Voyager check in
// outreach.js (status_accepted action → buildSheetDataForAction at line 908).
// The bulk-check (bulk-check-connections.js:164-188) writes
// `cc: 'Connected'` to the 'Connection Accepted Status' column but does NOT
// touch Stage, so after a real CC → bulk-check flow every accepted row
// still has Stage = 'Connect Pending'. Standalone DM/IB campaigns silently
// found zero targets on those sheets.
//
// This predicate accepts three Stage states that all mean "row is connected,
// safe to DM":
//   - 'Connected · DM Now'  — per-lead Voyager check confirmed (status_accepted)
//   - 'Already connected'   — bulk-check Path B, pre-existing 1st-degree
//   - 'Connect Pending'     iff Connection Accepted Status says Connected
//                             (bulk-check Path A leaves Stage unchanged but
//                             writes cc)
//
// Terminal stages (DM Sent / IC Sent / OP Sent / InM Sent / Replied / Done)
// and any Skipped-* stage are rejected so reruns can't re-send. CC+IC's
// monitoring path is intentionally NOT touched — it bypasses this filter
// entirely (runAutoIntros reads connectedUrls directly from bulk-check).
export function isDmIbEligible(row) {
  const stage = (row['Stage'] || row['stage'] || '').toString().trim();
  if (!stage || stage.startsWith('Skipped')) return false;
  const TERMINAL = new Set(['DM Sent', 'IC Sent', 'InM Sent', 'OP Sent', 'Replied', 'Done']);
  if (TERMINAL.has(stage)) return false;
  if (stage === 'Connected · DM Now' || stage === 'Already connected') return true;
  if (stage === 'Connect Pending') {
    const cc = (
      row['Connection Accepted Status'] || row['connection accepted status'] ||
      row['Connected Status']            || row['connected status'] || ''
    ).toString().trim();
    return cc === 'Connected' || cc === 'Already connected';
  }
  return false;
}

// Phase 2.8.20 (W3-C2): cached disk status, refreshed on a 30s interval.
// Kept module-local so getCampaignStatus() can stay synchronous (it's called
// from /api/campaign/status hot path).
let _diskStatusCache = { freeBytes: null, thresholdBytes: 0, ok: true, error: null };
async function _refreshDiskStatus() {
  try { _diskStatusCache = await checkDiskFree(); } catch (_) {}
}
_refreshDiskStatus();
setInterval(_refreshDiskStatus, 30000).unref?.();

// ── Campaign state (exposed to dashboard) ──
// Phase 1.2 of the parallel-campaigns refactor: the singleton `campaign`
// object is now registered as a single entry in a CampaignRegistry. The
// object itself is unchanged — all existing reads/writes (campaign.running,
// campaign.processedToday++, etc.) work exactly as before. Two derived
// getters (status, participatingProfileIds) project onto the shape the
// registry indexes on. Phase 1.3 onwards starts threading id through
// callers; for now there is always exactly one entry with this id.
export const SINGLETON_CAMPAIGN_ID = 'legacy-singleton';
export const registry = new CampaignRegistry();

export const campaign = {
  id: SINGLETON_CAMPAIGN_ID,
  running: false,
  _abort: false,
  // v2.52.0: monotonic generation counter for orphan-loop detection.
  // startCampaign increments this and each loop captures its own myGen
  // closure. If restoreCampaign re-launches before the prior loop has
  // finished unwinding, the prior loop sees campaign._generation !== myGen
  // and exits immediately — regardless of whether _abort has been reset.
  // Without this, restoreCampaign creates orphan loops that keep sending
  // connections + transition to monitoring even after the operator's Stop.
  _generation: 0,
  // Phase 2.8.9: pause/resume. _pauseRequested flips immediately on user click;
  // _paused flips once the loop boundary acknowledges (i.e. current lead done).
  // The two-state separation lets the UI show "Pausing…" vs "Paused".
  _paused: false,
  _pauseRequested: false,
  currentProfile: null,
  processedToday: 0,
  totalProcessed: 0,
  // Phase 2.8.12: live cockpit action surface for the dashboard. Frontend
  // computes countdown remaining = max(0, endsAt - Date.now()). When endsAt
  // is null, the action is indeterminate (rotating arc).
  currentAction: null,
  logs: [],
  errors: [],
  parkedProfiles: [],
  softWarnings: [],
  // Plan B: per-profile end reasons — populated when an account is removed
  // from the rotation (weekly cap, parked, ejected, completed quota, etc.).
  // Read by the dashboard's account-queue table to explain why a row reads
  // "Done". Reset at startCampaign so each run starts clean.
  profileEndReasons: [],
  // v2.14.x: in-memory blacklist of leads already intro'd in this process.
  // Primary defense against re-firing the same IC DM when the sheet write
  // is delayed/dropped or when Google Sheets' CSV export cache lags behind
  // the most recent write. Bulk-check filters this set BEFORE pushing URLs
  // to connectedUrls; auto-intro .add()s URLs after successful (or already-
  // exists) intros. Reset on each new campaign start.
  introducedInRun: new Set(),
  name: '',
};

// Derived `status` getter for registry indexing — maps existing flags
// onto the four-state vocabulary the registry uses. participatingProfileIds
// is NOT defined here because the campaign loop already maintains it as a
// real writable field (campaign.js:1183, 2952): the subset of profiles that
// actually contributed in this run, not the same as the selected
// profileIds. Registry.activeProfileIds() reads it directly.
Object.defineProperty(campaign, 'status', {
  enumerable: true,
  configurable: true,
  get() {
    if (this._paused || this._pauseRequested) return 'paused';
    if (this.running) return 'running';
    if (this.state === 'monitoring') return 'monitoring';
    return 'idle';
  },
});

registry.register(campaign);

// Record why a profile finished its turn in this run. Idempotent: if the
// profile already has an entry, the first reason wins (so "weekly limit hit"
// isn't overwritten by a downstream "consecutive skips" trip-wire firing on
// the same loop iteration). Called everywhere weeklyLimited.add(profileId)
// fires.
function recordProfileEnd(profileId, profileName, reason) {
  if (!profileId || !reason) return;
  const existing = campaign.profileEndReasons.find((e) => e.profileId === profileId);
  if (existing) return;
  campaign.profileEndReasons.push({
    profileId,
    profileName: profileName || '',
    reason,
    at: Date.now(),
  });
}

// Phase 2.8.12: tiny helper — sets the action shown in the dashboard cockpit.
// durationMs > 0 = timed wait (countdown); durationMs null = indeterminate.
function setAction(label, opts = {}) {
  const { lead = null, account = null, mode = null, durationMs = null } = opts;
  campaign.currentAction = {
    label,
    lead: lead || null,
    account: account || campaign.currentProfile || null,
    mode: mode || campaign.mode || null,
    endsAt: typeof durationMs === 'number' && durationMs > 0 ? Date.now() + durationMs : null,
    startedAt: Date.now(),
  };
}

// Helper for the central Operations Log (Ortus Operations Log sheet via
// log-writer.js). Fire-and-forget — never throws, never blocks. Reads
// campaign context from the global. Silent no-op when OPS_LOG_WEBAPP_URL
// is unset.
// Exported v2.57.x so auto-intro.js can surface intro failures with the
// same campaign key and severity classification, instead of those failures
// being trapped inside auto-intro's catch and never reaching the Ops Log.
export function _ops(severity, eventName, extra) {
  try {
    const e = extra || {};
    opsLogEvent(
      {
        name: campaign.name || '',
        startedAt: campaign.startedAt || '',
        operator: campaign.createdBy || '',
      },
      {
        severity,
        event: eventName,
        account: e.account || campaign.currentProfile || '',
        leadUrl: e.leadUrl || '',
        details: e.details || '',
      },
    );
  } catch (_) { /* fire-and-forget */ }
}

// 2.9.2: format a Date in the operator's local timezone (the Electron app
// runs on their machine, so new Date() already reflects their TZ — Philippines,
// Europe, US, wherever). Output: "May 4th, 13:43" — month abbreviation, day
// with ordinal suffix, 24h time, no seconds, no year.
const _MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function formatLocalDate(d) {
  const day = d.getDate();
  const ord = (day % 100 >= 11 && day % 100 <= 13) ? 'th'
            : (day % 10 === 1) ? 'st'
            : (day % 10 === 2) ? 'nd'
            : (day % 10 === 3) ? 'rd' : 'th';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${_MONTHS_SHORT[d.getMonth()]} ${day}${ord}, ${hh}:${mm}`;
}

export function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  campaign.logs.push(line);
  if (campaign.logs.length > 500) campaign.logs.shift();
  // 2.8.27: persist every line to data/campaign.log so post-run debugging
  // doesn't require dev-mode stdout. The in-memory campaign.logs is capped
  // at 500 lines; this file accumulates the full history. Rotation is
  // size-based at campaign start (rotateCampaignLogIfBig), so this hot-path
  // append stays cheap (no statSync per line).
  try {
    appendFileSync(CAMPAIGN_LOG_FILE, line + '\n');
  } catch { /* never let logging take down the campaign */ }
}

/** 2.8.27: size-based rotation. Called once at campaign start. If campaign.log
 *  exceeds MAX bytes, rename to campaign.log.1 (overwriting any previous .1)
 *  and start fresh. Bounds disk usage at ~2x MAX without per-line overhead. */
const CAMPAIGN_LOG_FILE = dataPath('campaign.log');
const CAMPAIGN_LOG_ROTATED = dataPath('campaign.log.1');
const MAX_CAMPAIGN_LOG_BYTES = Number(process.env.MAX_CAMPAIGN_LOG_BYTES) || 50 * 1024 * 1024;
function rotateCampaignLogIfBig() {
  try {
    const sz = statSync(CAMPAIGN_LOG_FILE).size;
    if (sz >= MAX_CAMPAIGN_LOG_BYTES) renameSync(CAMPAIGN_LOG_FILE, CAMPAIGN_LOG_ROTATED);
  } catch { /* file doesn't exist yet — first run, fine */ }
}

const ERROR_LOG_FILE = dataPath('errors.log.json');
const WARNINGS_LOG_FILE = dataPath('warnings-log.ndjson');
const MAX_ERROR_LOG_ENTRIES = Number(process.env.MAX_ERROR_LOG_ENTRIES) || 500;

// Soft-warning dedupe window — same (profileId, kind) within this many ms is suppressed.
const SOFT_WARNING_DEDUPE_MS = 10 * 60 * 1000;
const SOFT_WARNING_CAP = 200;

/**
 * Append a soft warning to in-memory state with dedupe + cap.
 * Pure logic — does not write to disk (W3 adds that side-effect via appendWarningLog).
 *
 * @param {Object} state - The campaign state object (mutated)
 * @param {Object} entry - { profileId, pName, kind, message }
 * @returns {Object|null} - The pushed entry, or null if deduped
 */
function pushSoftWarning(state, { profileId, pName, kind, message }) {
  const now = Date.now();
  const cutoff = now - SOFT_WARNING_DEDUPE_MS;

  // Dedupe: skip if same (profileId, kind) was added within window
  for (let i = state.softWarnings.length - 1; i >= 0; i--) {
    const e = state.softWarnings[i];
    if (e.detectedAt < cutoff) break; // entries are time-ordered; stop walking
    if (e.profileId === profileId && e.kind === kind) {
      return null;
    }
  }

  const entry = { profileId, pName, kind, message, detectedAt: now };
  state.softWarnings.push(entry);

  // Cap: FIFO trim from front when exceeded
  while (state.softWarnings.length > SOFT_WARNING_CAP) {
    state.softWarnings.shift();
  }

  appendWarningLog(entry).catch(() => {}); // fire-and-forget, errors logged in helper
  // Mirror to the central Operations Log.
  _ops('WARN', `Soft warning: ${kind}`, { account: pName, details: message });
  return entry;
}

async function appendErrorLog(entry) {
  // Best-effort persistence — never block or break the campaign loop.
  try {
    let arr = [];
    try {
      const raw = await readFile(ERROR_LOG_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) arr = parsed;
    } catch { /* file missing or unreadable — start fresh */ }
    arr.push(entry);
    if (arr.length > MAX_ERROR_LOG_ENTRIES) {
      arr.splice(0, arr.length - MAX_ERROR_LOG_ENTRIES);
    }
    // Atomic write: tmp file + rename, so a crash mid-write doesn't corrupt
    const tmp = ERROR_LOG_FILE + '.tmp';
    await writeFile(tmp, JSON.stringify(arr, null, 2));
    const { rename } = await import('node:fs/promises');
    await rename(tmp, ERROR_LOG_FILE);
  } catch (_) { /* swallow — disk-log failure must not break campaigns */ }
}

/**
 * Append a soft-warning entry to the NDJSON log, fire-and-forget.
 * Async (not sync — soft warnings are advisory, no need for crash-safe
 * sync write like server.js's appendFatalErrorSync).
 *
 * @param {Object} entry - { profileId, pName, kind, message, detectedAt }
 */
async function appendWarningLog(entry) {
  try {
    const line = JSON.stringify(entry) + '\n';
    await appendFile(WARNINGS_LOG_FILE, line);
  } catch (err) {
    console.warn('[appendWarningLog]', err.message);
  }
}

function pushError(err) {
  const entry = { at: new Date().toISOString(), message: err.message, profileName: campaign.currentProfile };
  campaign.errors.push({ time: entry.at, message: entry.message });
  if (campaign.errors.length > 100) campaign.errors.shift();
  // Phase 2.8.20 (W1-B2): also persist to disk (fire-and-forget).
  appendErrorLog(entry).catch(() => {});
  // Mirror to the central Operations Log so colleagues can self-diagnose.
  _ops('ERROR', err.message || 'Error', {
    details: err.stack ? (err.stack.split('\n')[1] || '').trim() : '',
  });
}

// ── Profile name cache ──
let profileNameCache = {};
let profileCacheTime = 0;

async function getProfileName(profileId, token) {
  if (Date.now() - profileCacheTime > 5 * 60 * 1000) {
    const all = await getProfiles(token);
    profileNameCache = {};
    for (const p of all) profileNameCache[p.id] = p.name;
    profileCacheTime = Date.now();
  }
  return profileNameCache[profileId] || profileId;
}

function getToken() {
  return process.env.GOLOGIN_API_TOKEN;
}

// ═══════════════════════════════════════════════════════════════════════════
// Organic feed browsing — mimics natural LinkedIn usage between connections
// ═══════════════════════════════════════════════════════════════════════════

async function browseFeedOrganically(page, pName) {
  try {
    log(`  🔄 [${pName}] Organic browsing — visiting feed…`);
    try {
      await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    } catch { /* timeout OK */ }
    await new Promise(r => setTimeout(r, 2000 + Math.floor(Math.random() * 2000)));

    // Scroll the feed a bit
    const scrollCount = 2 + Math.floor(Math.random() * 3); // 2-4 scrolls
    for (let i = 0; i < scrollCount; i++) {
      await page.keyboard.press('PageDown');
      await new Promise(r => setTimeout(r, 1500 + Math.floor(Math.random() * 3000)));
    }

    // ~30% chance: click a "Like" on a visible post (very natural action)
    if (Math.random() < 0.3) {
      const liked = await page.evaluate(() => {
        const likeButtons = Array.from(document.querySelectorAll('button'));
        const likeable = likeButtons.filter(b => {
          const aria = (b.getAttribute('aria-label') || '').toLowerCase();
          // Only click "Like" (not already liked, not "Love", "Celebrate", etc.)
          return aria.startsWith('like ') && !aria.includes('liked') && b.offsetWidth > 0;
        });
        if (likeable.length > 0) {
          // Pick one of the first 3 visible posts
          const pick = likeable[Math.floor(Math.random() * Math.min(3, likeable.length))];
          pick.click();
          return true;
        }
        return false;
      });
      if (liked) log(`  👍 [${pName}] Liked a feed post (organic activity)`);
    }

    // Scroll back to top before leaving
    await page.keyboard.press('Home');
    await new Promise(r => setTimeout(r, 1000 + Math.floor(Math.random() * 1000)));
    log(`  🔄 [${pName}] Organic browsing done.`);
  } catch (err) {
    // Non-critical — don't let feed browsing errors break the campaign
    log(`  ⚠ [${pName}] Feed browse skipped: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Profile health check (REL-04) — verifies LinkedIn session before leads
// ═══════════════════════════════════════════════════════════════════════════

async function checkProfileHealth(page, profileName) {
  const issues = [];

  // Phase 2.8.20 (W2-A2) — session-expired detection. If the page URL is on
  // a LinkedIn auth/checkpoint page, the cookies are dead. Surface this as a
  // distinct sessionExpired flag so the caller can park the profile for the
  // rest of the run instead of burning 5 retries on a dead session.
  try {
    const cur = page.url();
    if (cur && (cur.includes('/login') || cur.includes('/uas/login') || cur.includes('/checkpoint'))) {
      issues.push('session expired (auth page detected)');
      return { healthy: false, issues, sessionExpired: true };
    }
  } catch (_) { /* fall through to the existing Check 1 below */ }

  // Check 1: URL-based login detection
  try {
    const url = page.url();
    if (url.includes('/login') || url.includes('/authwall')) {
      issues.push('not logged in (redirected to login/authwall)');
      return { healthy: false, issues };
    }
  } catch (e) {
    issues.push(`URL check failed: ${e.message}`);
    return { healthy: false, issues };
  }

  // Check 2: Scroll the feed briefly to verify interactivity
  try {
    await page.evaluate(() => {
      window.scrollTo(0, 300);
      return new Promise(r => setTimeout(r, 1000));
    });
    await page.evaluate(() => window.scrollTo(0, 0));
  } catch (e) {
    issues.push(`feed scroll failed: ${e.message}`);
  }

  // Check 3: Check for rate-limit banners
  try {
    const rateLimited = await page.evaluate(() => {
      const text = document.body.innerText.toLowerCase();
      return text.includes('too many requests') ||
             text.includes('please try again later') ||
             text.includes('you\'ve reached the limit');
    });
    if (rateLimited) {
      issues.push('rate-limit banner detected');
      return { healthy: false, issues };
    }
  } catch (e) {
    issues.push(`rate-limit check failed: ${e.message}`);
  }

  return { healthy: issues.length === 0, issues };
}

/**
 * Park an idle profile on a low-RAM page during the per-lead delay window.
 * Swallows errors — parking failure must never break a campaign (D-10, D-11).
 * Called between performOutreach and the delay sleep in the round-robin loop.
 * Phase 11.1. Exported for tests/park-profile.test.js.
 */
export async function parkProfile(page, parkUrl = 'about:blank') {
  if (!page || page.isClosed?.()) return;
  try {
    await page.goto(parkUrl, { waitUntil: 'domcontentloaded', timeout: 5000 });
  } catch (err) {
    log(`  ⚠ Park failed: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase 11.2: ensureProfileLoggedIn — cache clear + home nav + health check
// + interactive login wait. Extracted from the old STEP 1 warmup block so
// ensureOpen() can call it lazily on first batch (D-10).
// ═══════════════════════════════════════════════════════════════════════════

async function ensureProfileLoggedIn(launched, profileId, pName) {
  let page = launched.page;

  // Clear cache + service workers (keep cookies so login persists)
  try {
    const client = await page.target().createCDPSession();
    await client.send('Network.clearBrowserCache');
    await client.send('ServiceWorker.unregister', { scopeURL: 'https://www.linkedin.com/' }).catch(() => {});
    log(`✓ ${pName}: cache cleared.`);
  } catch (e) {
    log(`⚠ ${pName}: cache clear skipped: ${e.message}`);
  }

  try {
    await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (e) {
    log(`⚠ Home nav: ${e.message}`);
  }

  // Re-acquire page (prevents detached frame)
  try {
    const pages = await launched.browser.pages();
    if (pages.length > 0) {
      page = pages[pages.length - 1];
      await page.setViewport({ width: 1366, height: 900 });
      // v2.14.x: re-apply CDP focus emulation on the re-acquired page.
      // The launcher set it on the ORIGINAL page object only — this is a
      // different page reference whose CDP session has never been
      // configured. Without this call, the background-tab IC DM fix is
      // silently nullified anytime ensureProfileLoggedIn lands on a
      // non-original page (most common: post-login process-swap).
      await applyFocusEmulation(page, profileId);
    }
  } catch { /* keep current */ }

  // Health check
  log(`Checking ${pName} health...`);
  const health = await checkProfileHealth(page, pName);
  // Phase 2.8.20 (W2-A2): bubble up sessionExpired so the caller can park
  // the profile cleanly. Skip the recovery-prompt UX (which is for when the
  // user just needs to log in once more — sessionExpired means cookies are
  // dead and we should drop this profile from rotation entirely).
  if (health.sessionExpired) {
    log(`✗ ${pName}: session expired — parking profile for rest of run.`);
    return { page: null, ok: false, sessionExpired: true };
  }
  if (!health.healthy) {
    if (profileId === 'local-browser') {
      log(`⚠ Local Browser not logged in. Bringing browser on-screen — please log into LinkedIn.`);
      log(`⏳ Waiting up to 120s for you to log in...`);
      await page.evaluate(() => { document.body.style.zoom = '90%'; }).catch(() => {});
      await page.evaluate(() => { if (window.moveTo) window.moveTo(100, 100); }).catch(() => {});
      try {
        const client = await page.target().createCDPSession();
        const { windowId } = await client.send('Browser.getWindowForTarget');
        await client.send('Browser.setWindowBounds', { windowId, bounds: { left: 100, top: 100, width: 1366, height: 900, windowState: 'normal' } });
      } catch { /* */ }

      let loggedIn = false;
      for (let wait = 0; wait < 24; wait++) {
        if (campaign._abort) break;
        await new Promise(r => setTimeout(r, 5000));
        try {
          const currentUrl = page.url();
          if (!currentUrl.includes('/login') && !currentUrl.includes('/authwall') && currentUrl.includes('linkedin.com')) { loggedIn = true; break; }
          const recheck = await checkProfileHealth(page, pName);
          if (recheck.healthy) { loggedIn = true; break; }
        } catch { /* */ }
        if ((wait + 1) % 6 === 0) log(`  Still waiting for login... (${(wait + 1) * 5}s)`);
      }
      if (!loggedIn) {
        log(`✗ Local Browser: login timed out after 120s. Skipping.`);
        await closeLocalBrowser();
        return { page: null, ok: false };
      }
      log(`✓ Local Browser: logged in! Moving window off-screen.`);
      try {
        const client = await page.target().createCDPSession();
        const { windowId } = await client.send('Browser.getWindowForTarget');
        await client.send('Browser.setWindowBounds', { windowId, bounds: { left: -2400, top: -2400 } });
      } catch { /* */ }
    } else {
      log(`⚠ ${pName} not logged in: ${health.issues.join(', ')}. Bringing browser on-screen — please log in.`);
      log(`⏳ Waiting up to 120s for you to log into ${pName}...`);
      try {
        const client = await page.target().createCDPSession();
        const { windowId } = await client.send('Browser.getWindowForTarget');
        await client.send('Browser.setWindowBounds', { windowId, bounds: { left: 100, top: 100, width: 1366, height: 900, windowState: 'normal' } });
      } catch { /* */ }

      let loggedIn = false;
      for (let wait = 0; wait < 24; wait++) {
        if (campaign._abort) break;
        await new Promise(r => setTimeout(r, 5000));
        try {
          const currentUrl = page.url();
          if (!currentUrl.includes('/login') && !currentUrl.includes('/authwall') && currentUrl.includes('linkedin.com')) { loggedIn = true; break; }
          const recheck = await checkProfileHealth(page, pName);
          if (recheck.healthy) { loggedIn = true; break; }
        } catch { /* */ }
        if ((wait + 1) % 6 === 0) log(`  Still waiting for ${pName} login... (${(wait + 1) * 5}s)`);
      }
      if (!loggedIn) {
        log(`✗ ${pName}: login timed out after 120s. Skipping.`);
        try { await launched.browser.close().catch(() => {}); await closeProfile(profileId); } catch { /* */ }
        return { page: null, ok: false };
      }
      log(`✓ ${pName}: logged in! Moving window off-screen.`);
      try {
        const client = await page.target().createCDPSession();
        const { windowId } = await client.send('Browser.getWindowForTarget');
        await client.send('Browser.setWindowBounds', { windowId, bounds: { left: -2400, top: -2400 } });
      } catch { /* */ }
    }
  }
  log(`${pName} health check passed.`);
  return { page, ok: true };
}

// ═══════════════════════════════════════════════════════════════════════════
// Main campaign runner
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Pure helper: builds the sheetData payload for a given outreach action result.
 * Routes the action to the right v2 mode-specific status column, mirrors the
 * latest action into `Status`, and writes Stage when applicable.
 *
 * @param {object} args
 * @param {string} args.action         - result.action ('connection_sent' | 'message_sent' | ...)
 * @param {string} args.mode           - active campaign mode
 * @param {string} args.profileName    - GoLogin profile display name (becomes Sender)
 * @param {string} args.hyperSent      - HYPERLINK formula for "Sent" label (or '')
 * @param {boolean} args.introMode     - tpl.introMode flag (relevant for message_sent)
 * @param {boolean} args.messageOpenProfiles - tpl flag (relevant for op_message_sent audit)
 * @param {number} [args.creditsLeft]  - inmail credits remaining (inmail_sent only)
 * @returns {object} sheetData         - keys consumed by Apps Script FIELD_MAP
 */
export function buildSheetDataForAction({
  action,
  mode,
  profileName = '',
  hyperSent = '',
  introMode = false,
  messageOpenProfiles = false,
  creditsLeft
}) {
  // Write to BOTH 'Sender' (v2 schema) and 'Account Used' (legacy column).
  // Sheets that have only one of the two will silently ignore the missing
  // field; sheets that have both stay in sync. This is what makes the
  // "Account Used" column populate on legacy/migrated sheets.
  const out = { sender: profileName, accountUsed: profileName };

  switch (action) {
    case 'connection_sent':
      out.status            = 'Connection Request Sent';
      out.connectionStatus  = 'Connection Request Sent';
      out.stage             = 'Connect Pending';
      out.auditAction       = 'Connection sent';
      return out;

    case 'already_connected':
      out.status            = 'Already Connected';
      out.connectionStatus  = 'Already Connected';
      out.cc                = 'Connected';
      out.connectedAlready  = 'Yes';
      out.stage             = 'Connected';
      out.auditAction       = 'Already 1st-degree connection';
      return out;

    case 'message_sent':
      if (mode === 'introduce_back') {
        // v2.59: Introduction Campaign tabs are separate from connection
        // tabs and may not have Stage / Status columns at all. Write ONLY
        // to Introduction Status so IC tabs don't depend on Stage. Filter
        // also reads from Introduction Status (campaign.js:~1442).
        out.introStatus = 'IC Sent';
      } else if (introMode && mode === 'message_only') {
        out.status      = 'IC Sent';
        out.introStatus = 'IC Sent';
        out.stage       = 'IC Sent';
      } else {
        out.status   = 'DM Sent';
        out.dmStatus = 'DM Sent';
        out.stage    = 'DM Sent';
      }
      out.message     = hyperSent;
      out.auditAction = 'Message sent';
      return out;

    case 'op_message_sent':
      // Legacy: Status mirrors 'DM Sent' for op_message_sent (preserved
      // from src/campaign.js:1841 for back-compat with sheet conditional
      // formatting rules that key on 'DM Sent').
      out.status     = 'DM Sent';
      out.opStatus   = 'OP Sent';
      out.op         = hyperSent;
      out.stage      = 'OP Sent';
      out.auditAction = (mode === 'connect_only' && messageOpenProfiles)
        ? 'Open Profile message sent (via connect mode)'
        : 'Open Profile message sent';
      return out;

    case 'inmail_sent':
      out.status     = 'Done';
      out.inmStatus  = 'InM Sent';
      out.inmail     = hyperSent;
      out.stage      = 'InM Sent';
      out.auditAction = 'InMail sent';
      if (typeof creditsLeft === 'number') {
        out.auditNotes = `InMail credits left: ${creditsLeft}`;
      }
      return out;

    case 'status_accepted':
      out.status           = 'Check Done.';
      out.checkStatus      = 'Connected';
      out.cc               = 'Connected';
      out.connectedAlready = 'Yes';
      out.stage            = 'Connected · DM Now';
      out.auditAction      = 'Acceptance confirmed';
      return out;

    case 'status_pending':
      // Stage left unchanged on pending (prior code: no stage write).
      out.checkStatus = 'Still Pending';
      out.auditAction = 'Check Status: still pending';
      return out;

    case 'already_processed': {
      // Stamp Stage per mode so empty-Stage rows don't stay empty after
      // a re-run. Also re-stamps the relevant status column — when the
      // operator clears the sheet between runs, the prior status data is
      // gone, so stamping here repopulates it (the LinkedIn-side state is
      // the real source of truth: outreach.js returned already_processed
      // because the connect/DM/InMail is actually in flight).
      out.auditAction = 'Already in target state';
      if (mode === 'connect_only' || mode === 'connect_and_introduce') {
        out.stage            = 'Connect Pending';
        out.status           = 'Connection Request Sent';
        out.connectionStatus = 'Connection Request Sent';
      }
      else if (mode === 'message_only')     {
        out.stage = introMode ? 'IC Sent' : 'DM Sent';
        out.status = out.stage;
        out.dmStatus = out.stage;
      }
      else if (mode === 'introduce_back')   { out.introStatus = 'IC Sent'; /* v2.59: IC writes only Introduction Status — see message_sent above */ }
      else if (mode === 'inmail_only')      { out.stage = 'InM Sent'; out.status = 'InM Sent'; out.inmStatus = 'InM Sent'; }
      else if (mode === 'open_profile_only') { out.stage = 'OP Sent'; out.status = 'OP Sent'; out.opStatus = 'OP Sent'; }
      return out;
    }

    default:
      // Unknown action — return minimal payload so the caller can still
      // log audit info, no column writes.
      return out;
  }
}

/**
 * Pure helper: routes a normalized skip reason to the mode-specific column
 * + mirrors into Status + Stage. Used by every skip branch in the per-lead
 * loop so skip reasons land in the right place under the v2 schema.
 *
 * @param {string} mode             - active campaign mode
 * @param {string} normalizedReason - already passed through normalizeSkipReason()
 * @param {string} profileName      - sender label
 * @returns {object} sheetData
 */
export function buildSkipSheetData(mode, normalizedReason, profileName = '') {
  // normalizeSkipReason already produces "Skipped: <reason>" — Stage + Status
  // mirror that verbatim. The mode-specific column also receives the prefix
  // so the operator sees the skip reason in the column matching the campaign
  // they ran.
  const out = {
    sender: profileName,
    stage:  normalizedReason,
    status: normalizedReason
  };
  switch (mode) {
    case 'connect_only':       out.connectionStatus = normalizedReason; break;
    case 'check_status':       out.checkStatus      = normalizedReason; break;
    case 'message_only':       out.dmStatus         = normalizedReason; break;
    case 'introduce_back':     out.introStatus      = normalizedReason; break;
    case 'open_profile_only':  out.opStatus         = normalizedReason; break;
    case 'inmail_only':        out.inmStatus        = normalizedReason; break;
  }
  return out;
}

export async function startCampaign({ profileIds, sheetUrl, templates, dailyLimit = 50, mode = 'connect_only', messageOpenProfiles = false, delayMin = 15, delayMax = 45, linkedinColumn = '', senderFirstNames = {}, concurrency = 1, name = '', acceptanceTrackingDays = 0, preflightCheckStatus = false, checkIntervalMinutes = 60, createdBy = null, senderColumn = '', allLeadsConnected = false, resumeContext = null }) {
  if (campaign.running) throw new Error('Campaign already running');

  // v2.58.x — IC-only options. Coerced to defaults outside introduce_back
  // mode so accidental flagging from other code paths cannot change
  // unrelated campaign behavior.
  if (mode !== 'introduce_back') {
    senderColumn = '';
    allLeadsConnected = false;
  }

  // v2.14.x: snapshot for restoreCampaign(). Captured BEFORE anything can
  // throw, so even a campaign that fails preflight is recoverable.
  _lastRunSettings = {
    profileIds, sheetUrl, templates, dailyLimit, mode, messageOpenProfiles,
    delayMin, delayMax, linkedinColumn, senderFirstNames, concurrency,
    name, acceptanceTrackingDays, preflightCheckStatus, createdBy,
    senderColumn, allLeadsConnected,
  };

  campaign.running = true;
  campaign.createdBy = createdBy || null;
  // v2.58.x — pick up the launcher's stored timezone so sheet timestamps
  // land in their local clock. Empty string resets any prior campaign's
  // value (one-campaign-at-a-time invariant means no race). Best-effort:
  // any read failure falls back to no tz, which preserves pre-feature
  // behavior (GAS uses Session.getScriptTimeZone()).
  try {
    const prefs = createdBy ? await getOperatorPrefs(createdBy) : null;
    setOperatorTz(prefs?.tz || '');
  } catch { setOperatorTz(''); }
  campaign._abort = false;
  campaign._stoppedManually = false;
  campaign._skipCleanup = false;
  // v2.52.0: capture this loop's generation. Any prior loop still in flight
  // (e.g. after restoreCampaign re-launched without waiting for the old loop
  // to fully unwind) will see campaign._generation !== myGen on its next
  // iteration check and exit — even though we just reset _abort to false.
  // See _generation comment on the campaign object for full context.
  const myGen = ++campaign._generation;
  const isOrphan = () => campaign._generation !== myGen;
  // v2.14.x: reset monitoring state machine fields on every new run.
  // Without this, a prior run that reached "Monitoring ended" sets
  // campaign.state = 'done' (campaign.js:3072), which then carries over
  // to the next CC+IC run and causes transitionToMonitoring to early-
  // return silently (campaign-state-transitions.js:12). Symptom in the
  // field: fresh CC+IC campaign reaches 3/3, logs "Campaign ended", but
  // the cockpit stays IDLE instead of flipping to Monitoring.
  campaign.state = null;
  campaign.sendingEndedAt = null;
  campaign.monitoringUntil = null;
  campaign.nextCheckAt = null;
  campaign.participatingProfileIds = [];
  campaign.introducedInRun = new Set();
  campaign._paused = false;
  campaign._pauseRequested = false;
  campaign.currentProfile = null;
  // v2.59 (resume support): when resumeContext is supplied (client clicked
  // Resume on a stopped campaign), seed the run-level counters from the
  // previous run's totals so the cockpit + history continue from where
  // they left off instead of resetting to 0. processedToday stays 0 — it's
  // a today-only counter, and resuming on a NEW day shouldn't pretend the
  // pre-resume day's sends happened today. The per-account dailyCounts
  // and per-URL `processed` map in state.json already preserve the
  // 'don't re-send' guarantee independently of these counters.
  const _resumeTotal = resumeContext && Number.isFinite(Number(resumeContext.totalProcessed)) ? Number(resumeContext.totalProcessed) : 0;
  campaign.processedToday = 0;
  campaign.totalProcessed = _resumeTotal;
  campaign.totalTargets = 0;
  campaign.mode = mode;
  // ISO timestamp marking when this campaign run began. Used by the
  // central Operations Log to route events to the correct per-campaign
  // tab (campaign name + startedAt is the tab key, so resumes append
  // to the same tab).
  campaign.startedAt = new Date().toISOString();
  campaign.profileNames = [];
  campaign.errors = [];
  campaign.parkedProfiles = [];
  campaign.softWarnings = [];
  campaign.profileEndReasons = [];
  campaign.name = (typeof name === 'string' ? name : '').trim();
  // v2.13.14: stash the wizard inputs on the campaign object so the
  // monitoring path (runMonitoringCheck → runAutoIntros) can read them
  // without being passed every arg explicitly. Without this, the post-
  // campaign auto-intro silently no-ops because `templates.primaryName`
  // is undefined inside runMonitoringCheck.
  campaign.templates = templates || {};
  campaign.senderFirstNames = senderFirstNames || {};
  campaign.sheetUrl = sheetUrl || '';
  campaign.linkedinColumn = linkedinColumn || '';
  // v2.58.x — IC-only sheet-mapping options exposed on campaign state so
  // restore/monitoring paths can read them back from a running campaign.
  campaign.senderColumn = senderColumn || '';
  campaign.allLeadsConnected = !!allLeadsConnected;
  // v2.14.x: operator-chosen cadence for the monitoring auto-trigger.
  // Read by transitionToMonitoring (initial nextCheckAt) and by
  // tickMonitoringNow (reschedule after each fire). Persisted via
  // monitoring-persistence so post-restart rehydration honors it.
  campaign.checkIntervalMinutes = checkIntervalMinutes;
  campaign._lastSample = null;   // phase 11.1: reset resource snapshot
  campaign._throttle   = null;   // phase 11.1: reset throttle state
  _resetSampleCache();           // clear module-level cache so first sample() is fresh
  browserSemaphore._reset();     // 2.9.9: reset hard browser cap to default
  browserSemaphore.setMax(MAX_CONCURRENT_PROFILES);

  // Reset campaign counts — allows reusing same accounts immediately
  for (const key of Object.keys(campaignCounts)) delete campaignCounts[key];

  // v2.14.x: defensive guard — if the campaign launches as connect_and_introduce
  // without the primary person fields, every accepted invite would silently
  // skip the auto-intro (runAutoIntros' internal early-return). The wizard's
  // Start handler now hard-blocks this case at click-time, but a queued or
  // restored campaign could still slip through if its persisted payload was
  // built before that guard existed. Surface a loud warning so the audit log
  // shows what happened.
  if (mode === 'connect_and_introduce') {
    const _pName = (templates && templates.primaryName || '').trim();
    const _pBody = (templates && templates.primaryIntroBody || '').trim();
    if (!_pName || !_pBody) {
      log('⚠ Connect+IntroBack started WITHOUT primary person fields — auto-intros will be skipped on every acceptance. Stop and reconfigure to enable intros.');
    }
  }

  // Normalize templates
  const tpl = {
    connectionNote: templates.connectionNote || templates.note || '',
    followUpMessage: templates.followUpMessage || templates.followUp1 || '',
    inmail: {
      subject: templates.inmail?.subject || templates.inmailSubject || '',
      message: templates.inmail?.message || templates.inmailBody || '',
    },
    openProfileSubject: templates.openProfileSubject || templates.opSubject || '',
    openProfileBody: templates.openProfileBody || templates.opBody || '',
    // 2.8.50: Introduction Messages — when introMode is true, sendMessage
    // routes to sendIntroMessage which adds introName as a second recipient
    // and sets a group title. Sheet stamp becomes "sent IC".
    // v2.11.17: introMode is now implied by mode === 'introduce_back'
    // (separate first-class mode); legacy presets that set introMode on
    // message_only still work because the client auto-migrates them, but
    // we OR the flag here as a final safety net.
    introMode: !!templates.introMode || mode === 'introduce_back',
    introName: (templates.introName || '').trim(),
    introTitle: templates.introTitle || 'Introduction: {first name} <> {intro name}',
  };

  const campaignStartTime = Date.now();

  // Central Operations Log: mark the start of this campaign run.
  _ops('INFO', 'Campaign started', {
    details: `mode: ${mode} · ${Array.isArray(profileIds) ? profileIds.length : 0} account(s) · daily limit: ${dailyLimit}`,
  });

  // v2.11.7: track how the run ended so the dashboard badge can say
  // "completed" / "stopped" / "errored" instead of always "completed".
  // Resolved once in finally — catch sets 'errored', operator-stop sets
  // 'stopped' from campaign._abort, otherwise stays 'completed'.
  let endReason = 'completed';

  // Referenced by the finally block (end-of-list bulk-check + monitoring
  // handoff), so it must live outside the try below.
  const profilesThatSentAtLeastOne = new Set();

  try {
    rotateCampaignLogIfBig();
    log('=== Campaign starting ===');
    log(`Mode: ${mode}`);
    log(`Profiles: ${profileIds.length} selected`);
    const _NO_LIMIT_MODES = new Set(['check_status', 'message_only', 'introduce_back', 'inmail_only', 'open_profile_only']);
    log(`Campaign limit per account: ${_NO_LIMIT_MODES.has(mode) ? 'unlimited (fast-mode)' : dailyLimit}`);
    if (!_NO_LIMIT_MODES.has(mode)) {
      log(`  (set in launch wizard — adjust under "Campaign limit per account" before next run if this isn't what you expected)`);
    }
    if (concurrency > 1) {
      log(`▶ Concurrency=${concurrency} workers (browser cap=${MAX_CONCURRENT_PROFILES}).`);
    }
    log(`Templates: note=${tpl.connectionNote ? '✓' : '—'} followUp=${tpl.followUpMessage ? '✓' : '—'} inmail=${tpl.inmail.subject ? '✓' : '—'}`);
    if (linkedinColumn) log(`LinkedIn column: "${linkedinColumn}"`);
    if (messageOpenProfiles) log('Open Profile messaging: ON');

    // Preflight: warn if the host is already under heavy load.
    // Non-blocking — operator decides whether to continue.
    const health = await checkHostHealth();
    if (!health.ok) {
      log('⚠ Your machine is under heavy load — close some apps or the campaign may fail.');
      for (const w of health.warnings) log(`   • ${w}`);
    }

    // ── Fetch leads from Google Sheet ──
    log('Fetching sheet…');
    const rows = await fetchSheetRows(sheetUrl);
    log(`${rows.length} row(s). Columns: ${Object.keys(rows[0] || {}).join(', ')}`);

    // v2 schema: prepareSheet provisions only this mode's columns and hides
    // every other mode's columns. Apps Script returns BAD_MODE only on
    // unknown modes — known modes always provision/hide. Fall back to the
    // legacy ensureTrackingColumns path when prepareSheet doesn't confirm
    // (e.g. SHEETS_WEBAPP_URL not set, or bridge not redeployed yet).
    const prep = await prepareSheet(sheetUrl, mode).catch(err => {
      log(`⚠ prepareSheet failed: ${err.message}`);
      return { ok: false };
    });
    if (!prep.ok) {
      log('  ⚠ prepareSheet didn\'t confirm — falling back to legacy ensureTrackingColumns');
      await ensureTrackingColumns(sheetUrl, mode).catch(err => {
        log(`⚠ Could not ensure tracking columns: ${err.message}`);
      });
    } else if (prep.hidden?.length) {
      log(`  ℹ Hidden columns from prior modes: ${prep.hidden.join(', ')}`);
    }

    const state = await loadState();

    // Hotfix 2.8.24-P1: clear stale _in_progress markers from previous runs.
    // These accumulate from (a) exceptions in the per-lead catch at the bottom
    // of the inner loop, (b) WEEKLY_LIMIT / INMAIL_NO_CREDITS branches that
    // don't clean up, and (c) hard crashes mid-lead. Without this, leads stuck
    // _in_progress are invisible to the pre-filter for STATE_RETENTION_DAYS.
    const stalePending = Object.entries(state.processed).filter(
      ([, v]) => v?.action === '_in_progress'
    );
    if (stalePending.length > 0) {
      log(`Clearing ${stalePending.length} stale _in_progress marker(s) from previous run`);
      for (const [url] of stalePending) delete state.processed[url];
      await saveState(state);
    }

    // v2.14.x: Resume support — seed campaignCounts from today's entries in
    // state.processed so an account that already sent N leads today (whether
    // on this campaign or one stopped earlier today) keeps that count instead
    // of resetting to 0/dailyLimit. This is what makes "Resume same settings"
    // pick up where the prior run left off, AND it cumulatively caps daily
    // activity so LinkedIn's per-day quotas can't be blown by stop-and-restart.
    // Skip-only actions don't count toward the daily send total.
    const _todayPrefix = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
    const _skipActions = new Set(['_in_progress', 'email_required', 'not_open_profile']);
    let _seedTotal = 0;
    for (const entry of Object.values(state.processed)) {
      if (!entry || !entry.profileId || !entry.date) continue;
      if (!entry.date.startsWith(_todayPrefix)) continue;
      if (_skipActions.has(entry.action)) continue;
      if (!profileIds.includes(entry.profileId)) continue;
      campaignCounts[entry.profileId] = (campaignCounts[entry.profileId] || 0) + 1;
      _seedTotal++;
    }
    if (_seedTotal > 0) {
      const summary = Object.entries(campaignCounts)
        .filter(([, n]) => n > 0)
        .map(([pid, n]) => {
          const pName = profileNameCache[pid] || (pid === 'local-browser' ? 'You' : pid);
          return `${pName} ${n}/${dailyLimit}`;
        }).join(' · ');
      log(`▶ Resuming today's counts: ${summary}`);
    }

    // Pre-filter targets. Filter rules (new schema):
    //   - check_status: only process rows with CC="Sent" (pending invites).
    //   - all other modes: skip rows where Status="Done".
    //   - connect_only: additionally require no prior CC history.
    //   - messaging modes (OP/DM/InMail): additionally skip rows where
    //     the campaign-specific column is already filled.
    // 2.9.0: detect new schema. If the sheet has a Stage column, Stage is
    // the single source of truth for filtering. Old sheets fall through to
    // the legacy CC/OP/Message/InMail logic below — unchanged.
    const hasStageSchema = rows.length > 0 && ('Stage' in rows[0] || 'stage' in rows[0]);

    // v2.58.x — Introduction Campaign + "all leads already connected"
    // bypass. When the operator has confirmed the sheet contains only
    // 1st-degree connections, skip the Stage gate entirely so a plain
    // sheet (no Stage column) works. Re-runs are still blocked because
    // a successful send stamps 'Introduction Status = IC Sent' which we
    // honor as the terminal-marker here. Failed rows (Introduction
    // Status starts with "Failed —") remain retryable.
    const icAllConnectedBypass = (mode === 'introduce_back' && allLeadsConnected);
    if (icAllConnectedBypass) {
      log(`Introduction Campaign · "all leads already connected" — Stage filter bypassed.`);
    }

    const targets = rows.filter(row => {
      const url = extractLinkedInUrl(row, linkedinColumn);
      if (!url) return false;

      if (icAllConnectedBypass) {
        // v2.59 split IC into its own "Intro Status" column (short-form,
        // operator-friendly). CC+IC's auto-intro still writes the legacy
        // "Introduction Status" (long-form) via auto-intro.js. The bypass
        // must check BOTH headers so an IC re-run on a previously-sent
        // sheet (regardless of which column header it has) treats
        // "IC Sent" as terminal. Without both aliases, an operator with
        // a "Intro Status" sheet would re-send already-sent rows at the
        // filter stage (the in-loop re-validation at L2206 caught it
        // eventually but only after wasted profile navigation).
        const introStatus = (
          row['Intro Status'] || row['intro status'] || row['Intro status'] ||
          row['Introduction Status'] || row['introduction status'] ||
          row['Introduction status'] || row['introStatus'] || ''
        ).toString().trim();
        // Already sent → terminal. Anything else (blank or "Failed —" reason)
        // is eligible for this run.
        if (introStatus === 'IC Sent') return false;
        return true;
      }

      // ── 2.9.0 Stage-based filtering ─────────────────────────────
      if (hasStageSchema) {
        const stage = (row['Stage'] || row['stage'] || '').toString().trim();
        const TERMINAL = new Set(['DM Sent', 'IC Sent', 'InM Sent', 'OP Sent', 'Replied', 'Done']);
        // 2.9.10: Stage may now carry the full skip reason
        // (e.g., "Skipped: URL not found"), not just bare "Skipped". Any value
        // starting with "Skipped" is terminal.
        const isSkipped = stage.startsWith('Skipped');

        // v2.11.15: with the Stage schema, the Stage cell is the single
        // source of truth for "is this row processable". The local
        // state.processed file used to layer an extra block, but that
        // meant a manual sheet edit (e.g. operator resets Stage to
        // 'Connected · DM Now' to re-test) was silently overruled by a
        // stale local marker. Drop the state.processed[url] checks here;
        // Stage carries the same information from the bridge writeback,
        // and the in-loop _in_progress marker (line ~1431) still
        // prevents two workers from racing on the same lead within one
        // run. Trade-off: if the sheet write fails after a successful
        // send, the next run could re-send. Acceptable given the
        // ergonomic win — and Stage writebacks have been reliable.
        if (mode === 'check_status') {
          return stage === 'Connect Pending';
        }
        if (mode === 'introduce_back') {
          // v2.59: IC tabs are separate from connection tabs and don't
          // necessarily have a Stage column. Filter reads only from the
          // Intro Status column — blank = process, anything else (IC Sent,
          // Failed — …, operator note, anything) = skip.
          // Header name per google-apps-script.js:319 is 'Intro Status';
          // long-form aliases kept for back-compat. Mirrored in the
          // in-loop re-validation below (~line 2188).
          const introStatus = (
            row['Intro Status'] || row['intro status'] || row['Intro status'] ||
            row['Introduction Status'] || row['introduction status'] ||
            row['Introduction status'] || row['introStatus'] || ''
          ).toString().trim();
          return introStatus === '';
        }
        if (mode === 'message_only') {
          // message_only is 'coming soon' in v2.59 but logic kept intact.
          // v2.14.x rationale: accept any row that represents a known
          // connection regardless of which path stamped it.
          return isDmIbEligible(row);
        }
        // Cold-lead modes — operator-confirmed: process only blank-Stage
        // rows. Any non-blank value means 'leave alone' (either a prior
        // run touched it, it's terminal, or it's a manual note).
        if (mode === 'connect_only' || mode === 'connect_and_introduce') {
          return stage === '';
        }
        if (mode === 'inmail_only' || mode === 'open_profile_only') {
          // InMail and OP are 'coming soon' in v2.59 but kept aligned with
          // the cold-lead rule above for consistency if re-enabled.
          return stage === '';
        }
        // Other modes: terminal stages skip, everything else passes through.
        if (TERMINAL.has(stage) || isSkipped) return false;
        return true;
      }

      // ── Legacy schema filtering (sheets without a Stage column) ──
      const status    = (row['Connection Status'] || row['connection status'] || row['Status']  || row['status']  || '').toString().toLowerCase().trim();
      const cc        = (row['CC']      || row['cc']      || '').toString().toLowerCase().trim();
      const opCell    = (row['OP']      || row['op']      || '').toString().toLowerCase().trim();
      const msgCell   = (row['Message'] || row['message'] || '').toString().toLowerCase().trim();
      const inmailCell= (row['InMail']  || row['inmail']  || '').toString().toLowerCase().trim();
      const msgSent   = msgCell === 'sent' || opCell === 'sent';

      if (mode === 'check_status') {
        // 2.8.29: Account Used (column D) being filled = an invite was sent.
        // CC text is no longer the source of truth.
        const acct = getSenderName(row, senderColumn);
        return acct.length > 0;
      }

      if (mode === 'message_only') {
        // 2.8.31: messageable = Voyager-confirmed connection (CC ends with " Y")
        // AND no message/OP sent yet.
        // Status="Check Done." rows are EXPLICITLY allowed — they're the only
        // rows that have ever been verified. The status==='done' filter below
        // would otherwise reject every accepted invite.
        if (msgSent) return false;
        // 2.8.33: only block on state.processed when action proves a DM was
        // actually sent in a prior run (P-04 safety net for the case where the
        // LinkedIn send succeeded but the Sheets write failed). status_accepted
        // / connection_sent etc. are NOT blockers — they're exactly the rows we
        // want to message. The inner-loop lead picker (line ~1154) already
        // exempts message_only from the blanket state.processed skip; the
        // pre-filter must match.
        const prev = state.processed[url];
        if (prev && (prev.action === 'message_sent' || prev.action === 'op_message_sent')) return false;
        // Connected Status (was CC) = 'Connected' is the new
        // verified-acceptance signal, replacing the legacy " Y" suffix.
        // Tolerate both for sheets mid-migration.
        const ccRaw = (row['Connected Status'] || row['connected status'] || row['CC'] || row['cc'] || '').toString().trim();
        const isConnected = ccRaw === 'Connected' || /\sY\s*$/.test(ccRaw);
        if (!isConnected) return false;
        return true;
      }

      if (status === 'done') return false;

      if (mode === 'connect_only' || mode === 'connect_and_introduce') {
        // Per-tab source of truth: only the Status column gates re-processing.
        // CC may carry residual data from past attempts (sender name, status
        // colours, "—" placeholder) and is no longer a blocker on its own.
        // Status is checked at line 908 above (== 'done') and broadened here
        // to catch the new 'Connection Request Sent' value plus any other
        // non-blank value the operator may have filled in.
        if (status) return false;
        if (messageOpenProfiles && opCell === 'sent') return false;
        return true;
      }

      if (mode === 'open_profile_only') {
        if (msgSent) return false;
        return true;
      }

      if (mode === 'inmail_only') {
        if (inmailCell === 'sent') return false;
        return true;
      }

      return true;
    });
    log(`Pre-filter → ${targets.length} to process, ${rows.length - targets.length} skipped (mode: ${mode})`);
    campaign.totalTargets = targets.length;

    // Load profile names
    log('Loading profile names…');
    // 2.8.29: in check_status mode profileIds starts empty (auto-derived from
    // sheet below) — but we still need the GoLogin token to fetch the profile
    // list and resolve Account Used → profile id. Always grab the token here.
    const hasGoLoginProfiles = profileIds.some(id => id !== 'local-browser');
    // 2.8.31: message_only also auto-derives profileIds from sheet (only the
    // sender that connected the lead can DM it), so we need the GoLogin token
    // even when the UI didn't pre-select profiles.
    const tokenNeeded = hasGoLoginProfiles || mode === 'check_status' || mode === 'message_only' || mode === 'introduce_back';
    const token = tokenNeeded ? getToken() : null;
    for (const pid of profileIds) {
      if (pid === 'local-browser') {
        // 2.9.1: display name is "You" (was "Local Browser"). Sheet writeback
        // and dashboard pick this up via profileNameCache.
        profileNameCache[pid] = 'You';
      } else {
        await getProfileName(pid, token);
      }
    }

    // 2.8.28-P2: per-profile target slices (named for legacy reasons; used by
    // BOTH check_status and message_only since 2.8.31). Consumed by the inner
    // loop's per-profile cursor logic.
    let _checkStatusTargetsByProfile = null;

    // 2.8.28 (Check Status routing) / 2.8.31 (extended to message_only):
    // For modes where each row can only be processed by its original sender
    // (check_status — only the sender knows; message_only — only the sender
    // is connected), ignore UI-selected profileIds and auto-derive from
    // Account Used. Using any other account silently fails Voyager checks.
    if (mode === 'check_status' || mode === 'message_only' || mode === 'introduce_back') {
      // Refresh the cache to ensure newly-added profiles are visible.
      if (token) {
        try {
          const all = await getProfiles(token);
          profileNameCache = {};
          for (const p of all) profileNameCache[p.id] = p.name;
        } catch (err) {
          log(`⚠ Could not refresh GoLogin profile list: ${err.message}`);
        }
      }
      const nameToId = {};
      Object.keys(profileNameCache).forEach(id => { nameToId[profileNameCache[id]] = id; });
      // 2.8.29: Local browser is a valid pseudo-profile. Sheets store its
      // Account Used as variants like "local-browser", "local-browser - manual",
      // or "Local Browser" — all map to the single 'local-browser' pseudo-id.
      // 2.9.1: keep all historical display names mapped back to the canonical
      // 'local-browser' id so existing sheet rows still auto-route correctly.
      nameToId['You']                    = 'local-browser';
      nameToId['Local Browser']          = 'local-browser';
      nameToId['local-browser']          = 'local-browser';
      nameToId['local-browser - manual'] = 'local-browser';

      const sendersInSheet = new Map(); // name -> count (uses display name)
      const unmatchedSenders = new Map(); // name -> count
      for (const row of targets) {
        const acct = getSenderName(row, senderColumn);
        if (!acct) {
          unmatchedSenders.set('(blank)', (unmatchedSenders.get('(blank)') || 0) + 1);
          continue;
        }
        if (nameToId[acct]) {
          // For local-browser variants, bucket under the canonical "You" label. (2.9.1)
          const displayName = (nameToId[acct] === 'local-browser') ? 'You' : acct;
          sendersInSheet.set(displayName, (sendersInSheet.get(displayName) || 0) + 1);
        } else {
          unmatchedSenders.set(acct, (unmatchedSenders.get(acct) || 0) + 1);
        }
      }

      const derivedProfileIds = [];
      for (const name of sendersInSheet.keys()) {
        derivedProfileIds.push(nameToId[name]);
      }

      const modeLabel = (mode === 'check_status') ? 'Check Status'
                      : (mode === 'introduce_back') ? 'Introduce Back'
                      : 'Message Only';
      const rowLabel = (mode === 'check_status') ? 'pending' : 'connected (Y)';
      log(`${modeLabel} auto-routing → ${derivedProfileIds.length} sender(s) found in sheet`);
      sendersInSheet.forEach((count, name) => log(`  • ${name}: ${count} ${rowLabel}`));
      if (unmatchedSenders.size > 0) {
        log(`⚠ Skipping ${[...unmatchedSenders.values()].reduce((a,b)=>a+b,0)} row(s) whose Sender is unknown:`);
        unmatchedSenders.forEach((count, name) => log(`  • ${name}: ${count} row(s) — no GoLogin profile matches`));
      }

      if (derivedProfileIds.length === 0) {
        log(`✗ ${modeLabel}: no sender accounts in the sheet match any GoLogin profile in this workspace.`);
        log('=== Campaign ended ===');
        campaign.running = false;
        campaign.endedAt = Date.now();
        return;
      }

      // Replace the UI-selected list with the derived list.
      profileIds = derivedProfileIds;
      // 2.8.29: ensure local-browser has a display name in the cache even when
      // it came from auto-derivation rather than UI selection.
      if (derivedProfileIds.includes('local-browser') && !profileNameCache['local-browser']) {
        profileNameCache['local-browser'] = 'You'; // 2.9.1: was 'Local Browser'
      }

      // 2.8.28-P2: Build per-profile target lists. Without this, the shared
      // round-robin leadIndex would burn BATCH_SIZE slots per profile on
      // skipped non-matching rows — every profile would close with 0
      // processed. Each profile gets its own slice and its own cursor below.
      _checkStatusTargetsByProfile = {};
      for (const pid of derivedProfileIds) _checkStatusTargetsByProfile[pid] = [];
      for (const row of targets) {
        const acct = getSenderName(row, senderColumn);
        const pid = nameToId[acct];
        if (pid && _checkStatusTargetsByProfile[pid]) {
          _checkStatusTargetsByProfile[pid].push(row);
        }
      }
    }

    campaign.profileNames = profileIds.map(id =>
      profileNameCache[id] || (id === 'local-browser' ? 'You' : id)
    );
    // Mirror the IDs alongside the names so the dashboard's per-row Open
    // Browser / Try Again buttons can call profile-specific endpoints.
    campaign.profileIds = profileIds.slice();
    log(`${Object.keys(profileNameCache).length} profiles in cache.`);

    // ── Phase 11.2: LAZY-LAUNCH BATCH LOOP ──
    // Profiles open on first batch (D-10). Each profile processes BATCH_SIZE leads
    // back-to-back, then either parks on about:blank (short gap) or closes + re-opens
    // next batch (long gap, D-13). Session break is gone (D-04). batchesPerHour sets
    // the target between-batch spacing (D-03).

    if (profileIds.length > 3) {
      log(`⚠ RAM warning: up to ${profileIds.length} browsers may be open simultaneously. 4 is fine, 10+ may slow your machine.`);
    }

    // Campaign-scoped session cache, replaces activeSessions array.
    const sessions = new Map(); // profileId → { profileId, pName, browser, page, warmedUp }

    /**
     * Lazy launch + warmup + health check. Called on first batch per profile;
     * subsequent batches short-circuit to the cached session (D-11 — 20s warmup
     * only on first open). Returns null if the profile cannot be made healthy.
     */
    async function ensureOpen(profileId) {
      // Phase 2.8.10: refuse to launch new browsers after stop has been
      // requested. Closes the launch-race that was leaving orphan windows
      // requiring a second Stop click to clean up.
      if (campaign._abort) return null;

      const cached = sessions.get(profileId);
      if (cached) return cached;

      // 2.9.2: never let the raw profileId 'local-browser' leak to the sheet
      // (it bypasses profileNameCache when that's stale). Force 'You'.
      const pName = profileNameCache[profileId] || (profileId === 'local-browser' ? 'You' : profileId);
      campaign.currentProfile = pName;

      // 2.9.9: hard browser cap is now enforced by the global semaphore in
      // browser-semaphore.js (replaces the old sessions.size >= cap check).
      // acquire() blocks until a slot is free — workers naturally serialize
      // when more want to launch than the cap allows.
      const semStatusBefore = browserSemaphore.getStatus();
      if (semStatusBefore.count >= semStatusBefore.max) {
        log(`  ⏸ ${pName}: waiting for browser slot (${semStatusBefore.count}/${semStatusBefore.max} in use)`);
      }
      await browserSemaphore.acquire();

      let success = false;
      try {
        if (campaign._abort) return null;
        log(`▶ Opening ${pName}…`);
        setAction('Opening browser', { account: pName });
        let launched;
        if (profileId === 'local-browser') {
          launched = await launchLocalBrowser();
        } else {
          launched = await launchProfile(profileId, token);
        }

        // Phase 2.8.10: abort may have fired DURING the launch above. Close
        // the just-launched browser immediately rather than letting it become
        // an orphan that survives /api/campaign/stop.
        if (campaign._abort) {
          log(`■ ${pName}: stop requested mid-launch — closing immediately.`);
          try {
            if (profileId === 'local-browser') await closeLocalBrowser();
            else await closeProfile(profileId);
          } catch { /* */ }
          return null;
        }

        const { page, ok, sessionExpired } = await ensureProfileLoggedIn(launched, profileId, pName);
        if (sessionExpired) {
          // Phase 2.8.20 (W2-A2): drop this profile from the round-robin and
          // surface in the right pane via parkedProfiles (W1-B1's mechanism).
          weeklyLimited.add(profileId);
          recordProfileEnd(profileId, pName, 'Session expired — log in again');
          campaign.parkedProfiles.push({
            profileId,
            pName,
            parkedAt: Date.now(),
            reason: 'session_expired',
          });
          // Close the now-unusable session immediately to free RAM
          try {
            if (profileId === 'local-browser') await closeLocalBrowser();
            else await closeProfile(profileId);
          } catch { /* */ }
          return null;
        }
        if (!ok) return null;
        if (campaign._abort) {
          try {
            if (profileId === 'local-browser') await closeLocalBrowser();
            else await closeProfile(profileId);
          } catch { /* */ }
          return null;
        }

        // 2.8.27: home-page warmup removed per operator request — saved ~20s
        // per profile launch. The cache-clear nav already loads LinkedIn home,
        // and the per-lead navigation has its own networkidle0 + DOM-settle
        // waits, so the additional dwell here was redundant.

        const session = { profileId, pName, browser: launched.browser, page, warmedUp: true };
        sessions.set(profileId, session);
        success = true;

        // Pre-flight / standalone Check Status. Three trigger paths:
        //   1. preflightCheckStatus toggle on message_only / introduce_back
        //   2. mode === 'check_status' — bulk-first, per-lead fallback on
        //      failure (Sam's bulk approach; falls back to existing per-lead
        //      navigation if Voyager fetch errors out).
        // Errors are non-fatal — campaign proceeds either way. Bypasses the
        // 6h cooldown (explicit operator action for this run), then refreshes
        // the cooldown timestamp so back-to-back sweeps don't pile up.
        const isCheckStatusMode = mode === 'check_status';
        const isPreflightMode = preflightCheckStatus
          && (mode === 'message_only' || mode === 'introduce_back');
        if (isCheckStatusMode || isPreflightMode) {
          let bulkSucceeded = false;
          try {
            const label = isCheckStatusMode ? 'Check Status (bulk)' : 'Pre-flight Check Status';
            log(`  📡 [${pName}] ${label} sweep…`);
            const r = await bulkCheckConnections(page, sheetUrl, linkedinColumn, pName);
            if (r.error) {
              log(`  ⚠ [${pName}] Bulk check: ${r.error}`);
            } else {
              const stamped = r.stamped || 0;
              log(`  ✓ [${pName}] Bulk: ${r.matched} Connected, ${stamped} Still Pending (of ${r.fetched} fetched)`);
              bulkSucceeded = true;
            }
            try {
              const _sheetId = _extractSheetIdFromUrl(sheetUrl);
              const cooldown = await readBulkCheckCooldown();
              cooldown[bulkCheckKey(_sheetId, profileId)] = Date.now();
              await writeBulkCheckCooldown(cooldown);
            } catch { /* cooldown bookkeeping is best-effort */ }
          } catch (err) {
            log(`  ⚠ [${pName}] Bulk check threw: ${err.message}`);
          }

          // check_status: bulk handles ALL of this account's pending leads in
          // one Voyager call (marks Connected for matches, Still Pending for
          // unmatched-but-invited). When bulk succeeds, the per-lead loop
          // would just re-do work the bulk already did — close the profile so
          // the account rotation moves on. When bulk FAILS, fall through to
          // the existing per-lead navigation (Sam's approach failed → ours).
          if (isCheckStatusMode && bulkSucceeded) {
            log(`  ✓ [${pName}] check_status complete via bulk — closing profile`);
            recordProfileEnd(profileId, pName, 'Check Status complete (bulk)');
            weeklyLimited.add(profileId);
          }
        }

        return session;
      } catch (err) {
        log(`✗ ${pName}: failed to open — ${err.message}`);
        pushError(err);
        return null;
      } finally {
        // Release the slot if we didn't return a live session — closeSession()
        // is responsible for releasing in the success path.
        if (!success) browserSemaphore.release();
      }
    }

    /**
     * Close a single profile's browser, timing the operation (Q5 observability).
     * Serialized by the caller — only one close at a time (Pitfall 5 resolution).
     * Guards against double-close via sessions.get() guard.
     */
    async function closeSession(profileId) {
      const s = sessions.get(profileId);
      if (!s) return { durationMs: 0 };
      const t0 = Date.now();
      try {
        if (profileId === 'local-browser') {
          await closeLocalBrowser();
        } else {
          const pages = await s.browser.pages().catch(() => []);
          for (const p of pages) {
            try { await p.close(); } catch { /* */ }
          }
          await s.browser.close().catch(() => {});
          await closeProfile(profileId);
        }
        const durationMs = Date.now() - t0;
        log(`✓ ${s.pName} browser closed. ⏱ close duration ${durationMs}ms`);
        sessions.delete(profileId);
        browserSemaphore.release();
        return { durationMs };
      } catch (e) {
        const durationMs = Date.now() - t0;
        log(`Close ${s.pName}: ${e.message} (⏱ ${durationMs}ms)`);
        sessions.delete(profileId);
        browserSemaphore.release();
        return { durationMs };
      }
    }

    /**
     * v2.14 — idle bulk-check. Briefly reopens a parked profile, fires
     * bulkCheck + runAutoIntros, closes. Respects browserSemaphore. Failures
     * non-fatal. Called from the worker-pool loop when shouldFireIdleBulkCheck
     * returns true for a profile.
     */
    async function runIdleBulkCheck(profileId, pName) {
      await browserSemaphore.acquire();
      let launched;
      try {
        log(`  📡 [${pName}] Idle bulk-check — briefly reopening profile…`);
        launched = await launchProfile(profileId, token);

        const willAutoIntro = !!(
          templates && templates.primaryName && templates.primaryName.trim() &&
          templates.primaryIntroBody && templates.primaryIntroBody.trim()
        );
        const r = await bulkCheckConnections(launched.page, sheetUrl, linkedinColumn, pName, {
          // v2.14.x: stamp Connection Accepted immediately at bulk-check detection
          // so the operator sees acceptance in the sheet BEFORE the intro DM fires.
          // The auto-intro pass then only stamps Introduction Status (no longer
          // batched into a single Apps Script write).
          suppressAcceptedStamp: false,
        });
        if (r.error) {
          log(`  ⚠ [${pName}] Idle bulk-check: ${r.error}`);
        } else {
          const stamped = r.stamped || 0;
          log(`  📡 [${pName}] Idle bulk-check: ${r.matched} Connected, ${stamped} Still Pending (of ${r.fetched})`);
        }

        if (willAutoIntro && Array.isArray(r.connectedUrls) && r.connectedUrls.length > 0) {
          await runAutoIntros({
            page: launched.page,
            profileId,
            profileName: pName,
            sheetUrl,
            linkedinColumn,
            connectedUrls: r.connectedUrls,
            templates,
            senderFirstNames,
            log,
          });
        }

        // Update cooldown
        const _sheetId = _extractSheetIdFromUrl(sheetUrl);
        const cooldown = await readBulkCheckCooldown();
        cooldown[bulkCheckKey(_sheetId, profileId)] = Date.now();
        await writeBulkCheckCooldown(cooldown);
      } catch (err) {
        log(`  ⚠ [${pName}] Idle bulk-check failed: ${err.message}`);
      } finally {
        try {
          if (profileId === 'local-browser') await closeLocalBrowser();
          else await closeProfile(profileId);
        } catch { /* */ }
        browserSemaphore.release();
      }
    }

    let leadIndex = 0;
    let totalDone = 0;
    let totalVisited = 0;
    let leadsExhausted = false;
    // 2.8.28-P2: per-profile cursors for check_status mode (each profile has
    // its own targets slice in _checkStatusTargetsByProfile from the auto-
    // derivation block above). Exhaustion is tracked per-profile too — the
    // campaign ends when every derived profile has run out of its own rows.
    const _checkStatusCursorByProfile = {};
    const _checkStatusExhausted = new Set();
    const weeklyLimited = new Set(); // Profiles that hit weekly/credit limit
    // Phase 2.8.8: silent-failure guard — if a profile produces N
    // consecutive non-success outcomes, park it for the rest of the run.
    // Catches silent weekly-limit exhaustion and any other systemic per-account
    // failure pattern that our explicit detectors miss.
    // v2.11.2: OP/InM use 15 instead of BATCH_SIZE. The lead-quality signal in
    // these modes is unreliable (we only see Premium badge, not OP-eligibility;
    // InMail credits running out makes the compose box silently fail to mount)
    // so 5-in-a-row was triggering false parks on healthy accounts. 15 still
    // catches genuinely-broken accounts (logged out, banned mid-run).
    const SKIP_PARK_THRESHOLD =
      (mode === 'open_profile_only' || mode === 'inmail_only') ? 15 : BATCH_SIZE;
    const consecutiveSkips = new Map();
    // 429-specific consecutive counter. LinkedIn's Voyager API returns HTTP
    // 429 overwhelmingly for the weekly invitation cap (rather than transient
    // throttle, which the 6-min per-profile turn floor already prevents).
    // Three strikes is treated as weekly-limit-reached — park the profile and
    // rotate to the next.
    const consecutive429s = new Map();
    const HTTP_429_PARK_THRESHOLD = 3;
    // Expose a closure that retryParkedProfile() can call to clear all the
    // local skip counters + drop the profile from weeklyLimited so the next
    // rotation considers it again. Cleared in the finally block at end-of-run.
    campaign._unparkProfile = (profileId) => {
      weeklyLimited.delete(profileId);
      consecutiveSkips.set(profileId, 0);
      consecutive429s.set(profileId, 0);
    };

    log(`\n✓ Starting batch loop (BATCH_SIZE=${BATCH_SIZE})…\n`);

    // 2.9.8: modes that bypass the daily limit entirely.
    //   - check_status: read-only Voyager fetch, zero LinkedIn-visible action
    //   - message_only: DMs to 1st-degree connections, low risk
    //   - inmail_only: paid InMail credits already gate volume
    //   - open_profile_only: free Open-Profile messages, no connection req
    // Connect campaigns (connect_only) STILL respect the dailyLimit —
    // LinkedIn rate-limits connection requests aggressively.
    const NO_DAILY_LIMIT = new Set(['check_status', 'message_only', 'introduce_back', 'inmail_only', 'open_profile_only']);
    const skipsDailyLimit = NO_DAILY_LIMIT.has(mode);

    // ═════════════════════════════════════════════════════════════════════
    // 2.9.9 — Rotating-batch worker pool (replaces strict round-robin).
    //
    // Each worker pulls the next eligible profile from profileQueue, runs a
    // turn (up to BATCH_SIZE attempts), then yields its slot. When the turn
    // ends, the profile re-enqueues at the back and a per-profile cooldown
    // is set. Browser semaphore caps total open browsers regardless of how
    // many workers are spinning.
    //
    // pickNextProfile() filters out:
    //   - profiles already mid-turn (no double-run)
    //   - weeklyLimited / ejected profiles
    //   - profiles at daily cap (Q9-a "skip and advance")
    //   - profiles whose cooldown hasn't expired
    // If nothing's available, the worker idles 5s and rechecks (Q9-b fallback).
    // ═════════════════════════════════════════════════════════════════════
    const profileQueue = [...profileIds];
    const profilesBeingRun = new Set();
    const profileCooldownUntil = new Map();
    // v2.11.0: dropped batchesPerHour. Per-profile cooldown is now a fixed 6-min
    // floor — protects the eject-cascade scenario (when most profiles drop out
    // mid-run, the survivors would otherwise hammer LinkedIn at unsafe rates).
    // For multi-profile pools the queue rotation is the natural pacer; this
    // floor only kicks in when the pool shrinks.
    const TURN_COOLDOWN_FLOOR_MS = 6 * 60 * 1000;
    const cooldownMs = skipsDailyLimit ? 0 : TURN_COOLDOWN_FLOOR_MS;
    if (concurrency > 1) {
      log(`Concurrency: ${concurrency} workers, browser cap: ${MAX_CONCURRENT_PROFILES}`);
    }
    if (cooldownMs > 0) {
      log(`Per-profile turn floor: ${(cooldownMs / 60000).toFixed(0)}min (queue rotation is the primary pacer).`);
    }


    function pickNextProfile() {
      const now = Date.now();
      for (let i = 0; i < profileQueue.length; i++) {
        const candidate = profileQueue[i];
        if (profilesBeingRun.has(candidate)) continue;
        if (weeklyLimited.has(candidate)) continue;
        if (!skipsDailyLimit && getCampaignCount(candidate) >= dailyLimit) continue;
        if (now < (profileCooldownUntil.get(candidate) || 0)) continue;
        profileQueue.splice(i, 1);
        profilesBeingRun.add(candidate);
        return candidate;
      }
      return null;
    }

    function noProfilesLeftEver() {
      // True only when nobody can ever run again: nobody mid-turn AND every
      // queued profile is permanently out (weekly-limited or daily-capped).
      // Cooldown alone doesn't count as "out" — that's a wait, not exhaustion.
      if (profilesBeingRun.size > 0) return false;
      if (profileQueue.length === 0) return true;
      return profileQueue.every(id =>
        weeklyLimited.has(id) ||
        (!skipsDailyLimit && getCampaignCount(id) >= dailyLimit)
      );
    }

    /**
     * Run one turn for a single profile: open → up to BATCH_SIZE attempts → close/park.
     * Returns nothing — side-effects via shared closures (state, sessions,
     * weeklyLimited, consecutiveSkips, leadsExhausted).
     */
    async function runProfileTurn(profileId) {
        if (campaign._abort || isOrphan()) return;
        if (leadsExhausted) return;

        const session = await ensureOpen(profileId);
        if (!session) return; // opened-but-unhealthy OR launch failed

        const { pName, browser } = session;
        let { page } = session;
        campaign.currentProfile = pName;

        const batchStart = Date.now();

        // ── Inner: up to BATCH_SIZE leads for this profile ──
        // 2.8.29: check_status drains every row for this profile in one go.
        // 2.8.34: message_only does the same — open the browser, send to all
        // accepted connections back-to-back, close. No batching, no rotation.
        const innerLimit = (mode === 'check_status' || mode === 'message_only' || mode === 'introduce_back') ? Infinity : BATCH_SIZE;
        for (let leadInBatch = 0; leadInBatch < innerLimit && !campaign._abort && !isOrphan(); leadInBatch++) {
        // Phase 2.8.9: pause check at the lead boundary — never mid-lead.
        await awaitUnpause(myGen);
        if (campaign._abort || isOrphan()) break;
        // ── Phase 11.1: per-iteration resource sample + throttle decision ──
        // Pattern: RESEARCH.md §Pattern 2 (cached sample) + §Pattern 3 (multiplicative composition).
        // Writes campaign._lastSample and campaign._throttle for the status endpoint to read.
        try {
          const activePids = [...sessions.values()]
            .filter(s => s.profileId !== 'local-browser')
            .map(s => getProfilePid(s.profileId))
            .filter(Boolean);
          campaign._lastSample = await rmSample(activePids);
          const prevThrottle = campaign._throttle || { active: false, reason: '', multiplier: 1 };
          const nextThrottle = decideThrottle(prevThrottle, campaign._lastSample, rmCfg);
          if (!prevThrottle.active && nextThrottle.active) {
            log(`⚠ Throttle ENGAGED: ${nextThrottle.reason} — delays now ${nextThrottle.multiplier}x`);
          } else if (prevThrottle.active && !nextThrottle.active) {
            log(`✓ Throttle RELEASED — delays back to 1x`);
          }
          campaign._throttle = nextThrottle;
        } catch (err) {
          // Sampling failure must never break a campaign.
          log(`[resource-monitor] sample failed: ${err.message}`);
        }

        // Find the next unprocessed lead.
        // 2.8.28-P2 / 2.8.31: For modes that auto-route by sender (check_status,
        // message_only), use the per-profile target slice built at auto-
        // derivation time. Each profile only sees rows it originally sent.
        let row = null;
        if ((mode === 'check_status' || mode === 'message_only' || mode === 'introduce_back') && _checkStatusTargetsByProfile) {
          const slice = _checkStatusTargetsByProfile[profileId] || [];
          let cursor = _checkStatusCursorByProfile[profileId] || 0;
          while (cursor < slice.length) {
            const candidate = slice[cursor];
            const candidateUrl = extractLinkedInUrl(candidate, linkedinColumn);
            cursor++;
            if (!candidateUrl) continue;
            row = candidate;
            break;
          }
          _checkStatusCursorByProfile[profileId] = cursor;
        } else {
          while (leadIndex < targets.length) {
            const candidate = targets[leadIndex];
            const candidateUrl = extractLinkedInUrl(candidate, linkedinColumn);
            leadIndex++;
            if (!candidateUrl) continue;
            // Skip URLs already touched by THIS installation's local state,
            // EXCEPT for modes where re-touching is intentional (message_only
            // sends DMs after acceptance; open_profile_only is fire-and-forget;
            // introduce_back fires from already-connected rows;
            // connect_and_introduce trusts the sheet as source of truth so a
            // cleared row gets re-processed even if the local state remembers it).
            if (mode !== 'message_only' && mode !== 'introduce_back' && mode !== 'open_profile_only' && mode !== 'connect_and_introduce' && state.processed[candidateUrl]) continue;
            const sheetStatus = (candidate['Connection Status'] || candidate['connection status'] || candidate['Status'] || candidate['status'] || '').toLowerCase();
            if (mode === 'connect_only' || mode === 'connect_and_introduce') {
              if (sheetStatus) continue;
            }
            row = candidate;
            break;
          }
        }

        if (!row) {
          // 2.8.28-P2 / 2.8.31: per-profile exhaustion is normal in auto-routed
          // modes — skip this profile, end only when ALL profiles have drained.
          if ((mode === 'check_status' || mode === 'message_only' || mode === 'introduce_back') && _checkStatusTargetsByProfile) {
            _checkStatusExhausted.add(profileId);
            if (_checkStatusExhausted.size >= profileIds.length) {
              const label = (mode === 'check_status') ? 'Check Status'
                          : (mode === 'introduce_back') ? 'Introduce Back'
                          : 'Message Only';
              log(`All ${label} profiles have completed.`);
              leadsExhausted = true;
            }
            break;
          }
          log('All leads processed or filtered out.');
          leadsExhausted = true;
          break;
        }

        campaign.currentProfile = pName;

        const url = extractLinkedInUrl(row, linkedinColumn);

        // Mark as in-progress
        state.processed[url] = { profileId, profileName: pName, action: '_in_progress', date: new Date().toISOString() };
        await saveState(state);

        // In-loop skip check. Mirrors the pre-filter rules; catches rows
        // that were updated between pre-filter and now (e.g. by a concurrent
        // campaign or a mid-run re-fetch).
        const status    = (row['Connection Status'] || row['connection status'] || row['Status']  || row['status']  || '').toString().toLowerCase().trim();
        const cc        = (row['CC']      || row['cc']      || '').toString().toLowerCase().trim();
        const msgCell   = (row['Message'] || row['message'] || '').toString().toLowerCase().trim();
        const opCell    = (row['OP']      || row['op']      || '').toString().toLowerCase().trim();
        const inmailCell= (row['InMail']  || row['inmail']  || '').toString().toLowerCase().trim();
        const msgSent   = msgCell === 'sent' || opCell === 'sent';

        // v2.11.12: in-loop re-validation must mirror the pre-filter (line ~803)
        // for both schemas. Pre-filter migrated to Stage in 2.9.x, but the
        // in-loop checks here were left on the legacy CC " Y" / msgSent /
        // inmailCell fields — fine on legacy sheets, but new-schema sheets
        // don't populate those columns so every messageable row was silently
        // skipped via `delete + continue` (no log). Detect new schema
        // (Stage column present) and gate on Stage; old schema falls through
        // to the legacy logic, unchanged.
        const _stage = (row['Stage'] || row['stage'] || '').toString().trim();
        const _hasStageHere = _stage.length > 0 || ('Stage' in row) || ('stage' in row);

        if (mode === 'check_status') {
          // 2.8.29: criterion is Sender filled, not CC=Sent.
          const acct = getSenderName(row, senderColumn);
          if (!acct) { delete state.processed[url]; continue; }
          // 2.8.28-P2: routing guard removed. The per-profile target slices
          // built at auto-derivation time already guarantee each profile sees
          // only rows it originally sent. The defense-in-depth name-equality
          // check tripped on local-browser variants (e.g., row says
          // "local-browser", pName is "Local Browser") and broke an entire
          // legitimate code path. Slice-based filtering is sufficient.
        } else if (mode === 'introduce_back') {
          // v2.59: IC re-validation mirrors the pre-filter (~line 1442).
          // Read only from Intro Status — IC tabs may not have a Stage
          // column at all. If anything is now in Intro Status (e.g. a
          // concurrent operator marked the row done, or a sibling worker
          // in the same run just stamped it), skip.
          const _introStatusNow = (
            row['Intro Status'] || row['intro status'] || row['Intro status'] ||
            row['Introduction Status'] || row['introduction status'] ||
            row['Introduction status'] || row['introStatus'] || ''
          ).toString().trim();
          if (_introStatusNow !== '') { delete state.processed[url]; continue; }
        } else if (mode === 'message_only') {
          if (_hasStageHere) {
            // New schema: Stage drives messageability. Pre-filter passed
            // 'Connected · DM Now'; if it changed under us, skip.
            if (_stage !== 'Connected · DM Now') { delete state.processed[url]; continue; }
          } else {
            // Legacy schema: re-validate connected status + msg-not-sent.
            // Accepts either Sam's new "Connected Status" column ("Connected")
            // or the legacy "CC" column (" Y" suffix).
            const ccRaw = (row['Connected Status'] || row['connected status'] || row['CC'] || row['cc'] || '').toString().trim();
            const isConnected = ccRaw === 'Connected' || /\sY\s*$/.test(ccRaw);
            if (!isConnected) { delete state.processed[url]; continue; }
            if (msgSent) { delete state.processed[url]; continue; }
          }
        } else if (mode === 'open_profile_only' || mode === 'inmail_only') {
          if (_hasStageHere) {
            // New schema: pre-filter required Stage in {'', 'Send Connect'}.
            // If a concurrent run flipped it to anything else, skip.
            if (_stage !== '' && _stage !== 'Send Connect') {
              delete state.processed[url]; continue;
            }
          } else {
            if (status === 'done') { delete state.processed[url]; continue; }
            if (mode === 'open_profile_only' && msgSent) {
              delete state.processed[url]; continue;
            }
            if (mode === 'inmail_only' && inmailCell === 'sent') {
              delete state.processed[url]; continue;
            }
          }
        } else {
          if (status === 'done') { delete state.processed[url]; continue; }
        }

        // Build template data
        const data = { ...row };
        data.firstName = row['First Name'] || row['firstName'] || row['first_name'] || '';
        data.lastName = row['Last Name'] || row['lastName'] || row['last_name'] || '';
        data.company = row['Company'] || row['company'] || '';
        data.title = row['Title'] || row['title'] || row['Job Title'] || '';
        data.senderName = pName || '';
        const resolvedFirst = senderFirstNames[profileId];
        data.senderFirstName = (resolvedFirst && resolvedFirst.trim())
          || (pName || '').split(/\s+/)[0]
          || '';

        let hint = getModeHint(mode, state.processed[url]?.action);

        const isOpenProfile = (row['Open Profile'] || row['openProfile'] || row['open_profile'] || '').toLowerCase().trim();
        if (messageOpenProfiles && hint === 'force_connect') {
          // "Message Open Profiles Directly" — try OP first (free message),
          // fall back to sending a connection request if not an Open Profile.
          // Runtime detection via the Message panel, not a sheet column.
          hint = 'force_connect_op_fallback';
          log(`  ↳ OP-first + Connect-fallback flow`);
        }

        try {
          // Re-acquire page and close stale tabs to prevent RAM buildup
          try {
            const pages = await browser.pages();
            if (pages.length > 1) {
              page = pages[pages.length - 1];
              for (let i = 0; i < pages.length - 1; i++) {
                try { await pages[i].close(); } catch { /* */ }
              }
            } else if (pages.length === 1) {
              page = pages[0];
            }
            session.page = page;
            // v2.14.x: re-apply CDP focus emulation. Same reason as
            // ensureProfileLoggedIn — see comment there. Idempotent, so
            // safe even if pages[N-1] is the same page object as before.
            await applyFocusEmulation(page, profileId);
          } catch { /* keep current */ }

          // v2.52.0 (Layer B) — page health probe before processing each lead.
          // Symptom this addresses: Input.dispatchKeyEvent timed out during
          // organic browsing leaves the renderer's main thread wedged.
          // browseFeedOrganically swallows that error and the loop continues,
          // but the page is now CDP-unresponsive. The existing retry path
          // re-acquires the same dead page reference, burning 3 × 180s per
          // lead before giving up — 9 minutes of wasted retries per stuck
          // lead, with no recovery. A 3-second evaluate() probe catches the
          // wedge cheaply: live pages return in <50ms; wedged pages hit the
          // probe timeout and we close the session so the profile rotation
          // re-opens a fresh browser on its next turn.
          let _pageHealthy = true;
          try {
            await Promise.race([
              page.evaluate(() => 1),
              new Promise((_, reject) => setTimeout(
                () => reject(new Error('page_health_probe_timeout')), 3000
              )),
            ]);
          } catch (probeErr) {
            _pageHealthy = false;
            log(`  ⚠ ${pName}: page unresponsive (${probeErr.message}) — closing session, profile re-rotates with fresh browser next turn`);
            try { await closeSession(profileId); } catch { /* best-effort */ }
          }
          if (!_pageHealthy) break;

          log(`→ [${pName}] ${url} (${data.firstName || '?'}) [${hint || 'auto'}]`);
          setAction('Processing lead', { lead: data.firstName || '?', account: pName });

          // performOutreach with retry
          let result;
          const MAX_RETRIES = 3;
          for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            // Phase 2.8.20 (W2-A1): wrap with watchdog so a Puppeteer hang
            // can't freeze the loop indefinitely. On timeout, returns a
            // skipped result with the lead_timeout_watchdog signal which
            // the existing TRANSIENT_SIGNALS allow-list (extended below)
            // routes through the normal 3-retry/backoff flow.
            try {
              result = await withWatchdog(
                performOutreach(page, url, { ...tpl, data }, { profileId }, hint),
                LEAD_TIMEOUT_MS,
                profileId,
              );
            } catch (err) {
              if (err && err.kind === 'watchdog') {
                log(`  ⏱ ${pName}: lead timed out after ${LEAD_TIMEOUT_MS / 1000}s — ${url}`);
                result = { action: 'skipped', error: 'lead_timeout_watchdog' };
              } else {
                throw err;
              }
            }

            // Phase 2.8.17 (H-03): allow-list for transient (retryable) errors.
            // Replaces the previous deny-list which let any unforeseen new error
            // string default to "transient" — burning 45s of retries on terminal
            // outcomes like "URL not in member-URN format", "session expired",
            // or "Profile not found". Anything not matched here = treated as
            // terminal (single attempt, no retry). Comments per signal:
            //   detached / Target closed / Session closed → puppeteer lost the page
            //   Protocol error                            → CDP transport blip
            //   Execution context was destroyed           → page navigated mid-action
            //   Navigation timeout / net::ERR_            → flaky network or LinkedIn slow
            //   timed out                                 → generic puppeteer wait timeout
            //   rate_limited                              → LinkedIn told us to slow down
            //                                                — backing off then retrying is
            //                                                exactly the right response
            const TRANSIENT_SIGNALS = [
              'detached',
              'Target closed',
              'Session closed',
              'Connection closed',
              'Protocol error',
              'Execution context was destroyed',
              'Navigation timeout',
              'net::ERR_',
              'timed out',
              'rate_limited',
              'lead_timeout_watchdog',
            ];
            const isTransient = result.action === 'skipped' && !!result.error &&
              TRANSIENT_SIGNALS.some(sig => result.error.includes(sig));

            if (!isTransient || attempt === MAX_RETRIES) break;
            // Phase 2.8.10: bail retries entirely if user clicked Stop —
            // no point retrying a dead browser, and the 15s/30s sleeps were
            // the dominant source of "loop won't exit" lag after Stop.
            if (campaign._abort) { log('  ■ Abort detected — skipping retry.'); break; }

            const backoff = attempt * 15000;
            log(`  ⟳ Retry ${attempt}/${MAX_RETRIES} in ${backoff / 1000}s — ${result.error}`);
            setAction(`Retrying lead (${attempt}/${MAX_RETRIES})`, { lead: data.firstName || '?', account: pName, durationMs: backoff });
            // Abort-aware sleep: 1s polling chunks so Stop interrupts within ~1s.
            const retryEnd = Date.now() + backoff;
            while (Date.now() < retryEnd && !campaign._abort) {
              await new Promise(r => setTimeout(r, 1000));
            }
            if (campaign._abort) { log('  ■ Abort during retry backoff.'); break; }

            try {
              const pages = await browser.pages();
              if (pages.length > 1) {
                page = pages[pages.length - 1];
                for (let i = 0; i < pages.length - 1; i++) {
                  try { await pages[i].close(); } catch { /* */ }
                }
              } else if (pages.length === 1) {
                page = pages[0];
              }
              session.page = page;
              // v2.14.x: re-apply CDP focus emulation on retry path.
              await applyFocusEmulation(page, profileId);
            } catch { /* */ }
          }
          // 2.9.8: surface a normalized "Skipped: <reason>" in the dashboard
          // log too, so the operator sees the same wording the Audit Log uses.
          if (result.action === 'skipped' && result.error) {
            log(`  ${normalizeSkipReason(result.error)}`);
          } else {
            log(`  ${result.action}${result.error ? ' — ' + result.error : ''}`);
          }

          // Already-Connected detection: if the connect attempt was skipped
          // but a Voyager network-info call shows the lead is 1st-degree,
          // they're already in the account's network. Override the result
          // to a synthetic 'already_connected' action so the success branch
          // runs (stamps Already Connected + captures URN/openProfile).
          // Only checked for connect-mode runs to avoid extra Voyager calls
          // on message-only / inmail / check-status flows.
          if (result.action === 'skipped' && mode === 'connect_only') {
            try {
              const meta = await captureProfileMeta(page);
              if (meta.connectionDegree === 1) {
                log(`  ↪ Already 1st-degree connection — recording as Already Connected.`);
                result = {
                  action: 'already_connected',
                  _meta: meta,
                };
              } else if (meta.urn || meta.memberId) {
                // Stash meta even on non-1st-degree skips so we don't
                // re-fetch later (currently unused but cheap to keep).
                result._meta = meta;
              }
            } catch { /* best-effort */ }
          }

          // 2.9.2: human-readable local time for the sheet ("May 4th, 13:43"),
          // not the UTC ISO timestamp logs use.
          const now = formatLocalDate(new Date());

          if (SUCCESS_ACTIONS.has(result.action)) {
            // v2.10.0: stash the invitationUrn returned by Approach A's network
            // listener so the start-of-run reconcile pass can match this row
            // against Voyager's sent-invitations list later.
            state.processed[url] = {
              profileId,
              profileName: pName,
              action: result.action,
              date: now,
              ...(result.invitationUrn ? { invitationUrn: result.invitationUrn } : {}),
            };
            bumpCampaignCount(profileId);
            totalDone++;
            campaign.processedToday++;
            campaign.totalProcessed = campaign.processedToday;
            await saveState(state);

            // 2.8.28: For check_status, do NOT overwrite Sender — preserving
            // the original sender attribution is essential. The audit log
            // append is also conditionally suppressed for check_status reads.
            // 2.9.3 / v2.11.11: always stamp Sender on non-check-status writes.
            // Without this, action paths that didn't explicitly set sender
            // (like 'already_processed') left the Sender column empty even
            // though the row WAS handled by an account.
            const sheetData = (mode === 'check_status')
              ? { dateLastAction: now }
              : { dateLastAction: now, sender: pName };
            // 2.8.50: when Introduction Messages mode is active, stamp the DM
            // column with "sent IC" instead of "sent" so introductions are
            // visually distinct from standard DMs in the sheet.
            // v2.11.17: introMode is implicit in introduce_back mode but
            // tpl.introMode also carries it (set in template normalization).
            const sentLabel = (tpl.introMode && (mode === 'message_only' || mode === 'introduce_back')) ? 'sent IC' : 'sent';
            const hyperSent = `=HYPERLINK("${url}","${sentLabel}")`;

            // v2 multi-status: pure helper builds the field-routed payload.
            // Merge into sheetData so meta/sender/date fields from outer scope
            // are preserved.
            Object.assign(sheetData, buildSheetDataForAction({
              action: result.action,
              mode,
              profileName: pName,
              hyperSent,
              introMode: !!tpl.introMode,
              messageOpenProfiles,
              creditsLeft: typeof result.creditsLeft === 'number' ? result.creditsLeft : undefined
            }));

            // Per-action side effects the pure helper can't capture.
            if (result.action === 'connection_sent') {
              profilesThatSentAtLeastOne.add(profileId);
              try {
                const meta = await captureProfileMeta(page);
                if (meta.memberId)     sheetData.linkedinUrn       = meta.memberId;
                if (meta.memberNumber) sheetData.linkedinMemberId  = meta.memberNumber;
                if (meta.isOpenProfile !== null) sheetData.openProfile     = meta.isOpenProfile ? 'Yes' : 'No';
                if (meta.connectionDegree !== null) sheetData.connectedAlready = meta.connectionDegree === 1 ? 'Yes' : 'No';
              } catch { /* best-effort */ }
            } else if (result.action === 'already_connected') {
              const meta = result._meta || {};
              if (meta.memberId)     sheetData.linkedinUrn      = meta.memberId;
              if (meta.memberNumber) sheetData.linkedinMemberId = meta.memberNumber;
              if (meta.isOpenProfile !== null && meta.isOpenProfile !== undefined) {
                sheetData.openProfile = meta.isOpenProfile ? 'Yes' : 'No';
              }
            } else if (result.action === 'inmail_sent') {
              if (typeof result.creditsLeft === 'number') {
                log(`  💳 InMail credits left: ${result.creditsLeft}`);
                if (result.creditsLeft <= 0) {
                  log(`  ⚠ ${pName} has 0 InMail credits — removing from InMail rotation.`);
                  weeklyLimited.add(profileId);
                  recordProfileEnd(profileId, pName, 'No InMail credits left');
                }
              }
            } else if (result.action === 'status_pending') {
              // Preserve legacy timestamp on the CC column for operators
              // who scroll the legacy column. Helper already set checkStatus
              // for v2 sheets. Status mirrors 'Check Done.' on both schemas.
              const _n = new Date();
              const _pad = (n) => String(n).padStart(2, '0');
              const _stamp = `${_n.getFullYear()}-${_pad(_n.getMonth() + 1)}-${_pad(_n.getDate())} ${_pad(_n.getHours())}:${_pad(_n.getMinutes())}`;
              sheetData.status = 'Check Done.';
              sheetData.cc = `Still Pending (${_stamp})`;
              sheetData.auditAction = 'Still pending';
            }
            if (result.action === 'status_declined') {
              // Defensive fallback — outreach.js no longer emits this since
              // Check Status went two-state in 2.8.39. Treat as "Connection
              // Declined" so the operator sees the explicit verdict.
              sheetData.status = 'Check Done.';
              sheetData.cc = 'Connection Declined';
              sheetData.auditAction = 'Not confirmed connected';
            }
            // status_unknown: no connected field — leave CC text alone
            await updateSheetRow(sheetUrl, url, sheetData, linkedinColumn).catch(() => {});

            log(`  ✓ [${pName}] (${getCampaignCount(profileId)}/${dailyLimit})`);
            consecutiveSkips.set(profileId, 0);
            consecutive429s.set(profileId, 0);

            // Connect + Introduce Back: piggy-back a bulk acceptance sweep
            // on this profile's turn, but only once every 6h per
            // (sheetId, profileId). The sweep is one Voyager call, so it
            // doesn't materially extend the turn or risk rate-limiting.
            // The Connected column flip in bulk-check is what later triggers
            // the intro DM follow-up (separate pass — TODO).
            if (mode === 'connect_and_introduce' && result.action === 'connection_sent') {
              try {
                const _sheetId = _extractSheetIdFromUrl(sheetUrl);
                const cooldown = await readBulkCheckCooldown();
                const _key = bulkCheckKey(_sheetId, profileId);
                const last = cooldown[_key] || 0;
                // v2.14: per-mode interval — 5 min for connect_and_introduce (was 6h).
                if (Date.now() - last >= IN_CAMPAIGN_BULK_CHECK_INTERVAL_MS) {
                  log(`  📡 [${pName}] In-batch bulk Connection Status check (5-min cooldown elapsed)…`);

                  // Dual-stamp avoidance: when primary fields are configured, the
                  // auto-intro will fire for newly-Connected rows — suppress the
                  // Connection Accepted Status stamp for those so Introduction Status
                  // is the single source of truth.
                  const willAutoIntro = !!(
                    templates && templates.primaryName && templates.primaryName.trim() &&
                    templates.primaryIntroBody && templates.primaryIntroBody.trim()
                  );

                  const r = await bulkCheckConnections(page, sheetUrl, linkedinColumn, pName, {
                    // v2.14.x: stamp Connection Accepted immediately at bulk-check detection
                    // so the operator sees acceptance in the sheet BEFORE the intro DM fires.
                    // The auto-intro pass then only stamps Introduction Status (no longer
                    // batched into a single Apps Script write).
                    suppressAcceptedStamp: false,
                  });
                  if (r.error) {
                    log(`  ⚠ [${pName}] Bulk check: ${r.error}`);
                  } else {
                    const stamped = r.stamped || 0;
                    log(`  📡 [${pName}] Bulk check: ${r.matched} marked Connected, ${stamped} marked Still Pending (of ${r.fetched} recent connections fetched)`);
                  }
                  cooldown[_key] = Date.now();
                  await writeBulkCheckCooldown(cooldown);

                  // Auto-introduction pass via shared helper — same logic
                  // the manual button + post-campaign scheduler use.
                  if (willAutoIntro && Array.isArray(r.connectedUrls) && r.connectedUrls.length > 0) {
                    await runAutoIntros({
                      page,
                      profileId,
                      profileName: pName,
                      sheetUrl,
                      linkedinColumn,
                      connectedUrls: r.connectedUrls,
                      templates,
                      senderFirstNames,
                      log,
                    });
                  }
                }
              } catch (err) {
                log(`  ⚠ [${pName}] Bulk check threw: ${err.message}`);
              }
            }
            // Record end reason when an account completes its per-run quota.
            // The candidate filter at line ~1289 will silently exclude it
            // from the next round; this gives operators a visible "why" on
            // the dashboard's Done row.
            if (!skipsDailyLimit && getCampaignCount(profileId) >= dailyLimit) {
              recordProfileEnd(profileId, pName, `Reached campaign limit (${dailyLimit})`);
            }
          } else {
            const errorMsg = result.error || result.action || '';
            // Session expired = cookies are dead until the operator logs in
            // again. No point waiting for SKIP_PARK_THRESHOLD strikes —
            // every subsequent lead will fail the same way. Park on the
            // first occurrence so the loop rotates to a healthier account.
            const isSessionExpired = /session\s*expired/i.test(errorMsg);
            if (isSessionExpired && !weeklyLimited.has(profileId)) {
              log(`  ⚠ ${pName}: session expired — parking account for rest of run (re-login required).`);
              weeklyLimited.add(profileId);
              recordProfileEnd(profileId, pName, 'Session expired — log in again');
              campaign.parkedProfiles.push({
                profileId,
                pName,
                parkedAt: Date.now(),
                reason: 'session_expired',
              });
            }
            // 429-specific tracker. Three strikes = treat as weekly cap and
            // park the profile, well before the generic SKIP_PARK_THRESHOLD
            // would catch it (which can be 5+ and burns more API quota).
            const is429 = /HTTP\s*429|VOYAGER_REJECTED.*429/i.test(errorMsg);
            if (is429) {
              const c429 = (consecutive429s.get(profileId) || 0) + 1;
              consecutive429s.set(profileId, c429);
              if (c429 >= HTTP_429_PARK_THRESHOLD && !weeklyLimited.has(profileId)) {
                log(`  ⚠ ${pName}: ${HTTP_429_PARK_THRESHOLD} consecutive HTTP 429s — assumed weekly invitation limit. Parking account.`);
                weeklyLimited.add(profileId);
                recordProfileEnd(profileId, pName, `Weekly invitation limit reached (${HTTP_429_PARK_THRESHOLD}× HTTP 429)`);
                campaign.parkedProfiles.push({
                  profileId,
                  pName,
                  parkedAt: Date.now(),
                  reason: 'weekly_limit_429',
                });
              }
            } else {
              consecutive429s.set(profileId, 0);
            }
            const skipCount = (consecutiveSkips.get(profileId) || 0) + 1;
            consecutiveSkips.set(profileId, skipCount);
            if (skipCount >= SKIP_PARK_THRESHOLD && !weeklyLimited.has(profileId)) {
              log(`  ⚠ ${pName}: ${SKIP_PARK_THRESHOLD} consecutive non-success outcomes — parking account for rest of run.`);
              weeklyLimited.add(profileId);
              recordProfileEnd(profileId, pName, `Parked after ${skipCount} consecutive skips`);
              campaign.parkedProfiles.push({
                profileId,
                pName,
                parkedAt: Date.now(),
                reason: 'consecutive_skips',
                skipCount,
              });
            }

            if (errorMsg.includes('WEEKLY_LIMIT')) {
              log(`  ⚠ WEEKLY LIMIT reached for ${pName}. Removing from rotation.`);
              weeklyLimited.add(profileId);
              recordProfileEnd(profileId, pName, 'Weekly invitation limit hit (~100/week)');
              pushSoftWarning(campaign, {
                profileId,
                pName,
                kind: 'weekly_limit',
                message: 'Weekly invitation limit reached',
              });
              await updateSheetRow(sheetUrl, url, {
                ...buildSkipSheetData(mode, normalizeSkipReason('Weekly invitation limit reached'), pName),
                dateLastAction: now,
                auditAction: normalizeSkipReason('Weekly invitation limit reached'),
              }, linkedinColumn).catch(() => {});
            } else if (errorMsg.includes('INMAIL_NO_CREDITS_NOT_OP')) {
              // v2.11.3: dual-fact signal — account is out of InMail credits
              // (eject for run) AND lead is confirmed non-OP (mark in sheet).
              // The lead-level fact takes precedence in the sheet write because
              // it's permanent across runs; the account-level fact is run-only.
              log(`  ⚠ ${pName}: 0 InMail credits + lead not Open Profile. Removing account from rotation, marking lead Not OP.`);
              weeklyLimited.add(profileId);
              recordProfileEnd(profileId, pName, 'No InMail credits left');
              state.processed[url] = { profileId, profileName: pName, action: 'not_open_profile', date: now };
              await saveState(state);
              await updateSheetRow(sheetUrl, url, {
                ...buildSkipSheetData(mode, normalizeSkipReason('Not Open Profile'), pName),
                dateLastAction: now,
                auditAction: normalizeSkipReason('Not Open Profile'),
              }, linkedinColumn).catch(() => {});
            } else if (errorMsg.includes('INMAIL_NO_CREDITS')) {
              log(`  ⚠ InMail credits exhausted for ${pName}. Removing from rotation.`);
              weeklyLimited.add(profileId);
              recordProfileEnd(profileId, pName, 'InMail credits exhausted');
              await updateSheetRow(sheetUrl, url, {
                ...buildSkipSheetData(mode, normalizeSkipReason('InMail credits exhausted'), pName),
                dateLastAction: now,
                auditAction: normalizeSkipReason('InMail credits exhausted'),
              }, linkedinColumn).catch(() => {});
            } else if (errorMsg.includes('EMAIL_REQUIRED')) {
              // Per-lead skip — LinkedIn asked for the recipient's email.
              // Not an account-level issue, so no soft-warning chip; the log
              // line + sheet stamp below carry all the info the operator needs.
              log(`  ⚠ Email required for ${data.firstName || '?'}. Skipping lead, moving on.`);
              state.processed[url] = { profileId, profileName: pName, action: 'email_required', date: now };
              await saveState(state);
              await updateSheetRow(sheetUrl, url, {
                ...buildSkipSheetData(mode, normalizeSkipReason('Email required to connect'), pName),
                cc: 'Unreachable',
                dateLastAction: now,
                auditAction: normalizeSkipReason('Email required to connect'),
              }, linkedinColumn).catch(() => {});
            } else if (errorMsg.includes('Not yet connected')) {
              log('  ↷ Not yet connected — will retry after acceptance.');
              await updateSheetRow(sheetUrl, url, {
                status: normalizeSkipReason('Not yet connected'),
                sender: pName,
                dateLastAction: now,
                auditAction: normalizeSkipReason('Not yet connected'),
              }, linkedinColumn).catch(() => {});
            } else if (errorMsg.includes('SEND_NOT_CONFIRMED')) {
              log(`  ⚠ Send clicked but Pending NOT confirmed for ${data.firstName || '?'}. LinkedIn may have silently dropped it.`);
              delete state.processed[url];
              await saveState(state);
              await updateSheetRow(sheetUrl, url, {
                ...buildSkipSheetData(mode, normalizeSkipReason('Send not confirmed'), pName),
                dateLastAction: now,
                auditAction: normalizeSkipReason('Send not confirmed'),
              }, linkedinColumn).catch(() => {});
            } else if (errorMsg.includes('LINKEDIN_ERROR_TOAST')) {
              log(`  ⚠ LinkedIn showed an error toast for ${data.firstName || '?'}.`);
              delete state.processed[url];
              await saveState(state);
              await updateSheetRow(sheetUrl, url, {
                ...buildSkipSheetData(mode, normalizeSkipReason('LinkedIn error toast'), pName),
                dateLastAction: now,
                auditAction: normalizeSkipReason('LinkedIn error toast'),
              }, linkedinColumn).catch(() => {});
            } else if (errorMsg.includes('NOT_OPEN_PROFILE')) {
              log('  ✗ Not an Open Profile — will skip in future runs.');
              state.processed[url] = { profileId, profileName: pName, action: 'not_open_profile', date: now };
              await saveState(state);
              await updateSheetRow(sheetUrl, url, {
                ...buildSkipSheetData(mode, normalizeSkipReason('Not Open Profile'), pName),
                dateLastAction: now,
                auditAction: normalizeSkipReason('Not Open Profile'),
              }, linkedinColumn).catch(() => {});
            } else if (errorMsg.includes('rate_limited')) {
              pushSoftWarning(campaign, {
                profileId,
                pName,
                kind: 'rate_limited',
                message: 'LinkedIn rate-limit page shown',
              });
              log('  ✗ Retry next run.');
              pushError(new Error(`${url}: ${errorMsg}`));
              delete state.processed[url];
              await saveState(state);
              await updateSheetRow(sheetUrl, url, {
                ...buildSkipSheetData(mode, normalizeSkipReason(errorMsg), pName),
                dateLastAction: now,
                auditAction: normalizeSkipReason(errorMsg),
              }, linkedinColumn).catch(() => {});
            } else {
              log('  ✗ Retry next run.');
              pushError(new Error(`${url}: ${errorMsg}`));
              delete state.processed[url];
              await saveState(state);
              await updateSheetRow(sheetUrl, url, {
                ...buildSkipSheetData(mode, normalizeSkipReason(errorMsg), pName),
                dateLastAction: now,
                auditAction: normalizeSkipReason(errorMsg),
              }, linkedinColumn).catch(() => {});
            }
          }

          totalVisited++;

          // ── Phase 11.1: park the idle profile on a low-RAM page during the delay window (D-10, D-11) ──
          // Always parks, regardless of throttle state. IDLE_PARKING_ENABLED env kill switch wins.
          // Swallows errors (parkProfile itself catches + logs).
          if (rmCfg.IDLE_PARKING_ENABLED) {
            await parkProfile(page, rmCfg.PARK_PAGE);
          }

          // Within-batch delay between leads (interruptible by abort).
          // Phase 11.2 (D-04): session-break branch removed — between-batch
          // gap is handled after the inner BATCH_SIZE loop, derived from
          // batchesPerHour.
          if (!campaign._abort) {
            // Messaging existing 1st-degree connections is much lower risk than
            // sending new connection requests, so use a faster cadence and skip
            // the single-account slowdown.
            // 2.9.8: extended unlimited-pacing set. Was only message_only;
            // now also inmail_only + open_profile_only per user request
            // (no daily/hourly caps for non-Connect sends).
            const isMessageMode = mode === 'message_only';
            const isFastMode = isMessageMode || mode === 'inmail_only' || mode === 'open_profile_only';
            const delayMultiplier = computeDelayMultiplier({
              mode,
              profileCount: profileIds.length,
              throttleActive:     campaign._throttle?.active     ?? false,
              throttleMultiplier: campaign._throttle?.multiplier ?? 1,
            });

            let waitMs;
            if (mode === 'check_status' || isFastMode) {
              // 2.8.29 / 2.9.8: read-only modes (check_status) and low-risk
              // send modes (message_only, inmail_only, open_profile_only)
              // use a tiny 1-3s breath instead of the 15-45s connect cadence.
              waitMs = (1 + Math.floor(Math.random() * 2)) * 1000;
              const label = (mode === 'check_status')
                ? 'check-only — no rate limits apply'
                : `${mode.replace('_only', '')} — no rate limits apply`;
              log(`  ⏳ ${(waitMs / 1000).toFixed(0)}s (${label})`);
            } else {
              waitMs = Math.floor(Math.random() * (delayMax - delayMin + 1) + delayMin) * 1000;
              waitMs = Math.floor(waitMs * delayMultiplier);
              if (delayMultiplier > 1) {
                const parts = [];
                if (!isFastMode && profileIds.length === 1) parts.push('single-account 2x');
                if (campaign._throttle?.active) parts.push(`throttled ${campaign._throttle.multiplier}x`);
                log(`  ⏳ ${(waitMs / 1000).toFixed(0)}s (${parts.join(' + ')})`);
              } else {
                log(`  ⏳ ${(waitMs / 1000).toFixed(0)}s`);
              }
            }

            // ~30% chance: browse the feed organically during the wait (looks like a real user).
            // Skip entirely in message mode AND check_status mode — both should move fast.
            if (!isFastMode && mode !== 'check_status' && Math.random() < 0.3 && !campaign._abort) {
              setAction('Organic browsing', { account: pName });
              await browseFeedOrganically(page, pName);
            }
            // Sleep in 2s chunks so abort is checked frequently
            setAction('Waiting before next lead', { account: pName, durationMs: waitMs });
            const sleepEnd = Date.now() + waitMs;
            while (Date.now() < sleepEnd && !campaign._abort) {
              await new Promise(r => setTimeout(r, 2000));
            }
            if (campaign._abort) log('  ■ Abort detected during delay.');
          }
        } catch (err) {
          log(`  ✗ ${err.message}`);
          pushError(err);
        }
        }  // end inner BATCH_SIZE for-loop

        // ── End-of-turn close ──
        // 2.9.9: in the worker-pool model, profiles always close at end of
        // turn. Their next turn is at the back of the queue, so the wait is
        // longer than any "park and reuse" gap. Fast modes (check_status,
        // message_only) skip cooldown so they re-enter immediately.
        if (campaign._abort || leadsExhausted) {
          if (sessions.has(profileId)) await closeSession(profileId);
          return;
        }

        const stayOpen = (mode === 'check_status' || mode === 'message_only')
          && profileQueue.length === 0
          && profilesBeingRun.size <= 1;

        if (stayOpen) {
          if (rmCfg.IDLE_PARKING_ENABLED && !page.isClosed?.()) {
            await parkProfile(page, rmCfg.PARK_PAGE);
          }
          log(`  ⏸ ${pName}: parked (sole runner this round).`);
        } else {
          log(`  ⊗ ${pName}: turn complete — closing browser.`);
          await closeSession(profileId);
        }
    }  // end runProfileTurn

    // ── Worker dispatcher: spawn N concurrent workers ──
    async function worker(workerId) {
      // v2.14 idle-check cooldown cache — refresh every 2s to avoid disk thrash
      let _idleCooldownCache = null;
      let _idleCooldownCacheAt = 0;

      while (!campaign._abort && !leadsExhausted && !isOrphan()) {
        // Adaptive RAM throttle: drop browser cap to 1 when throttle engages,
        // restore on release (Q1=(a) "drain to 1").
        const t = campaign._throttle;
        if (t?.active) browserSemaphore.setMax(1);
        else browserSemaphore.setMax(MAX_CONCURRENT_PROFILES);

        // v2.14: connect_and_introduce idle bulk-check pass. Each pool iteration,
        // for every profileId that's parked between batches, check if its 5-min
        // cooldown has elapsed and a semaphore slot is free — if so, briefly
        // reopen the profile to fire a bulk-check + auto-intros, then close.
        // All seven gates live in shouldFireIdleBulkCheck (pure, unit-tested).
        if (mode === 'connect_and_introduce') {
          const _idleSheetId = _extractSheetIdFromUrl(sheetUrl);
          // Refresh cooldown cache if stale (2s TTL)
          if (!_idleCooldownCache || Date.now() - _idleCooldownCacheAt > 2000) {
            _idleCooldownCache = await readBulkCheckCooldown();
            _idleCooldownCacheAt = Date.now();
          }
          const _idleCooldown = _idleCooldownCache;
          const _semStatus = browserSemaphore.getStatus();
          const _semAvailable = _semStatus.max - _semStatus.count - _semStatus.waiting;
          for (const _profileId of profileIds) {
            const _pName = profileNameCache[_profileId] || (_profileId === 'local-browser' ? 'You' : _profileId);
            const _lastBulkCheckAt = _idleCooldown[bulkCheckKey(_idleSheetId, _profileId)] || 0;
            const _fire = shouldFireIdleBulkCheck({
              mode,
              campaignStartTime,
              profileBrowserOpen: sessions.has(_profileId),
              profileWeeklyLimited: weeklyLimited.has(_profileId),
              semaphoreAvailable: _semAvailable,
              lastBulkCheckAt: _lastBulkCheckAt,
              now: Date.now(),
            });
            if (!_fire) continue;
            // Fire and await — keeps pool iteration order predictable.
            // The helper acquires its own semaphore slot internally.
            await runIdleBulkCheck(_profileId, _pName);
          }
        }

        const profileId = pickNextProfile();
        if (!profileId) {
          if (noProfilesLeftEver()) break;
          // Eligible profiles exist but they're all in cooldown or mid-turn.
          // Idle briefly and retry.
          await new Promise(r => setTimeout(r, 5000));
          continue;
        }

        try {
          await runProfileTurn(profileId);
        } catch (err) {
          log(`✗ Worker ${workerId} crashed running ${profileId}: ${err.message}`);
          pushError(err);
        } finally {
          profilesBeingRun.delete(profileId);
          // Cooldown timestamp is set even on error, so a flapping profile
          // doesn't get re-picked instantly by another worker.
          profileCooldownUntil.set(profileId, Date.now() + cooldownMs);
          // Re-enqueue at the back unless the profile got ejected mid-turn.
          if (!weeklyLimited.has(profileId) && !campaign._abort && !leadsExhausted) {
            profileQueue.push(profileId);
          }
        }
      }
    }

    const workerCount = Math.max(1, Number(concurrency) || 1);
    await Promise.all(
      Array.from({ length: workerCount }, (_, i) => worker(i))
    );

    // Log per-profile stats (from the sessions Map — covers both still-open
    // and already-closed profiles via campaignCounts).
    for (const profileId of profileIds) {
      // 2.9.2: never let the raw profileId 'local-browser' leak to the sheet
      // (it bypasses profileNameCache when that's stale). Force 'You'.
      const pName = profileNameCache[profileId] || (profileId === 'local-browser' ? 'You' : profileId);
      log(`■ ${pName}: ${getCampaignCount(profileId)} processed.`);
    }

    // STEP 3: Close all remaining browsers (with 2-minute timeout).
    // Profiles that were closed between batches are already out of `sessions`.
    log('Closing all browsers...');
    const closeTimeout = setTimeout(() => {
      log('⚠ Browser close timed out after 2 minutes. Force-ending campaign.');
    }, 120000);

    for (const profileId of [...sessions.keys()]) {
      await closeSession(profileId);
    }

    clearTimeout(closeTimeout);

    // Transition to monitoring for CC+IC runs that sent ≥1 connect. The
    // end-of-list bulk-check that used to live here was removed: the
    // immediate close-then-reopen pattern on the same profile is a clear
    // bot signature, and in-campaign idle bulk-checks already catch
    // mid-run acceptances while the 6h post-campaign scheduler catches
    // the rest.
    if (!campaign._skipCleanup && mode === 'connect_and_introduce' && profilesThatSentAtLeastOne.size > 0) {
      const updated = transitionToMonitoring(campaign, {
        now: new Date(),
        participatingProfileIds: Array.from(profilesThatSentAtLeastOne),
      });
      Object.assign(campaign, updated);
      _ops('INFO', 'Monitoring started', {
        details: `${profilesThatSentAtLeastOne.size} account(s) · cadence: ${campaign.checkIntervalMinutes || 60}min · ends: ${campaign.monitoringUntil || ''}`,
      });

      try {
        const _sheetId = _extractSheetIdFromUrl(sheetUrl);
        const _appender = buildAppendLogger({ logs: campaign.logs, capLines: 5000 });
        for (const _pid of profilesThatSentAtLeastOne) {
          registerAppender(_sheetId, _pid, _appender);
        }
      } catch (busErr) {
        console.warn('[monitoring] Log bus registration failed:', busErr.message);
      }

      try {
        await writeMonitoringState(campaign);
      } catch (persistErr) {
        console.warn('[monitoring] persistence write failed:', persistErr.message);
      }
      // v2.14.x: arm the 15s pre-fire heads-up for the first auto-check.
      _preFireNotifiedFor = null;
      schedulePreFireHeadsUp();
    }
  } catch (err) {
    log(`Fatal: ${err.message}`);
    pushError(err);
    endReason = 'errored';
  } finally {
    // v2.11.7: if neither catch nor a fatal error fired, but operator hit
    // Stop, mark accordingly. campaign._abort is set by stopCampaign().
    if (endReason !== 'errored' && campaign._abort) endReason = 'stopped';

    // Save campaign history (D-10)
    try {
      await appendHistory({
        date: new Date().toISOString(),
        name: campaign.name || '',
        mode: campaign.mode,
        profiles: campaign.profileNames,
        dailyLimit: dailyLimit,
        totalProcessed: campaign.totalProcessed,
        successCount: campaign.processedToday,
        errorCount: campaign.errors.length,
        duration: Math.round((Date.now() - campaignStartTime) / 1000),
        templateNames: Object.entries(tpl).filter(([_, v]) => v && (typeof v === 'string' ? v : v.subject)).map(([k]) => k),
        // v2.11.7: badge state in the dashboard's Past list.
        endReason,
        // v2.14.x: true when operator chose "Stop everything" in the CC+IC
        // stop-choice modal. The past-list hides the Resume button on these
        // entries — "Stop everything" semantically means the operator is
        // done with this campaign, not pausing it.
        fullStop: !!campaign._skipCleanup,
        // v2.11.7: settings snapshot for the "Re-run with same settings" CTA.
        // Operator already trusts this machine with the templates (they're
        // typed into the wizard), and the file is in the user-only data
        // dir. Future privacy hardening can hash/encrypt these later.
        settings: {
          profileIds: Array.isArray(profileIds) ? [...profileIds] : [],
          sheetUrl: sheetUrl || '',
          templates: {
            connectionNote: tpl.connectionNote || '',
            followUpMessage: tpl.followUpMessage || '',
            inmailSubject: tpl.inmail?.subject || '',
            inmailBody: tpl.inmail?.message || '',
            openProfileSubject: tpl.openProfileSubject || '',
            openProfileBody: tpl.openProfileBody || '',
            introMode: !!tpl.introMode,
            introName: tpl.introName || '',
            introTitle: tpl.introTitle || '',
            // CC+IC primary-person fields. Persisted here so Re-run can
            // restore them on the wizard — without these the "Intro DM
            // body" + "Primary person — Full name" inputs come back blank.
            primaryName:      (templates && templates.primaryName)      || '',
            primaryIntroBody: (templates && templates.primaryIntroBody) || '',
            primaryUrl:       (templates && templates.primaryUrl)       || '',
          },
          dailyLimit,
          messageOpenProfiles: !!messageOpenProfiles,
          delayMin,
          delayMax,
          linkedinColumn: linkedinColumn || '',
          concurrency: concurrency || 1,
          // v2.52.0: persist the operator-chosen monitoring cadence so resume
          // flows can carry it forward. Pre-2.52 history entries don't have
          // this field — resume falls back to the server's 60-min default.
          checkIntervalMinutes: campaign.checkIntervalMinutes || undefined,
        },
      });
    } catch (histErr) {
      console.error('Failed to save campaign history:', histErr.message);
    }

    // Central Operations Log + Campaign Activity Log mirrors. Both are
    // fire-and-forget — failures never block the campaign-end cleanup.
    const _durationSec = Math.round((Date.now() - campaignStartTime) / 1000);
    _ops('INFO', `Campaign ended (${endReason})`, {
      details: `${campaign.totalProcessed} processed · ${campaign.errors.length} errors · ${_durationSec}s`,
    });
    try {
      // Mode-aware template preview. Only dump fields the running mode
      // actually uses — wizard form state may carry leftover values
      // (e.g. OP body from a previous preset) that the campaign never
      // sent, and logging those would mislead anyone reading the
      // Campaign Activity sheet.
      const _templateBlocks = [];
      const _wantsConnect  = (mode === 'connect_only' || mode === 'connect_and_introduce');
      const _wantsMessage  = (mode === 'message_only' || mode === 'introduce_back');
      const _wantsInmail   = (mode === 'inmail_only');
      const _wantsOp       = (mode === 'open_profile_only')
                          || (mode === 'connect_only' && !!messageOpenProfiles);
      const _wantsAutoIntro = (mode === 'connect_and_introduce');
      if (_wantsConnect && tpl.connectionNote)
        _templateBlocks.push(`Connection note: "${tpl.connectionNote}"`);
      if (_wantsMessage && tpl.followUpMessage)
        _templateBlocks.push(`Follow-up: "${tpl.followUpMessage}"`);
      if (_wantsInmail && tpl.inmail?.subject)
        _templateBlocks.push(`InMail subject: "${tpl.inmail.subject}"`);
      if (_wantsInmail && tpl.inmail?.message)
        _templateBlocks.push(`InMail body: "${tpl.inmail.message}"`);
      if (_wantsOp && tpl.openProfileSubject)
        _templateBlocks.push(`OP subject: "${tpl.openProfileSubject}"`);
      if (_wantsOp && tpl.openProfileBody)
        _templateBlocks.push(`OP body: "${tpl.openProfileBody}"`);
      // IC mode (introduce_back) → group-DM intro
      if (_wantsMessage && tpl.introMode && tpl.introName)
        _templateBlocks.push(`Intro recipient (IC): ${tpl.introName}`);
      // CC+IC → post-acceptance auto-intro to a primary person
      if (_wantsAutoIntro) {
        const _pName = (templates && templates.primaryName ? templates.primaryName : '').trim();
        const _pBody = (templates && templates.primaryIntroBody ? templates.primaryIntroBody : '').trim();
        if (_pName) _templateBlocks.push(`Primary person: ${_pName}`);
        if (_pBody) _templateBlocks.push(`Intro DM body: "${_pBody}"`);
      }
      campaignLogAppendRun({
        ts: new Date().toISOString(),
        operator: campaign.createdBy || '',
        name: campaign.name || '',
        mode: campaign.mode || '',
        profiles: campaign.profileNames || [],
        totalLeads: campaign.totalTargets || 0,
        processed: campaign.totalProcessed || 0,
        errors: campaign.errors.length || 0,
        durationSec: _durationSec,
        endReason,
        templatePreview: _templateBlocks.join('\n\n'),
        sheetUrl: sheetUrl || '',
      }).catch(() => {}); // fire-and-forget — network errors are non-fatal
    } catch (logErr) {
      console.warn('[log-writer] campaign-end mirror threw:', logErr.message);
    }

    // Register a post-campaign acceptance-tracking window for every profile
    // that actually sent at least one connect. Skipped when
    // acceptanceTrackingDays is 0 or for non-connect modes where the
    // bulk-check doesn't make sense.
    // v2.14.x: also skipped when operator chose "Stop everything" in the
    // CC+IC stop-choice modal (_skipCleanup) — the operator has explicitly
    // opted out of post-campaign monitoring.
    try {
      const trackingApplies = (mode === 'connect_only' || mode === 'connect_and_introduce');
      if (!campaign._skipCleanup && trackingApplies && acceptanceTrackingDays > 0) {
        const _sheetId = _extractSheetIdFromUrl(sheetUrl);
        // v2.14 verified: per-profile registration ensures every participating
        // account's post-campaign 6h × 7d sweep fires independently, including
        // auto-intros for connect_and_introduce campaigns.
        for (let i = 0; i < (campaign.profileIds || []).length; i++) {
          const pid = campaign.profileIds[i];
          const pName = (campaign.profileNames || [])[i] || pid;
          await registerPostCampaignSweep({
            sheetId: _sheetId,
            sheetUrl,
            profileId: pid,
            profileName: pName,
            linkedinColumn,
            days: acceptanceTrackingDays,
            operatorEmail: campaign.createdBy,
            // Persist Connect + Introduce Back primary fields so each
            // post-campaign sweep can fire the auto-intro DM.
            mode,
            primaryName: (templates && templates.primaryName) || '',
            primaryIntroBody: (templates && templates.primaryIntroBody) || '',
            primaryUrl: (templates && templates.primaryUrl) || '',
            introTitle: (templates && templates.introTitle) || '',
          });
        }
      }
    } catch (regErr) {
      console.error('Failed to register post-campaign tracking:', regErr.message);
    }

    campaign.running = false;
    campaign.currentProfile = null;
    campaign._unparkProfile = null;
    // v2.14.x: reset abort flag at campaign-end. Without this, _abort stays
    // true after any operator-initiated Stop and bleeds into subsequent
    // manual /api/bulk-check-now, post-campaign sweeps, and monitoring
    // ticks — auto-intro.js's `if (campaign._abort)` guard then fires
    // immediately and stamps every newly-Connected lead as
    // 'Skipped — Stop pressed' (repro 2026-05-17T20:19:11: manual bulk
    // check called runAutoIntros, log shows 'Auto-introducing 3' then
    // 'Stop detected — marking remaining 3' in the SAME millisecond).
    campaign._abort = false;
    log('=== Campaign ended ===');
    campaign.currentAction = null; // clear cockpit
  }
}

// Rename the in-flight campaign. Called from POST /api/campaign/name. Empty
// strings are allowed — operator can clear a name.
export function setCampaignName(name) {
  campaign.name = (typeof name === 'string' ? name : '').trim();
  return campaign.name;
}

// Operator-initiated retry of a parked profile. Removes it from the in-run
// "do not pick" sets so the next campaign rotation tries it again. Returns
// the profile name (or null if not found / not currently running).
//
// Caller (server.js endpoint) is responsible for actually opening the
// GoLogin browser so the operator can re-authenticate before the next
// rotation hits.
export function retryParkedProfile(profileId) {
  if (!campaign.running) return { ok: false, reason: 'no-campaign-running' };
  // Find profile name from the parked entry (preferred) or current name list.
  const parkedEntry = campaign.parkedProfiles.find((p) => p.profileId === profileId);
  const pName = parkedEntry?.pName || (campaign.profileNames || []).find(
    (n) => n === profileId
  ) || profileId;
  // Remove all gating that would skip this profile next rotation.
  campaign.parkedProfiles = campaign.parkedProfiles.filter((p) => p.profileId !== profileId);
  campaign.profileEndReasons = campaign.profileEndReasons.filter((p) => p.profileId !== profileId);
  // The internal weeklyLimited / consecutive429s / consecutiveSkips are
  // local to the running campaign closure (see startCampaign body) — exposed
  // here via a side-channel so retry can reset them mid-run.
  if (typeof campaign._unparkProfile === 'function') {
    campaign._unparkProfile(profileId);
  }
  log(`▶ Retry requested for ${pName} — will attempt again on next rotation.`);
  return { ok: true, profileName: pName };
}

export function stopCampaign({ full = false } = {}) {
  campaign._abort = true;
  // Distinguish operator-initiated stop from natural completion so the
  // dashboard can surface a "Stopped" badge + Restart button on the history
  // entry that gets written when the loop unwinds.
  campaign._stoppedManually = true;
  // v2.14.x: when `full` is true (operator picked "Stop everything" in the
  // CC+IC stop-choice modal), the finally block skips the end-of-list
  // bulk-check, the running→monitoring transition, and the per-account
  // post-campaign sweep registration. Default false preserves the existing
  // "Stop sending, keep monitoring" semantics.
  campaign._skipCleanup = !!full;
  // Wake any in-flight awaitUnpause() so the loop can exit cleanly.
  campaign._paused = false;
  campaign._pauseRequested = false;
  log(full
    ? '■ Stop requested (full halt — no monitoring, no auto-intros).'
    : '■ Stop requested.');
  // P-02 fix (2.8.18): return a real shape instead of undefined so
  // /api/campaign/stop sends `{ok:true}` like every other endpoint.
  return { ok: true, full: !!full };
}

// Phase 2.8.9: pause/resume.
// Pause sets a request flag — the loop checks at lead boundaries (top of the
// inner BATCH_SIZE loop) and only then flips _paused = true. Browsers stay
// open during pause; resume clears both flags and the awaitUnpause loop exits.
export function pauseCampaign() {
  if (!campaign.running) return { ok: false, reason: 'not-running' };
  if (campaign._paused || campaign._pauseRequested) {
    return { ok: true, alreadyPausing: true };
  }
  campaign._pauseRequested = true;
  log('⏸ Pause requested — will pause after current lead completes.');
  return { ok: true };
}

export function resumeCampaign() {
  if (!campaign.running) return { ok: false, reason: 'not-running' };
  if (!campaign._paused && !campaign._pauseRequested) {
    return { ok: true, notPaused: true };
  }
  campaign._pauseRequested = false;
  campaign._paused = false; // awaitUnpause's while-loop will exit on next tick
  log('▶ Resume requested.');
  return { ok: true };
}

// v2.14.x: Restore — "panic button" for when the campaign is stuck and
// neither Stop nor Pause are responding. Force-kills browsers, lies to the
// rest of the system about `running` being false (even if the in-flight
// loop is hung mid-await), then re-launches the same campaign with the
// snapshotted settings. Today's per-account counts are seeded from
// state.processed by startCampaign so accounts pick up where they left
// off, not from 0/dailyLimit.
//
// The old (potentially hung) loop is left in memory — its awaits will
// resolve to errors as browsers die under it. State writes from that loop
// are tolerated because saveState() atomically overwrites; the worst-case
// race is one slightly-stale write, which the next live save corrects.
//
// Returns { ok, restartedFrom, reason? }:
//   restartedFrom: 'running' | 'history' | null (idle no-op)
export async function restoreCampaign() {
  const wasRunning = campaign.running;
  let settings = _lastRunSettings;

  // Force-kill browser processes synchronously. closeAllProfiles handles
  // the SIGTERM + SIGKILL fallback path inside gologin-launcher.
  try { await closeAllProfiles(); } catch (err) { console.warn('[restore] closeAllProfiles:', err.message); }
  try { await closeLocalBrowser(); } catch (err) { console.warn('[restore] closeLocalBrowser:', err.message); }

  // Lie to the rest of the system: the old loop's `running = false` may
  // never fire if it's hung. Set it ourselves so UI + status endpoints
  // immediately reflect idle. Mark _skipCleanup so any awakening from the
  // hung loop short-circuits without touching state.
  campaign._abort = true;
  campaign._skipCleanup = true;
  campaign.running = false;
  campaign.currentProfile = null;
  campaign.currentAction = null;
  log('↻ Restore: campaign engine force-reset.');

  // If we weren't running but have history with settings, restore from
  // there (covers the "app restarted after crash" case).
  if (!settings) {
    try {
      const raw = await readFile(HISTORY_PATH, 'utf8');
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length > 0) {
        const last = arr[arr.length - 1];
        if (last && last.settings) {
          const s = last.settings;
          settings = {
            profileIds: Array.isArray(s.profileIds) ? s.profileIds : [],
            sheetUrl: s.sheetUrl || '',
            templates: s.templates || {},
            dailyLimit: s.dailyLimit ?? 50,
            mode: last.mode,
            messageOpenProfiles: !!s.messageOpenProfiles,
            delayMin: s.delayMin ?? 15,
            delayMax: s.delayMax ?? 45,
            linkedinColumn: s.linkedinColumn || '',
            concurrency: s.concurrency ?? 1,
            name: last.name ? `${last.name} (restored)` : '',
          };
        }
      }
    } catch { /* no history → nothing to restore from */ }
  }

  if (!settings) {
    log('↻ Restore: no settings to restart with — engine is idle now.');
    return { ok: true, restartedFrom: null, reason: 'nothing-to-restore' };
  }

  // Brief wait so the old loop's pending I/O has a chance to fail out
  // before the new loop starts touching the same files.
  await new Promise((r) => setTimeout(r, 1500));

  // Re-launch. Fire-and-forget — startCampaign awaits the full lifecycle
  // and we don't want to block the HTTP response on that.
  const restartedFrom = wasRunning ? 'running' : 'history';
  const launchName = wasRunning
    ? `${settings.name || ''} (restored)`.trim()
    : settings.name;
  startCampaign({ ...settings, name: launchName }).catch((err) => {
    log(`↻ Restore: restart failed — ${err.message}`);
  });

  return { ok: true, restartedFrom };
}

async function awaitUnpause(myGen) {
  if (!campaign._pauseRequested && !campaign._paused) return;
  campaign._paused = true;
  setAction('Paused — awaiting resume');
  log('⏸ Campaign paused — browsers stay open. Press Resume to continue.');
  // v2.52.0: also exit when the generation no longer matches (orphan loop
  // left over from a restoreCampaign re-launch). Without this an orphan
  // sitting in awaitUnpause would block forever on a 1s poll that only
  // checked _abort — which startCampaign reset to false.
  while (campaign._paused && !campaign._abort && (myGen === undefined || campaign._generation === myGen)) {
    await new Promise(r => setTimeout(r, 1000));
  }
  if (!campaign._abort && (myGen === undefined || campaign._generation === myGen)) {
    log('▶ Campaign resumed.');
  }
  campaign._paused = false;
  campaign._pauseRequested = false;
}

export function getCampaignStatus() {
  // Prefer campaign-loop samples (include browser PIDs) but fall back to the
  // ambient sampler so tiles populate the moment the server starts.
  const amb = getAmbient();
  const smp = campaign._lastSample || amb.sample;
  const thr = campaign._throttle   || amb.throttle;
  return {
    running: campaign.running,
    paused: campaign._paused,
    pauseRequested: campaign._pauseRequested,
    // v2.13.14: surface monitoring fields so the cockpit + run-bar can
    // reflect post-campaign monitoring state without a second poll.
    state: campaign.state || 'idle',
    monitoringUntil: campaign.monitoringUntil || null,
    nextCheckAt: campaign.nextCheckAt || null,
    // v2.52.0: surface the operator-chosen cadence so the cockpit tips +
    // the dashboard Monitoring tab show the ACTUAL running value, not the
    // wizard dropdown's default. Was missing entirely → tips fell back to
    // the wizard's HTML default (60 min) regardless of campaign reality.
    checkIntervalMinutes: campaign.checkIntervalMinutes || null,
    // v2.14.x: surface the tick re-entrancy guard so the cockpit + run-bar
    // can flip to "Checking now…" while a bulk-check is mid-fire.
    monitoringCheckInProgress: _checkInProgress,
    participatingProfileIds: campaign.participatingProfileIds || [],
    currentAction: campaign.currentAction,
    currentProfile: campaign.currentProfile,
    processedToday: campaign.processedToday,
    totalProcessed: campaign.totalProcessed,
    totalTargets: campaign.totalTargets || 0,
    mode: campaign.mode || '',
    name: campaign.name || '',
    sheetUrl: campaign.sheetUrl || '',
    profileNames: campaign.profileNames || [],
    profileIds: campaign.profileIds || [],
    logs: campaign.logs.slice(-100),
    errors: campaign.errors.slice(-20),
    parked: campaign.parkedProfiles.slice(),
    softWarnings: campaign.softWarnings.slice(),
    profileEndReasons: campaign.profileEndReasons.slice(),
    disk: { ..._diskStatusCache },
    resources: smp ? {
      ramPct:            smp.ramPct,
      load1:             smp.load1,
      cpuPct:            smp.cpuPct,
      cpuCount:          smp.cpuCount,
      browsers:          smp.browsers,
      totalBrowserRssMb: smp.totalBrowserRssMb,
      sampledAt:         smp.sampledAt,
    } : null,
    throttle: thr ? {
      active:     thr.active,
      reason:     thr.reason,
      multiplier: thr.multiplier,
    } : null,
  };
}

/**
 * Ends the Monitoring phase early. Stamps still-pending leads Closed -
 * Not Connected in the sheet, transitions the campaign to 'done', and
 * unregisters the log-bus appenders.
 *
 * Called by:
 *   - Operator clicks "Stop monitoring" in the UI (reason: 'operator-stopped')
 *   - T+7d auto-end watcher (reason: 'window-elapsed')
 *   - Restart resume finds an expired monitoringUntil (reason: 'window-elapsed-on-restart')
 */
export async function stopMonitoring({ reason = 'operator-stopped' } = {}) {
  // v2.14.x DIAG: trace which step fires (or doesn't) when the cockpit's
  // "stale monitoring view after Stop" symptom recurs. Captured in
  // /tmp/dev-app.log via server stdout. Pure additive — no behaviour change.
  console.log(`[stopMonitoring] called: reason=${reason}, state=${campaign.state}, monitoringUntil=${campaign.monitoringUntil}, nextCheckAt=${campaign.nextCheckAt}`);

  // v2.52.0: idempotent. A double-click (or in-flight first call finishing
  // after a second click arrives) used to surface "Campaign is not in
  // monitoring state" — alarming because the first call already succeeded.
  // Now we treat state='done' as the no-op success case so the UI never
  // misleads the operator about whether monitoring is still running.
  if (campaign.state === 'done') {
    console.log(`[stopMonitoring] idempotent: state already 'done', no-op`);
    // v2.52.0: surface idempotent stop in the user-facing log so the
    // operator sees their click reflected (was previously silent —
    // only the alarming "already ended" toast appeared with no log
    // trace, leaving the operator unsure whether their action landed).
    const tsIdem = `[${new Date().toISOString()}]`;
    campaign.logs = campaign.logs || [];
    campaign.logs.push(`${tsIdem} 🛏 Stop monitoring clicked — already ended (no-op).`);
    return { ok: true, alreadyStopped: true, stampedCount: 0, reason };
  }
  if (campaign.state !== 'monitoring') {
    console.log(`[stopMonitoring] early-return: state="${campaign.state}" is not 'monitoring'`);
    return { ok: false, error: 'Campaign is not in monitoring state' };
  }

  console.log('[stopMonitoring] passed state guard, flipping state BEFORE slow sheet work');

  // Capture context before state flip — protects against a new campaign
  // overwriting campaign.sheetUrl while the stamp call is in flight.
  const sheetUrl = campaign.sheetUrl;
  const linkedinColumn = campaign.linkedinColumn || '';
  const sheetId = _extractSheetIdFromUrl(sheetUrl);
  const participatingProfileIds = Array.isArray(campaign.participatingProfileIds)
    ? campaign.participatingProfileIds.slice() : [];

  // ── State transition + timer cleanup FIRST ──────────────────────────
  // Move state to 'done' BEFORE the sheet stamp. Without this, the 60s
  // monitoring watcher tick fires a fresh runMonitoringCheckAll during
  // the stamp call (its state guard at line 3237 still sees 'monitoring'),
  // and the cockpit + dashboard show "monitoring" until the stamp finishes.
  campaign.state = 'done';
  console.log(`[stopMonitoring] state set to 'done'`);
  _ops('INFO', `Monitoring ended (${reason})`);

  // v2.52.0: kick a "stopping…" line into the user-facing log immediately,
  // BEFORE the slow Apps Script batch stamp (5-10s). Without this, the
  // operator clicks Stop and sees zero log activity for the duration of
  // the stamp call, leaving them unsure whether their action landed —
  // which is what drives the multi-click → idempotent-path loop.
  const tsStopping = `[${new Date().toISOString()}]`;
  campaign.logs = campaign.logs || [];
  campaign.logs.push(`${tsStopping} 🛏 Stopping monitoring (${reason}) — finalizing sheet stamps…`);

  // v2.14.x: cancel any armed pre-fire heads-up (we just left monitoring).
  if (_preFireTimer) { clearTimeout(_preFireTimer); _preFireTimer = null; }
  _preFireNotifiedFor = null;

  // Unregister log-bus appenders for every participating profile.
  for (const pid of participatingProfileIds) {
    unregisterAppender(sheetId, pid);
  }

  // Clear the on-disk monitoring slice so a crash-then-restart doesn't
  // resume monitoring on a stopped campaign.
  try { await clearMonitoringState(); } catch { /* */ }

  // ── Sheet stamping (single batch call) ──────────────────────────────
  // Replaces the previous serial updateSheetRow loop (one HTTP round-trip
  // per pending lead). With ~50 pending leads, the serial path took
  // 2-5 minutes — long enough that the watcher tick fired a fresh check
  // mid-stop. Batch path is one HTTP call regardless of count: ~5-10s.
  let stampedCount = 0;
  try {
    const rows = await fetchSheetRows(sheetUrl);
    const pendingUrls = computeStillPendingUrls(rows, linkedinColumn);
    if (pendingUrls.length > 0) {
      const updates = pendingUrls.map((url) => ({
        linkedinUrl: url,
        ...buildClosedNotConnectedUpdate(),
      }));
      const ok = await batchUpdateSheet(sheetUrl, updates);
      if (ok) {
        stampedCount = pendingUrls.length;
      } else {
        console.warn(`[stopMonitoring] batchUpdateSheet returned false for ${pendingUrls.length} pending lead(s)`);
      }
    }
  } catch (err) {
    console.warn(`[stopMonitoring] sheet stamp failed: ${err.message}`);
  }

  console.log(`[stopMonitoring] stamp batch done: stamped=${stampedCount} pending lead(s)`);

  // Append a final log line.
  const ts = `[${new Date().toISOString()}]`;
  campaign.logs = campaign.logs || [];
  campaign.logs.push(`${ts} 🛏 Monitoring ended (reason: ${reason}) · ${stampedCount} still-pending lead(s) stamped Closed - Not Connected`);

  console.log(`[stopMonitoring] return ok=true, stampedCount=${stampedCount}, reason=${reason}`);
  return { ok: true, stampedCount, reason };
}

/**
 * v2.14 — Module-level tick callback. Two duties on each fire:
 *   1. T+7d auto-end: if monitoringUntil has elapsed, stop monitoring.
 *   2. Auto-check: if nextCheckAt is overdue, fire runMonitoringCheckAll
 *      and reschedule nextCheckAt by the operator-chosen cadence.
 *
 * Re-entrancy guard (_checkInProgress) prevents double-fire when the bulk
 * check takes longer than the heartbeat interval.
 *
 * The `_testStub` param is for unit tests only — when provided, it
 * replaces runMonitoringCheckAll. Production callers omit it.
 */
let _monitoringWatcherTimer = null;
let _checkInProgress = false;
// v2.14.x: pre-fire heads-up. 15 s before each auto-check, fire a
// desktop notification + cockpit log line so the operator can context-
// switch out of LinkedIn before the bulk-check tab opens.
const PRE_FIRE_OFFSET_MS = 15_000;
let _preFireTimer = null;
let _preFireNotifiedFor = null; // ISO of the nextCheckAt we've already notified for

function _firePreCheckNotification() {
  try {
    const names = (campaign.participatingProfileIds || [])
      .map((pid) => {
        const idx = (campaign.profileIds || []).indexOf(pid);
        return idx >= 0 ? (campaign.profileNames || [])[idx] || pid : pid;
      })
      .filter(Boolean)
      .join(', ');
    const title = 'Bulk check fires in 15s';
    const body = names
      ? `About to check connections for ${names}.`
      : 'About to fire monitoring auto-check.';
    enqueueDesktopNotification({ title, body, audience: campaign.createdBy || null });
    const ts = `[${new Date().toISOString()}]`;
    campaign.logs = campaign.logs || [];
    campaign.logs.push(`${ts} ⏰ ${title} — ${body}`);
  } catch (err) {
    console.warn('[pre-fire] notification failed:', err.message);
  }
}

export function schedulePreFireHeadsUp() {
  if (_preFireTimer) {
    clearTimeout(_preFireTimer);
    _preFireTimer = null;
  }
  if (campaign.state !== 'monitoring' || !campaign.nextCheckAt) return;
  if (_preFireNotifiedFor === campaign.nextCheckAt) return; // already done for this cycle
  const targetMs = new Date(campaign.nextCheckAt).getTime();
  const delay = targetMs - PRE_FIRE_OFFSET_MS - Date.now();
  if (delay <= 0) return; // already inside the 15s window or past it
  _preFireTimer = setTimeout(() => {
    _preFireNotifiedFor = campaign.nextCheckAt;
    _firePreCheckNotification();
  }, delay);
  // Don't keep the Node event loop alive solely on this timer — otherwise
  // `node --test` processes hang after their assertions pass.
  if (_preFireTimer && typeof _preFireTimer.unref === 'function') {
    _preFireTimer.unref();
  }
}

export async function tickMonitoringNow({ _testStub = null } = {}) {
  try {
    if (campaign.state !== 'monitoring') return;

    // Duty 1: 7-day window expiry (existing behavior)
    if (campaign.monitoringUntil) {
      const until = new Date(campaign.monitoringUntil).getTime();
      if (Date.now() >= until) {
        await stopMonitoring({ reason: 'window-elapsed' }).catch((err) => {
          console.warn('[monitoring-tick] stopMonitoring threw:', err.message);
        });
        return;
      }
    }

    // Duty 2: fire bulk-check + auto-intros when nextCheckAt is overdue
    if (!campaign.nextCheckAt) return;
    if (Date.now() < new Date(campaign.nextCheckAt).getTime()) return;
    if (_checkInProgress) return;

    _checkInProgress = true;
    const cadenceMin = campaign.checkIntervalMinutes || 60;
    const ts = `[${new Date().toISOString()}]`;
    campaign.logs = campaign.logs || [];
    campaign.logs.push(`${ts} 🛏 Monitoring · auto-check starting (cadence=${cadenceMin}m)`);

    try {
      if (_testStub) {
        await _testStub();
      } else {
        await runMonitoringCheckAll();
      }
    } catch (err) {
      console.warn('[monitoring-tick] runMonitoringCheckAll threw:', err.message);
    } finally {
      // Reschedule ONLY if still in monitoring state (operator may have stopped mid-fire)
      if (campaign.state === 'monitoring') {
        const ms = (campaign.checkIntervalMinutes || 60) * 60_000;
        // v2.14.x: schedule the next tick from the PREVIOUS nextCheckAt
        // boundary, not from "now" (which is whenever the bulk-check
        // happened to finish). Without this, a 1-2 min bulk-check
        // compounded drift on every cycle (15min → 17min → 19min → …).
        // If the bulk-check ran long and the next boundary is already in
        // the past, advance forward by whole intervals so the watcher
        // fires immediately on the next 60s tick to catch up.
        const prevNext = campaign.nextCheckAt ? new Date(campaign.nextCheckAt).getTime() : Date.now();
        let nextNext = prevNext + ms;
        const _now = Date.now();
        if (nextNext <= _now) {
          // Skipped one or more cadence boundaries — advance to the
          // smallest boundary strictly AFTER now. Mirrors the
          // floor(elapsed/ms)+1 formula in recomputeNextCheckAt
          // (monitoring-time.js:23) so behaviour matches the boot/wake
          // resume path. Earlier ceil-based formula was off-by-one when
          // _now landed mid-interval (prev=0, ms=15, now=20 → returned
          // 45 instead of 30).
          const ticksPassed = Math.floor((_now - prevNext) / ms) + 1;
          nextNext = prevNext + ticksPassed * ms;
        }
        campaign.nextCheckAt = new Date(nextNext).toISOString();
        _preFireNotifiedFor = null; // new cycle — re-arm the pre-fire heads-up
        try { await writeMonitoringState(campaign); } catch { /* */ }
        const hhmm = (d) => `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
        campaign.logs.push(`[${new Date().toISOString()}] 🛏 Monitoring · next check at ${hhmm(new Date(campaign.nextCheckAt))}`);
        schedulePreFireHeadsUp();
      }
      _checkInProgress = false;
    }
  } catch (err) {
    console.warn('[monitoring-tick] outer threw:', err.message);
    _checkInProgress = false;
  }
}

export function startMonitoringWatcher() {
  if (_monitoringWatcherTimer) return;
  _monitoringWatcherTimer = setInterval(() => {
    tickMonitoringNow().catch((err) => console.warn('[monitoring-watcher] tick threw:', err.message));
  }, 60 * 1000);
}

export function stopMonitoringWatcher() {
  if (_monitoringWatcherTimer) {
    clearInterval(_monitoringWatcherTimer);
    _monitoringWatcherTimer = null;
  }
}

/**
 * Called at app boot. Reads the persisted monitoring slice (if any),
 * rehydrates `campaign` with its fields, then decides whether to resume
 * or expire based on monitoringUntil vs now.
 *
 * Idempotent — safe to call multiple times.
 */
export async function resumeMonitoringFromDisk() {
  const slice = await readMonitoringState();
  if (!slice) return { action: 'noop', reason: 'no-persisted-state' };

  // Rehydrate the campaign global with the persisted slice fields
  Object.assign(campaign, slice);

  const decision = decideResumeAction(campaign, new Date());
  if (decision.action === 'expire') {
    await stopMonitoring({ reason: 'window-elapsed-on-restart' });
    return { action: 'expire' };
  }
  if (decision.action === 'resume') {
    campaign.nextCheckAt = decision.recomputedNextCheckAt.toISOString();
    _preFireNotifiedFor = null; // resume after restart — re-arm
    const ts = `[${new Date().toISOString()}]`;
    const _hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    campaign.logs = campaign.logs || [];
    campaign.logs.push(`${ts} 🛏 Monitoring resumed · next check at ${_hhmm(decision.recomputedNextCheckAt)}`);
    schedulePreFireHeadsUp();
    try {
      const _sheetId = _extractSheetIdFromUrl(campaign.sheetUrl);
      const _appender = buildAppendLogger({ logs: campaign.logs, capLines: 5000 });
      for (const _pid of (campaign.participatingProfileIds || [])) {
        registerAppender(_sheetId, _pid, _appender);
      }
    } catch (busErr) {
      console.warn('[monitoring-resume] log bus re-registration failed:', busErr.message);
    }
    // Persist the updated nextCheckAt
    await writeMonitoringState(campaign);
    return { action: 'resume' };
  }
  return { action: 'noop' };
}

/**
 * Test-only state setter. DO NOT call from production code.
 * Exposed so tests/status-payload.test.js can assert shape without
 * driving the full campaign loop.
 */
export function _setTestState(patch) {
  if (patch && typeof patch === 'object') {
    Object.assign(campaign, patch);
  }
}

/**
 * Returns the current campaign global (shallow reference).
 * Used by the monitoring HTTP routes in server.js.
 */
export function getCampaignState() {
  return campaign;
}

/**
 * Module-level monitoring bulk-check helper. Mirrors the inside-startCampaign
 * `runIdleBulkCheck` closure but reads its config from the persisted
 * `campaign` global rather than closure-bound locals. Used by:
 *   - The Check now button (immediate, no cooldown gate)
 *   - The T+7d auto-end watcher (when it wants to fire a final pass — future)
 *
 * Acquires browserSemaphore, opens profile, fires bulkCheck +
 * runAutoIntros, updates cooldown, closes. Failures non-fatal — logs to the
 * campaign log via the bus.
 */
export async function runMonitoringCheck(profileId, profileName) {
  if (campaign.state !== 'monitoring') {
    return { ok: false, error: 'Campaign not in monitoring state' };
  }
  const sheetUrl = campaign.sheetUrl;
  const linkedinColumn = campaign.linkedinColumn || '';
  const templates = campaign.templates || {};
  const token = process.env.GOLOGIN_API_TOKEN;

  await browserSemaphore.acquire();
  let launched;
  try {
    const ts = `[${new Date().toISOString()}]`;
    const msg = `📡 [${profileName}] Check now — bulk check pass starting…`;
    campaign.logs = campaign.logs || [];
    campaign.logs.push(`${ts} ${msg}`);

    launched = await launchProfile(profileId, token);

    const willAutoIntro = !!(
      templates.primaryName && templates.primaryName.trim() &&
      templates.primaryIntroBody && templates.primaryIntroBody.trim()
    );
    const r = await bulkCheckConnections(launched.page, sheetUrl, linkedinColumn, profileName, {
      // v2.14.x: stamp Connection Accepted immediately at bulk-check detection
      // so the operator sees acceptance in the sheet BEFORE the intro DM fires.
      // The auto-intro pass then only stamps Introduction Status (no longer
      // batched into a single Apps Script write).
      suppressAcceptedStamp: false,
    });

    const ts2 = `[${new Date().toISOString()}]`;
    if (r.error) {
      campaign.logs.push(`${ts2} ⚠ [${profileName}] Check now: ${r.error}`);
    } else {
      const stamped = r.stamped || 0;
      campaign.logs.push(`${ts2} 📡 [${profileName}] Check now: ${r.matched} Connected, ${stamped} Still Pending (of ${r.fetched})`);
    }

    if (willAutoIntro && Array.isArray(r.connectedUrls) && r.connectedUrls.length > 0) {
      await runAutoIntros({
        page: launched.page,
        profileId,
        profileName,
        sheetUrl,
        linkedinColumn,
        connectedUrls: r.connectedUrls,
        templates,
        senderFirstNames: campaign.senderFirstNames || {},
        log: (line) => {
          const ts3 = `[${new Date().toISOString()}]`;
          campaign.logs.push(`${ts3} ${line}`);
        },
      });
    }

    // Update cooldown — same as runIdleBulkCheck
    const _sheetId = _extractSheetIdFromUrl(sheetUrl);
    const cooldown = await readBulkCheckCooldown();
    cooldown[bulkCheckKey(_sheetId, profileId)] = Date.now();
    await writeBulkCheckCooldown(cooldown);

    await writeMonitoringState(campaign);
    return { ok: true, matched: r.matched, stamped: r.stamped, connectedUrls: r.connectedUrls || [] };
  } catch (err) {
    const ts4 = `[${new Date().toISOString()}]`;
    campaign.logs = campaign.logs || [];
    campaign.logs.push(`${ts4} ⚠ [${profileName}] Check now failed: ${err.message}`);
    return { ok: false, error: err.message };
  } finally {
    try {
      if (profileId === 'local-browser') await closeLocalBrowser();
      else await closeProfile(profileId);
    } catch { /* */ }
    browserSemaphore.release();
  }
}

/**
 * Orchestrator: fire runMonitoringCheck for ALL participating profiles
 * sequentially. Returns an array of per-profile results.
 */
export async function runMonitoringCheckAll() {
  if (campaign.state !== 'monitoring') {
    return { ok: false, error: 'Campaign not in monitoring state' };
  }
  const results = [];
  for (const pid of (campaign.participatingProfileIds || [])) {
    const idx = (campaign.profileIds || []).indexOf(pid);
    const pName = idx >= 0 ? (campaign.profileNames || [])[idx] : pid;
    const r = await runMonitoringCheck(pid, pName || pid);
    results.push({ profileId: pid, ...r });
  }
  return { ok: true, results };
}
