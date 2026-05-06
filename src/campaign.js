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
import { launchProfile, closeProfile, getProfiles, getProfilePid } from './gologin-launcher.js';
import { launchLocalBrowser, closeLocalBrowser } from './local-launcher.js';
import { fetchSheet as fetchSheetRows } from './sheets.js';
import { updateSheetRow, ensureTrackingColumns } from './sheets-writer.js';
import { performOutreach } from './linkedin/outreach.js';
import { dataPath } from './paths.js';
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
const SUCCESS_ACTIONS = new Set(['connection_sent', 'message_sent', 'inmail_sent', 'op_message_sent', 'already_processed', 'status_accepted', 'status_pending', 'status_declined']);

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
const LEAD_TIMEOUT_MS = Number(process.env.LEAD_TIMEOUT_MS) || 180000;

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

function withWatchdog(promise, timeoutMs, profileId) {
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

async function appendHistory(entry) {
  let history = [];
  try { history = JSON.parse(await readFile(HISTORY_PATH, 'utf8')); } catch { /* first run */ }
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

// Campaign-scoped counters — reset every time a campaign starts
const campaignCounts = {};

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
  if (lower.includes('send not confirmed') || lower.includes('send_not_confirmed')) return 'Skipped: Send not confirmed';
  // v2.10.0 — VOYAGER_REJECTED carries the HTTP status + LinkedIn's own error reason.
  // Preserve the status code in the normalised stage so the user can see it at a glance.
  if (lower.includes('voyager_rejected')) {
    const statusMatch = s.match(/HTTP\s+(\d+)/i);
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
  if (mode === 'message_only') return 'force_message';
  if (mode === 'check_status') return 'check_only';
  if (mode === 'inmail_only') return 'force_inmail';
  if (mode === 'open_profile_only') return 'force_open_profile';
  if (mode === 'connect_and_message') {
    return prevAction === 'connection_sent' ? 'force_message' : 'force_connect';
  }
  return null;
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
export const campaign = {
  running: false,
  _abort: false,
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
};

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

function log(msg) {
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

export async function startCampaign({ profileIds, sheetUrl, templates, dailyLimit = 50, mode = 'connect_only', messageOpenProfiles = false, delayMin = 15, delayMax = 45, linkedinColumn = '', senderFirstNames = {}, concurrency = 1 }) {
  if (campaign.running) throw new Error('Campaign already running');

  campaign.running = true;
  campaign._abort = false;
  campaign._paused = false;
  campaign._pauseRequested = false;
  campaign.currentProfile = null;
  campaign.processedToday = 0;
  campaign.totalProcessed = 0;
  campaign.totalTargets = 0;
  campaign.mode = mode;
  campaign.profileNames = [];
  campaign.errors = [];
  campaign.parkedProfiles = [];
  campaign.softWarnings = [];
  campaign._lastSample = null;   // phase 11.1: reset resource snapshot
  campaign._throttle   = null;   // phase 11.1: reset throttle state
  _resetSampleCache();           // clear module-level cache so first sample() is fresh
  browserSemaphore._reset();     // 2.9.9: reset hard browser cap to default
  browserSemaphore.setMax(MAX_CONCURRENT_PROFILES);

  // Reset campaign counts — allows reusing same accounts immediately
  for (const key of Object.keys(campaignCounts)) delete campaignCounts[key];

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
    // 2.8.50: Introduction Messages — sub-mode of message_only. When introMode
    // is true, sendMessage routes to sendIntroMessage which adds introName as
    // a second recipient and sets a group title. Sheet stamp becomes "sent IC".
    introMode: !!templates.introMode,
    introName: (templates.introName || '').trim(),
    introTitle: templates.introTitle || 'Introduction: {first name} <> {intro name}',
  };

  const campaignStartTime = Date.now();

  try {
    rotateCampaignLogIfBig();
    log('=== Campaign starting ===');
    log(`Mode: ${mode}`);
    log(`Profiles: ${profileIds.length} selected`);
    const _NO_LIMIT_MODES = new Set(['check_status', 'message_only', 'inmail_only', 'open_profile_only']);
    log(`Campaign limit per account: ${_NO_LIMIT_MODES.has(mode) ? 'unlimited (fast-mode)' : dailyLimit}`);
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

    // Ensure tracking columns exist (Status, OP, Message, InMail, Account Used, Date Last Action)
    await ensureTrackingColumns(sheetUrl).catch(err => {
      log(`⚠ Could not ensure tracking columns: ${err.message}`);
    });

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

    const targets = rows.filter(row => {
      const url = extractLinkedInUrl(row, linkedinColumn);
      if (!url) return false;

      // ── 2.9.0 Stage-based filtering ─────────────────────────────
      if (hasStageSchema) {
        const stage = (row['Stage'] || row['stage'] || '').toString().trim();
        const TERMINAL = new Set(['DM Sent', 'IC Sent', 'InM Sent', 'OP Sent', 'Replied', 'Done']);
        // 2.9.10: Stage may now carry the full skip reason
        // (e.g., "Skipped: URL not found"), not just bare "Skipped". Any value
        // starting with "Skipped" is terminal.
        const isSkipped = stage.startsWith('Skipped');

        if (mode === 'check_status') {
          return stage === 'Connect Pending';
        }
        if (mode === 'message_only') {
          // Standard DM and Introduction sub-mode both source from
          // Connected · DM Now.
          if (stage !== 'Connected · DM Now') return false;
          const prev = state.processed[url];
          if (prev && (prev.action === 'message_sent' || prev.action === 'op_message_sent')) return false;
          return true;
        }
        if (mode === 'connect_only') {
          // Cold targets: Stage empty (never touched) or 'Send Connect'.
          // Skipped (any reason) is terminal — exclude.
          if (isSkipped) return false;
          if (stage !== '' && stage !== 'Send Connect') return false;
          const prev = state.processed[url];
          if (prev) return false;
          return true;
        }
        if (mode === 'inmail_only' || mode === 'open_profile_only') {
          // InMail and OP are Connect alternatives — same source.
          if (isSkipped) return false;
          if (stage !== '' && stage !== 'Send Connect') return false;
          const prev = state.processed[url];
          if (prev) return false;
          return true;
        }
        // connect_and_message and other multi-step modes: terminal stages skip,
        // everything else passes through.
        if (TERMINAL.has(stage) || isSkipped) return false;
        const prev = state.processed[url];
        if (prev) return false;
        return true;
      }

      // ── Legacy schema filtering (sheets without a Stage column) ──
      const status    = (row['Status']  || row['status']  || '').toString().toLowerCase().trim();
      const cc        = (row['CC']      || row['cc']      || '').toString().toLowerCase().trim();
      const opCell    = (row['OP']      || row['op']      || '').toString().toLowerCase().trim();
      const msgCell   = (row['Message'] || row['message'] || '').toString().toLowerCase().trim();
      const inmailCell= (row['InMail']  || row['inmail']  || '').toString().toLowerCase().trim();
      const msgSent   = msgCell === 'sent' || opCell === 'sent';

      if (mode === 'check_status') {
        // 2.8.29: Account Used (column D) being filled = an invite was sent.
        // CC text is no longer the source of truth.
        const acct = (row['Account Used'] || row['account used'] || '').toString().trim();
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
        const ccRaw = (row['CC'] || row['cc'] || '').toString();
        if (!/\sY\s*$/.test(ccRaw)) return false;
        return true;
      }

      if (status === 'done') return false;

      if (mode === 'connect_only') {
        if (cc) return false;
        // Phase 2.8.17 (H-04): if messageOpenProfiles routed this lead via the
        // OP path on a previous run, OP="sent" — don't re-message. Belt-and-
        // suspenders with the H-02 CC stamp; either alone closes the loophole
        // but checking both makes the rule robust to manual sheet edits.
        if (messageOpenProfiles && opCell === 'sent') return false;
        const prev = state.processed[url];
        if (prev) return false;
        return true;
      }

      if (mode === 'open_profile_only') {
        if (msgSent) return false;
        // P-04 fix (2.8.18): the in-loop sheet write is best-effort
        // (.catch(()=>{}) on every updateSheetRow). A transient Sheets API
        // outage immediately after a successful send leaves the sheet
        // un-stamped — but state.processed[url] WAS updated. Without this
        // check, the next campaign run re-sends the same message to the
        // same 1st-degree connection.
        if (state.processed[url]) return false;
        return true;
      }

      if (mode === 'inmail_only') {
        if (inmailCell === 'sent') return false;
        if (state.processed[url]) return false;
        return true;
      }

      const prev = state.processed[url];
      if (prev) return false;
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
    const tokenNeeded = hasGoLoginProfiles || mode === 'check_status' || mode === 'message_only';
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
    if (mode === 'check_status' || mode === 'message_only') {
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
        const acct = (row['Account Used'] || row['account used'] || '').toString().trim();
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

      const modeLabel = (mode === 'check_status') ? 'Check Status' : 'Message Only';
      const rowLabel = (mode === 'check_status') ? 'pending' : 'connected (Y)';
      log(`${modeLabel} auto-routing → ${derivedProfileIds.length} sender(s) found in sheet`);
      sendersInSheet.forEach((count, name) => log(`  • ${name}: ${count} ${rowLabel}`));
      if (unmatchedSenders.size > 0) {
        log(`⚠ Skipping ${[...unmatchedSenders.values()].reduce((a,b)=>a+b,0)} row(s) whose Account Used is unknown:`);
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
        const acct = (row['Account Used'] || row['account used'] || '').toString().trim();
        const pid = nameToId[acct];
        if (pid && _checkStatusTargetsByProfile[pid]) {
          _checkStatusTargetsByProfile[pid].push(row);
        }
      }
    }

    campaign.profileNames = profileIds.map(id => profileNameCache[id] || id);
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

    log(`\n✓ Starting batch loop (BATCH_SIZE=${BATCH_SIZE})…\n`);

    // 2.9.8: modes that bypass the daily limit entirely.
    //   - check_status: read-only Voyager fetch, zero LinkedIn-visible action
    //   - message_only: DMs to 1st-degree connections, low risk
    //   - inmail_only: paid InMail credits already gate volume
    //   - open_profile_only: free Open-Profile messages, no connection req
    // Connect campaigns (connect_only, connect_and_message) STILL respect
    // the dailyLimit — those are the ones LinkedIn rate-limits aggressively.
    const NO_DAILY_LIMIT = new Set(['check_status', 'message_only', 'inmail_only', 'open_profile_only']);
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
        if (campaign._abort) return;
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
        const innerLimit = (mode === 'check_status' || mode === 'message_only') ? Infinity : BATCH_SIZE;
        for (let leadInBatch = 0; leadInBatch < innerLimit && !campaign._abort; leadInBatch++) {
        // Phase 2.8.9: pause check at the lead boundary — never mid-lead.
        await awaitUnpause();
        if (campaign._abort) break;
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
        if ((mode === 'check_status' || mode === 'message_only') && _checkStatusTargetsByProfile) {
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
            if (mode !== 'message_only' && mode !== 'open_profile_only' && state.processed[candidateUrl]) continue;
            const sheetStatus = (candidate['Status'] || candidate['status'] || '').toLowerCase();
            if (mode === 'connect_only') {
              if (sheetStatus) continue;
            }
            row = candidate;
            break;
          }
        }

        if (!row) {
          // 2.8.28-P2 / 2.8.31: per-profile exhaustion is normal in auto-routed
          // modes — skip this profile, end only when ALL profiles have drained.
          if ((mode === 'check_status' || mode === 'message_only') && _checkStatusTargetsByProfile) {
            _checkStatusExhausted.add(profileId);
            if (_checkStatusExhausted.size >= profileIds.length) {
              const label = (mode === 'check_status') ? 'Check Status' : 'Message Only';
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
        const status    = (row['Status']  || row['status']  || '').toString().toLowerCase().trim();
        const cc        = (row['CC']      || row['cc']      || '').toString().toLowerCase().trim();
        const msgCell   = (row['Message'] || row['message'] || '').toString().toLowerCase().trim();
        const opCell    = (row['OP']      || row['op']      || '').toString().toLowerCase().trim();
        const inmailCell= (row['InMail']  || row['inmail']  || '').toString().toLowerCase().trim();
        const msgSent   = msgCell === 'sent' || opCell === 'sent';

        if (mode === 'check_status') {
          // 2.8.29: criterion is Account Used filled, not CC=Sent.
          const acct = (row['Account Used'] || row['account used'] || '').toString().trim();
          if (!acct) { delete state.processed[url]; continue; }
          // 2.8.28-P2: routing guard removed. The per-profile target slices
          // built at auto-derivation time already guarantee each profile sees
          // only rows it originally sent. The defense-in-depth name-equality
          // check tripped on local-browser variants (e.g., row says
          // "local-browser", pName is "Local Browser") and broke an entire
          // legitimate code path. Slice-based filtering is sufficient.
        } else if (mode === 'message_only') {
          // 2.8.31: re-validate Y suffix and msg-not-sent in case the sheet
          // was updated between pre-filter and now.
          const ccRaw = (row['CC'] || row['cc'] || '').toString();
          if (!/\sY\s*$/.test(ccRaw)) { delete state.processed[url]; continue; }
          if (msgSent) { delete state.processed[url]; continue; }
        } else {
          if (status === 'done') { delete state.processed[url]; continue; }
          if (mode === 'open_profile_only' && msgSent) {
            delete state.processed[url]; continue;
          }
          if (mode === 'inmail_only' && inmailCell === 'sent') {
            delete state.processed[url]; continue;
          }
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
          } catch { /* keep current */ }

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
            } catch { /* */ }
          }
          // 2.9.8: surface a normalized "Skipped: <reason>" in the dashboard
          // log too, so the operator sees the same wording the Audit Log uses.
          if (result.action === 'skipped' && result.error) {
            log(`  ${normalizeSkipReason(result.error)}`);
          } else {
            log(`  ${result.action}${result.error ? ' — ' + result.error : ''}`);
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

            // 2.8.28: For check_status, do NOT include accountUsed — preserving
            // the original sender attribution is essential. The audit log
            // append is also conditionally suppressed for check_status reads.
            // 2.9.3: always stamp Sender on non-check-status writes. Without
            // this, action paths that didn't explicitly set sender (like
            // 'already_processed') left the Sender column empty even though
            // the row WAS handled by an account.
            const sheetData = (mode === 'check_status')
              ? { dateLastAction: now }
              : { dateLastAction: now, accountUsed: pName, sender: pName };
            // 2.8.50: when Introduction Messages mode is active, stamp the DM
            // column with "sent IC" instead of "sent" so introductions are
            // visually distinct from standard DMs in the sheet.
            const sentLabel = (tpl.introMode && mode === 'message_only') ? 'sent IC' : 'sent';
            const hyperSent = `=HYPERLINK("${url}","${sentLabel}")`;

            // 2.9.0: every action also writes a Stage value (single
            // source-of-truth column). On sheets without a Stage column,
            // the bridge silently ignores unknown fields — old sheets
            // keep working unchanged.
            if (result.action === 'connection_sent') {
              sheetData.status = 'Done';
              // Phase 2.8.10: write the sender's account name into CC instead
              // of the generic "Sent" so the operator can see at a glance
              // which profile sent each connection request.
              sheetData.cc = pName;
              sheetData.auditAction = 'Connection sent';
              sheetData.stage  = 'Connect Pending';
              sheetData.sender = pName;
            } else if (result.action === 'already_processed') {
              // 2.9.3: the lead is already in the state this campaign would
              // produce (e.g., Connect Only saw the invite was already
              // pending). Stamp Stage so empty-Stage rows don't stay empty
              // after a re-run. Sender already in initial sheetData.
              sheetData.auditAction = 'Already in target state';
              if (mode === 'connect_only')      sheetData.stage = 'Connect Pending';
              else if (mode === 'message_only') sheetData.stage = (tpl.introMode ? 'IC Sent' : 'DM Sent');
              else if (mode === 'inmail_only')  sheetData.stage = 'InM Sent';
              else if (mode === 'open_profile_only') sheetData.stage = 'OP Sent';
              // For other/unknown modes leave Stage alone — overwriting
              // with a guess could clobber a known-good prior state.
            } else if (result.action === 'message_sent') {
              // 2.8.49: status "DM Sent" (was "Done"). Keeps CC color (green
              // from check_status) intact — the catch-all CC conditional-
              // format rule excludes "Check Done." and "DM Sent".
              sheetData.status = 'DM Sent';
              sheetData.message = hyperSent;
              sheetData.auditAction = 'Message sent';
              sheetData.stage  = (tpl.introMode && mode === 'message_only') ? 'IC Sent' : 'DM Sent';
              sheetData.sender = pName;
            } else if (result.action === 'op_message_sent') {
              sheetData.status = 'DM Sent';
              sheetData.op = hyperSent;
              // Phase 2.8.17 (H-02): when this run was a Connect campaign that
              // routed a Free-to-Open-Profile lead via the OP path, also stamp
              // CC with pName so the operator can see at a glance which Connect
              // run touched the lead. Without this, OP-via-Connect leads look
              // un-touched in the CC column and a re-run sends the OP message
              // again (cf. H-04).
              if (mode === 'connect_only' && messageOpenProfiles) {
                sheetData.cc = pName;
                sheetData.auditAction = 'Open Profile message sent (via connect mode)';
              } else {
                sheetData.auditAction = 'Open Profile message sent';
              }
              sheetData.stage  = 'OP Sent';
              sheetData.sender = pName;
            } else if (result.action === 'inmail_sent') {
              sheetData.status = 'Done';
              sheetData.inmail = hyperSent;
              sheetData.auditAction = 'InMail sent';
              sheetData.stage  = 'InM Sent';
              sheetData.sender = pName;
              if (typeof result.creditsLeft === 'number') {
                sheetData.auditNotes = `InMail credits left: ${result.creditsLeft}`;
                log(`  💳 InMail credits left: ${result.creditsLeft}`);
                if (result.creditsLeft <= 0) {
                  log(`  ⚠ ${pName} has 0 InMail credits — removing from InMail rotation.`);
                  weeklyLimited.add(profileId);
                }
              }
            } else if (result.action === 'status_accepted') {
              // 2.8.31: CC text gets " Y" suffix (Voyager-confirmed connection).
              // The Y is what Message-Only filters on — only Y rows get DM'd.
              sheetData.status = 'Check Done.';
              sheetData.ccColor = 'green';
              sheetData.connected = true;
              sheetData.auditAction = 'Acceptance confirmed';
              sheetData.stage = 'Connected · DM Now';
            } else if (result.action === 'status_pending') {
              sheetData.status = 'Check Done.';
              sheetData.ccColor = 'yellow';
              sheetData.connected = false;
              sheetData.auditAction = 'Still pending';
              // No stage write — leave at 'Connect Pending' (where it already is).
            } else if (result.action === 'status_declined') {
              // 2.8.39: outreach.js no longer emits status_declined — Check
              // Status is now two-state (accepted/pending). This branch is
              // kept as defensive fallback in case anything downstream still
              // emits the old action. Render as yellow to match the new
              // "no red" rule.
              sheetData.status = 'Check Done.';
              sheetData.ccColor = 'yellow';
              sheetData.connected = false;
              sheetData.auditAction = 'Not confirmed connected';
            }
            // status_unknown: no connected field — leave CC text alone
            await updateSheetRow(sheetUrl, url, sheetData, linkedinColumn).catch(() => {});

            log(`  ✓ [${pName}] (${getCampaignCount(profileId)}/${dailyLimit})`);
            consecutiveSkips.set(profileId, 0);
          } else {
            const skipCount = (consecutiveSkips.get(profileId) || 0) + 1;
            consecutiveSkips.set(profileId, skipCount);
            if (skipCount >= SKIP_PARK_THRESHOLD && !weeklyLimited.has(profileId)) {
              log(`  ⚠ ${pName}: ${SKIP_PARK_THRESHOLD} consecutive non-success outcomes — parking account for rest of run.`);
              weeklyLimited.add(profileId);
              campaign.parkedProfiles.push({
                profileId,
                pName,
                parkedAt: Date.now(),
                reason: 'consecutive_skips',
                skipCount,
              });
            }
            const errorMsg = result.error || result.action;

            if (errorMsg.includes('WEEKLY_LIMIT')) {
              log(`  ⚠ WEEKLY LIMIT reached for ${pName}. Removing from rotation.`);
              weeklyLimited.add(profileId);
              pushSoftWarning(campaign, {
                profileId,
                pName,
                kind: 'weekly_limit',
                message: 'Weekly invitation limit reached',
              });
              await updateSheetRow(sheetUrl, url, {
                status: normalizeSkipReason('Weekly invitation limit reached'),
                stage:  normalizeSkipReason('Weekly invitation limit reached'),
                accountUsed: pName,
                sender: pName,
                dateLastAction: now,
                auditAction: normalizeSkipReason('Weekly invitation limit reached'),
              }, linkedinColumn).catch(() => {});
            } else if (errorMsg.includes('INMAIL_NO_CREDITS')) {
              log(`  ⚠ InMail credits exhausted for ${pName}. Removing from rotation.`);
              weeklyLimited.add(profileId);
              await updateSheetRow(sheetUrl, url, {
                status: normalizeSkipReason('InMail credits exhausted'),
                stage:  normalizeSkipReason('InMail credits exhausted'),
                accountUsed: pName,
                sender: pName,
                dateLastAction: now,
                auditAction: normalizeSkipReason('InMail credits exhausted'),
              }, linkedinColumn).catch(() => {});
            } else if (errorMsg.includes('EMAIL_REQUIRED')) {
              log(`  ⚠ Email required for ${data.firstName || '?'}. Skipping lead.`);
              pushSoftWarning(campaign, {
                profileId,
                pName,
                kind: 'email_required',
                message: 'LinkedIn requires email to connect',
              });
              state.processed[url] = { profileId, profileName: pName, action: 'email_required', date: now };
              await saveState(state);
              await updateSheetRow(sheetUrl, url, {
                status: normalizeSkipReason('Email required to connect'),
                cc: 'Unreachable',
                stage:  normalizeSkipReason('Email required to connect'),
                accountUsed: pName,
                sender: pName,
                dateLastAction: now,
                auditAction: normalizeSkipReason('Email required to connect'),
              }, linkedinColumn).catch(() => {});
            } else if (errorMsg.includes('Not yet connected')) {
              log('  ↷ Not yet connected — will retry after acceptance.');
              await updateSheetRow(sheetUrl, url, {
                status: normalizeSkipReason('Not yet connected'),
                accountUsed: pName,
                sender: pName,
                dateLastAction: now,
                auditAction: normalizeSkipReason('Not yet connected'),
              }, linkedinColumn).catch(() => {});
            } else if (errorMsg.includes('SEND_NOT_CONFIRMED')) {
              log(`  ⚠ Send clicked but Pending NOT confirmed for ${data.firstName || '?'}. LinkedIn may have silently dropped it.`);
              delete state.processed[url];
              await saveState(state);
              await updateSheetRow(sheetUrl, url, {
                status: normalizeSkipReason('Send not confirmed'),
                stage:  normalizeSkipReason('Send not confirmed'),
                accountUsed: pName,
                sender: pName,
                dateLastAction: now,
                auditAction: normalizeSkipReason('Send not confirmed'),
              }, linkedinColumn).catch(() => {});
            } else if (errorMsg.includes('LINKEDIN_ERROR_TOAST')) {
              log(`  ⚠ LinkedIn showed an error toast for ${data.firstName || '?'}.`);
              delete state.processed[url];
              await saveState(state);
              await updateSheetRow(sheetUrl, url, {
                status: normalizeSkipReason('LinkedIn error toast'),
                stage:  normalizeSkipReason('LinkedIn error toast'),
                accountUsed: pName,
                sender: pName,
                dateLastAction: now,
                auditAction: normalizeSkipReason('LinkedIn error toast'),
              }, linkedinColumn).catch(() => {});
            } else if (errorMsg.includes('NOT_OPEN_PROFILE')) {
              log('  ✗ Not an Open Profile — will skip in future runs.');
              state.processed[url] = { profileId, profileName: pName, action: 'not_open_profile', date: now };
              await saveState(state);
              await updateSheetRow(sheetUrl, url, {
                status: normalizeSkipReason('Not Open Profile'),
                stage:  normalizeSkipReason('Not Open Profile'),
                accountUsed: pName,
                sender: pName,
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
                status: normalizeSkipReason(errorMsg),
                stage:  normalizeSkipReason(errorMsg),
                accountUsed: pName,
                sender: pName,
                dateLastAction: now,
                auditAction: normalizeSkipReason(errorMsg),
              }, linkedinColumn).catch(() => {});
            } else {
              log('  ✗ Retry next run.');
              pushError(new Error(`${url}: ${errorMsg}`));
              delete state.processed[url];
              await saveState(state);
              await updateSheetRow(sheetUrl, url, {
                status: normalizeSkipReason(errorMsg),
                stage:  normalizeSkipReason(errorMsg),
                accountUsed: pName,
                sender: pName,
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
      while (!campaign._abort && !leadsExhausted) {
        // Adaptive RAM throttle: drop browser cap to 1 when throttle engages,
        // restore on release (Q1=(a) "drain to 1").
        const t = campaign._throttle;
        if (t?.active) browserSemaphore.setMax(1);
        else browserSemaphore.setMax(MAX_CONCURRENT_PROFILES);

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
  } catch (err) {
    log(`Fatal: ${err.message}`);
    pushError(err);
  } finally {
    // Save campaign history (D-10)
    try {
      await appendHistory({
        date: new Date().toISOString(),
        mode: campaign.mode,
        profiles: campaign.profileNames,
        dailyLimit: dailyLimit,
        totalProcessed: campaign.totalProcessed,
        successCount: campaign.processedToday,
        errorCount: campaign.errors.length,
        duration: Math.round((Date.now() - campaignStartTime) / 1000),
        templateNames: Object.entries(tpl).filter(([_, v]) => v && (typeof v === 'string' ? v : v.subject)).map(([k]) => k),
      });
    } catch (histErr) {
      console.error('Failed to save campaign history:', histErr.message);
    }
    campaign.running = false;
    campaign.currentProfile = null;
    log('=== Campaign ended ===');
    campaign.currentAction = null; // clear cockpit
  }
}

export function stopCampaign() {
  campaign._abort = true;
  // Wake any in-flight awaitUnpause() so the loop can exit cleanly.
  campaign._paused = false;
  campaign._pauseRequested = false;
  log('■ Stop requested.');
  // P-02 fix (2.8.18): return a real shape instead of undefined so
  // /api/campaign/stop sends `{ok:true}` like every other endpoint.
  return { ok: true };
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

async function awaitUnpause() {
  if (!campaign._pauseRequested && !campaign._paused) return;
  campaign._paused = true;
  setAction('Paused — awaiting resume');
  log('⏸ Campaign paused — browsers stay open. Press Resume to continue.');
  while (campaign._paused && !campaign._abort) {
    await new Promise(r => setTimeout(r, 1000));
  }
  if (!campaign._abort) log('▶ Campaign resumed.');
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
    currentAction: campaign.currentAction,
    currentProfile: campaign.currentProfile,
    processedToday: campaign.processedToday,
    totalProcessed: campaign.totalProcessed,
    totalTargets: campaign.totalTargets || 0,
    mode: campaign.mode || '',
    profileNames: campaign.profileNames || [],
    logs: campaign.logs.slice(-100),
    errors: campaign.errors.slice(-20),
    parked: campaign.parkedProfiles.slice(),
    softWarnings: campaign.softWarnings.slice(),
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
 * Test-only state setter. DO NOT call from production code.
 * Exposed so tests/status-payload.test.js can assert shape without
 * driving the full campaign loop.
 */
export function _setTestState(patch) {
  if (patch && typeof patch === 'object') {
    Object.assign(campaign, patch);
  }
}
