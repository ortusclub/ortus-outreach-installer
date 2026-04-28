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

import { existsSync, mkdirSync } from 'fs';
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
} from './resource-monitor.js';

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
 *  90s; env-overridable for stress-testing (LEAD_TIMEOUT_MS=2000 will time
 *  out almost every lead, useful for proving the path).
 */
const LEAD_TIMEOUT_MS = Number(process.env.LEAD_TIMEOUT_MS) || 90000;

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
 * Pure helper — between-batch wait in ms from batchesPerHour target spacing.
 * Applies a 60s floor. Exported for tests/batch-loop.test.js.
 */
export function computeBetweenBatchWaitMs({ batchesPerHour, batchDurationMs = 0 }) {
  const bph = Math.max(1, Math.min(6, Number(batchesPerHour) || 2));
  const targetMs = (3600 / bph) * 1000;
  return Math.max(MIN_BETWEEN_BATCHES_MS, targetMs - Math.max(0, batchDurationMs));
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
function checkHostHealth() {
  const warnings = [];
  const GB = 1024 * 1024 * 1024;
  const freeGB = os.freemem() / GB;
  const totalGB = os.totalmem() / GB;
  const load1 = os.loadavg()[0];
  const cpuCount = os.cpus().length;
  const loadThreshold = cpuCount * 0.8;

  if (freeGB < 2) {
    warnings.push(`Free RAM is ${freeGB.toFixed(1)}GB / ${totalGB.toFixed(1)}GB total — low.`);
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

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  campaign.logs.push(line);
  if (campaign.logs.length > 500) campaign.logs.shift();
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

export async function startCampaign({ profileIds, sheetUrl, templates, dailyLimit = 40, batchesPerHour = 2, mode = 'connect_only', messageOpenProfiles = false, delayMin = 15, delayMax = 45, linkedinColumn = '', senderFirstNames = {} }) {
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
  };

  const campaignStartTime = Date.now();

  try {
    log('=== Campaign starting ===');
    log(`Mode: ${mode}`);
    log(`Profiles: ${profileIds.length} selected`);
    log(`Daily limit: ${dailyLimit}`);
    // Phase 11.2: clamp batchesPerHour to 1..6 and log the target throughput.
    batchesPerHour = Math.max(1, Math.min(6, Number(batchesPerHour) || 2));
    log(`Batches per hour: ${batchesPerHour} (→ ~${batchesPerHour * 5} leads/hour/profile target)`);
    log(`Templates: note=${tpl.connectionNote ? '✓' : '—'} followUp=${tpl.followUpMessage ? '✓' : '—'} inmail=${tpl.inmail.subject ? '✓' : '—'}`);
    if (linkedinColumn) log(`LinkedIn column: "${linkedinColumn}"`);
    if (messageOpenProfiles) log('Open Profile messaging: ON');

    // Preflight: warn if the host is already under heavy load.
    // Non-blocking — operator decides whether to continue.
    const health = checkHostHealth();
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
    const targets = rows.filter(row => {
      const url = extractLinkedInUrl(row, linkedinColumn);
      if (!url) return false;

      const status    = (row['Status']  || row['status']  || '').toString().toLowerCase().trim();
      const cc        = (row['CC']      || row['cc']      || '').toString().toLowerCase().trim();
      const opCell    = (row['OP']      || row['op']      || '').toString().toLowerCase().trim();
      const msgCell   = (row['Message'] || row['message'] || '').toString().toLowerCase().trim();
      const inmailCell= (row['InMail']  || row['inmail']  || '').toString().toLowerCase().trim();
      const msgSent   = msgCell === 'sent' || opCell === 'sent';

      if (mode === 'check_status') {
        return cc === 'sent';
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

      if (mode === 'message_only' || mode === 'open_profile_only') {
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
    const hasGoLoginProfiles = profileIds.some(id => id !== 'local-browser');
    const token = hasGoLoginProfiles ? getToken() : null;
    for (const pid of profileIds) {
      if (pid === 'local-browser') {
        profileNameCache[pid] = 'Local Browser';
      } else {
        await getProfileName(pid, token);
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

      const pName = profileNameCache[profileId] || profileId;
      campaign.currentProfile = pName;

      try {
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

        // First-batch-only 20s home-page warmup (D-11). Abort-aware so we
        // don't sit through 20s of warmup after Stop has been pressed.
        log(`⏳ ${pName}: waiting 20s on home page…`);
        setAction('Warming up session', { account: pName, durationMs: 20000 });
        const warmEnd = Date.now() + 20000;
        while (Date.now() < warmEnd && !campaign._abort) {
          await new Promise(r => setTimeout(r, 1000));
        }
        if (campaign._abort) {
          try {
            if (profileId === 'local-browser') await closeLocalBrowser();
            else await closeProfile(profileId);
          } catch { /* */ }
          return null;
        }
        log(`✓ ${pName} warmup done.`);

        const session = { profileId, pName, browser: launched.browser, page, warmedUp: true };
        sessions.set(profileId, session);
        return session;
      } catch (err) {
        log(`✗ ${pName}: failed to open — ${err.message}`);
        pushError(err);
        return null;
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
        return { durationMs };
      } catch (e) {
        const durationMs = Date.now() - t0;
        log(`Close ${s.pName}: ${e.message} (⏱ ${durationMs}ms)`);
        sessions.delete(profileId);
        return { durationMs };
      }
    }

    let leadIndex = 0;
    let totalDone = 0;
    let totalVisited = 0;
    let leadsExhausted = false;
    const weeklyLimited = new Set(); // Profiles that hit weekly/credit limit
    // Phase 2.8.8: silent-failure guard — if a profile produces BATCH_SIZE
    // consecutive non-success outcomes, park it for the rest of the run.
    // Catches silent weekly-limit exhaustion and any other systemic per-account
    // failure pattern that our explicit detectors miss.
    const consecutiveSkips = new Map();

    log(`\n✓ Starting batch loop (BATCH_SIZE=${BATCH_SIZE})…\n`);

    outer: while (!campaign._abort && !leadsExhausted) {
      const activeProfiles = profileIds.filter(id =>
        getCampaignCount(id) < dailyLimit && !weeklyLimited.has(id)
      );
      if (activeProfiles.length === 0) {
        log('All profiles reached their campaign limit or weekly limit.');
        break;
      }

      // Round-robin: every profile does ONE batch, then we sleep once at the
      // end of the round. Per-profile rate is maintained by the round cadence
      // (batchesPerHour × BATCH_SIZE leads/profile/hour), not by sleeping
      // between individual profiles. With N profiles the total throughput is
      // N × batchesPerHour × BATCH_SIZE leads/hour.
      const roundStart = Date.now();

      for (const profileId of activeProfiles) {
        if (campaign._abort) break outer;
        if (leadsExhausted) break outer;

        const session = await ensureOpen(profileId);
        if (!session) continue; // opened-but-unhealthy OR launch failed; try next profile

        const { pName, browser } = session;
        let { page } = session;
        campaign.currentProfile = pName;

        const batchStart = Date.now();

        // ── Inner: up to BATCH_SIZE leads for this profile ──
        for (let leadInBatch = 0; leadInBatch < BATCH_SIZE && !campaign._abort; leadInBatch++) {
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

        // Find the next unprocessed lead
        let row = null;
        while (leadIndex < targets.length) {
          const candidate = targets[leadIndex];
          const candidateUrl = extractLinkedInUrl(candidate, linkedinColumn);
          leadIndex++;
          if (!candidateUrl) continue;
          if (mode !== 'check_status' && mode !== 'message_only' && mode !== 'open_profile_only' && state.processed[candidateUrl]) continue;
          const sheetStatus = (candidate['Status'] || candidate['status'] || '').toLowerCase();
          if (mode === 'connect_only') {
            if (sheetStatus) continue;
          }
          row = candidate;
          break;
        }

        if (!row) {
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
          if (cc !== 'sent') { delete state.processed[url]; continue; }
        } else {
          if (status === 'done') { delete state.processed[url]; continue; }
          if ((mode === 'open_profile_only' || mode === 'message_only') && msgSent) {
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
          log(`  ${result.action}${result.error ? ' — ' + result.error : ''}`);

          const now = new Date().toISOString();

          if (SUCCESS_ACTIONS.has(result.action)) {
            state.processed[url] = { profileId, profileName: pName, action: result.action, date: now };
            bumpCampaignCount(profileId);
            totalDone++;
            campaign.processedToday++;
            campaign.totalProcessed = campaign.processedToday;
            await saveState(state);

            const sheetData = { dateLastAction: now, accountUsed: pName };
            const hyperSent = `=HYPERLINK("${url}","sent")`;

            if (result.action === 'connection_sent') {
              sheetData.status = 'Done';
              // Phase 2.8.10: write the sender's account name into CC instead
              // of the generic "Sent" so the operator can see at a glance
              // which profile sent each connection request.
              sheetData.cc = pName;
              sheetData.auditAction = 'Connection sent';
            } else if (result.action === 'message_sent') {
              sheetData.status = 'Done';
              sheetData.message = hyperSent;
              sheetData.auditAction = 'Message sent';
            } else if (result.action === 'op_message_sent') {
              sheetData.status = 'Done';
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
            } else if (result.action === 'inmail_sent') {
              sheetData.status = 'Done';
              sheetData.inmail = hyperSent;
              sheetData.auditAction = 'InMail sent';
              if (typeof result.creditsLeft === 'number') {
                sheetData.auditNotes = `InMail credits left: ${result.creditsLeft}`;
                log(`  💳 InMail credits left: ${result.creditsLeft}`);
                if (result.creditsLeft <= 0) {
                  log(`  ⚠ ${pName} has 0 InMail credits — removing from InMail rotation.`);
                  weeklyLimited.add(profileId);
                }
              }
            } else if (result.action === 'status_accepted') {
              // Invite accepted — flip CC green, Status=Skipped so follow-up
              // campaigns (DM, OP, InMail) can process this row next.
              sheetData.status = 'Skipped';
              sheetData.cc = 'Accepted';
              sheetData.auditAction = 'Acceptance confirmed';
            } else if (result.action === 'status_pending') {
              // Still awaiting — keep CC yellow, mark Status=Skipped so
              // the next check_status run re-evaluates.
              sheetData.status = 'Skipped';
              sheetData.cc = 'Sent';
              sheetData.auditAction = 'Still pending';
            } else if (result.action === 'status_declined') {
              sheetData.status = 'Done';
              sheetData.cc = 'Declined';
              sheetData.auditAction = 'Declined';
            }
            await updateSheetRow(sheetUrl, url, sheetData, linkedinColumn).catch(() => {});

            log(`  ✓ [${pName}] (${getCampaignCount(profileId)}/${dailyLimit})`);
            consecutiveSkips.set(profileId, 0);
          } else {
            const skipCount = (consecutiveSkips.get(profileId) || 0) + 1;
            consecutiveSkips.set(profileId, skipCount);
            if (skipCount >= BATCH_SIZE && !weeklyLimited.has(profileId)) {
              log(`  ⚠ ${pName}: ${BATCH_SIZE} consecutive non-success outcomes — parking account for rest of run.`);
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
                status: 'Skipped',
                accountUsed: pName,
                dateLastAction: now,
                auditAction: 'Weekly invitation limit reached',
              }, linkedinColumn).catch(() => {});
            } else if (errorMsg.includes('INMAIL_NO_CREDITS')) {
              log(`  ⚠ InMail credits exhausted for ${pName}. Removing from rotation.`);
              weeklyLimited.add(profileId);
              await updateSheetRow(sheetUrl, url, {
                status: 'Skipped',
                accountUsed: pName,
                dateLastAction: now,
                auditAction: 'InMail credits exhausted',
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
                status: 'Done',
                cc: 'Unreachable',
                accountUsed: pName,
                dateLastAction: now,
                auditAction: 'Email required to connect',
              }, linkedinColumn).catch(() => {});
            } else if (errorMsg.includes('Not yet connected')) {
              log('  ↷ Not yet connected — will retry after acceptance.');
              await updateSheetRow(sheetUrl, url, {
                status: 'Skipped',
                accountUsed: pName,
                dateLastAction: now,
                auditAction: 'Not yet connected',
              }, linkedinColumn).catch(() => {});
            } else if (errorMsg.includes('SEND_NOT_CONFIRMED')) {
              log(`  ⚠ Send clicked but Pending NOT confirmed for ${data.firstName || '?'}. LinkedIn may have silently dropped it.`);
              delete state.processed[url];
              await saveState(state);
              await updateSheetRow(sheetUrl, url, {
                status: 'Skipped',
                accountUsed: pName,
                dateLastAction: now,
                auditAction: 'Send not confirmed',
              }, linkedinColumn).catch(() => {});
            } else if (errorMsg.includes('LINKEDIN_ERROR_TOAST')) {
              log(`  ⚠ LinkedIn showed an error toast for ${data.firstName || '?'}.`);
              delete state.processed[url];
              await saveState(state);
              await updateSheetRow(sheetUrl, url, {
                status: 'Skipped',
                accountUsed: pName,
                dateLastAction: now,
                auditAction: 'LinkedIn error toast',
              }, linkedinColumn).catch(() => {});
            } else if (errorMsg.includes('NOT_OPEN_PROFILE')) {
              log('  ✗ Not an Open Profile — will skip in future runs.');
              state.processed[url] = { profileId, profileName: pName, action: 'not_open_profile', date: now };
              await saveState(state);
              await updateSheetRow(sheetUrl, url, {
                status: 'Done',
                accountUsed: pName,
                dateLastAction: now,
                auditAction: 'Not Open Profile',
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
                status: 'Skipped',
                accountUsed: pName,
                dateLastAction: now,
                auditAction: errorMsg,
              }, linkedinColumn).catch(() => {});
            } else {
              log('  ✗ Retry next run.');
              pushError(new Error(`${url}: ${errorMsg}`));
              delete state.processed[url];
              await saveState(state);
              await updateSheetRow(sheetUrl, url, {
                status: 'Skipped',
                accountUsed: pName,
                dateLastAction: now,
                auditAction: errorMsg,
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
            const isMessageMode = mode === 'message_only';
            const delayMultiplier = computeDelayMultiplier({
              mode,
              profileCount: profileIds.length,
              throttleActive:     campaign._throttle?.active     ?? false,
              throttleMultiplier: campaign._throttle?.multiplier ?? 1,
            });

            let waitMs;
            if (isMessageMode) {
              // User-controlled gap from the dashboard (delayMin–delayMax seconds).
              waitMs = Math.floor(Math.random() * (delayMax - delayMin + 1) + delayMin) * 1000;
              log(`  ⏳ ${(waitMs / 1000).toFixed(0)}s (message gap)`);
            } else {
              waitMs = Math.floor(Math.random() * (delayMax - delayMin + 1) + delayMin) * 1000;
              waitMs = Math.floor(waitMs * delayMultiplier);
              if (delayMultiplier > 1) {
                const parts = [];
                if (!isMessageMode && profileIds.length === 1) parts.push('single-account 2x');
                if (campaign._throttle?.active) parts.push(`throttled ${campaign._throttle.multiplier}x`);
                log(`  ⏳ ${(waitMs / 1000).toFixed(0)}s (${parts.join(' + ')})`);
              } else {
                log(`  ⏳ ${(waitMs / 1000).toFixed(0)}s`);
              }
            }

            // ~30% chance: browse the feed organically during the wait (looks like a real user).
            // Skip entirely in message mode — we want this to move fast.
            if (!isMessageMode && Math.random() < 0.3 && !campaign._abort) {
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

        // ── Between-batch decision (D-03, D-12, D-13) ──
        if (campaign._abort || leadsExhausted) break outer;

        const batchDurationMs = Date.now() - batchStart;
        // Per-profile close-vs-park decision — cheaper to close if we won't
        // be back to this profile for a while. The round sleep below keeps
        // the global cadence; this only decides whether the profile sits idle
        // on about:blank or gets closed entirely between rounds.
        const perProfileWaitMs = computeBetweenBatchWaitMs({ batchesPerHour, batchDurationMs });
        if (shouldCloseBetweenBatches({ waitMs: perProfileWaitMs })) {
          log(`  ⊗ ${pName}: gap ${(perProfileWaitMs / 60000).toFixed(1)}min > ${getCloseGapMin()}min — closing browser.`);
          await closeSession(profileId);
        } else {
          if (rmCfg.IDLE_PARKING_ENABLED && !page.isClosed?.()) {
            await parkProfile(page, rmCfg.PARK_PAGE);
          }
          log(`  ⏸ ${pName}: parked until next round.`);
        }

        // No per-profile sleep — move to the next profile immediately so all
        // N profiles do one batch each in the current round.
      }  // end for-each profile in activeProfiles

      // ── End-of-round sleep (D-03) ──
      // Sleep until the round cadence target has elapsed. batchesPerHour sets
      // the target — e.g. bph=2 means rounds should start every 30min. If the
      // round took longer than the target, no sleep.
      if (campaign._abort || leadsExhausted) break outer;
      const roundTargetMs = (3600 / batchesPerHour) * 1000;
      const roundElapsed = Date.now() - roundStart;
      const roundSleepMs = Math.max(0, roundTargetMs - roundElapsed);
      if (roundSleepMs > 0) {
        log(`  ⏸ Round complete — sleeping ${(roundSleepMs / 60000).toFixed(1)}min until next round.`);
        setAction('Round complete — next round in', { durationMs: roundSleepMs });
        const gapEnd = Date.now() + roundSleepMs;
        while (Date.now() < gapEnd && !campaign._abort) {
          await new Promise(r => setTimeout(r, 2000));
        }
      } else {
        log(`  ↻ Round took ${(roundElapsed / 60000).toFixed(1)}min (≥ ${(roundTargetMs / 60000).toFixed(0)}min target) — starting next round immediately.`);
      }
    }  // end outer:while

    // Log per-profile stats (from the sessions Map — covers both still-open
    // and already-closed profiles via campaignCounts).
    for (const profileId of profileIds) {
      const pName = profileNameCache[profileId] || profileId;
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
        batchesPerHour: batchesPerHour,  // Phase 11.2 (D-06)
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
