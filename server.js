import 'dotenv/config';

// ── Startup env validation (D-06) ──────────────────────────────────
// v2.52.0: SHEETS_WEBAPP_URL removed from REQUIRED_ENV. The URL is now
// hard-coded in src/sheets-webapp-url.js and the .env value is ignored.
const REQUIRED_ENV = ['GOLOGIN_API_TOKEN'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`\n  FATAL: Missing required environment variables:\n${missing.map(k => '    - ' + k).join('\n')}\n\n  Copy .env.example to .env and fill in all values.\n`);
  process.exit(1);
}

import express from 'express';
import cookieParser from 'cookie-parser';
import cron from 'node-cron';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { appendFileSync, createWriteStream, existsSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { startCampaign, stopCampaign, pauseCampaign, resumeCampaign, preemptCurrentLead, restoreCampaign, getCampaignStatus, getLastRunSettings, setCampaignName, retryParkedProfile, campaign, extractLinkedInUrl, log as campaignLog, startMonitoringWatcher, stopMonitoringWatcher, stopMonitoring, resumeMonitoringFromDisk, setBulkCheckInProgress, addActiveBulkCheck, removeActiveBulkCheck, forceCloseActiveBulkChecks, setProfileSkip, setLiveTemplates, setLiveDailyLimit, setLiveCadence, confirmLogin } from './src/campaign.js';
import { getQueue, addToQueue, removeFromQueue, moveInQueue, reorderQueue, updateQueueEntry, popNext as popNextQueued } from './src/campaign-queue.js';
// Sales Nav Scrape — control-panel client to the GKE scraper engine. The app
// dispatches scrape jobs here; it never launches a scraper browser locally.
import { isScraperConfigured, getEngineUrl as getScrapeEngineUrl, startScrape, pauseScrape, resumeScrape, stopScrape, getJobs as getScrapeJobs, getLogs as getScrapeLogs, extractSalesNavUrls, extractSalesNavUrlsWithRows, openJobViewStream as openScrapeJobViewStream } from './src/scraper-client.js';
import { relaunchHistoryEntry, archiveHistoryEntry, listHistory, readCampaignLog } from './src/history-helpers.js';
import { getDrafts, getDraft, addDraft, updateDraft, removeDraft } from './src/drafts.js';
import { startScheduler as startPostCampaignScheduler, listSchedule as listPostCampaignSchedule, removeSchedulesForSheet as removeBulkSchedules } from './src/post-campaign-bulk-check.js';
import { startScheduler as startReplyCheckScheduler, listSchedule as listReplyCheckSchedule, removeSchedulesForSheet as removeReplySchedules, registerReplySchedule } from './src/post-campaign-reply-check.js';
import { startPrimaryTaskRunner } from './src/primary-task-runner.js';
import { listReplies, unseenCount as unseenReplyCount, markAllSeen as markRepliesSeen } from './src/replies-log.js';
import { startAmbientSampling } from './src/resource-monitor.js';
import { personalizeTemplate } from './src/linkedin/helpers.js';
import { checkProfileDms, checkProfileDmsPerLead } from './src/linkedin/check-dms.js';
import { runAmplification as runPostAmplification } from './src/linkedin/post-amplification.js';
import { fetchSheet, fetchSheetWithRows } from './src/sheets.js';
import { INTRO_FAILED_PRIMARY_NOT_CONNECTED, INTRO_RETRY_RECONNECT } from './src/linkedin/intro-constants.js';
import { getProfiles, closeAllProfiles, getActiveBrowserPids, getProfilePid, launchProfile } from './src/gologin-launcher.js';
import { closeLocalBrowser } from './src/local-launcher.js';
import { clampCadenceMinutes } from './public/js/campaign-modes.mjs';
import { validatePrimaryUrl } from './public/js/primary-url-validation.mjs';
import { unhideByPids } from './src/mac-window.js';
import { preventSleep, allowSleep } from './src/caffeinate.js';
import { initNotifier, notifyAll, notifyEmail, getRecentNotifications } from './src/notifier.js';
import { flushOpsLog, _setAlertImpl } from './src/log-writer.js';

// Surface a repeated Operations Log write failure instead of letting it die
// silently (the 2026-06-10 → 06-11 blackout). Routed to the fatal-error log
// the app already displays; no external auto-send.
_setAlertImpl((msg) => {
  console.error(`[log-writer][ALERT] ${msg}`);
  try { appendFatalErrorSync({ at: new Date().toISOString(), source: 'log-writer', message: msg }); } catch (_) { /* */ }
});
import { getPrefs as getNotificationPrefs, setPrefs as setNotificationPrefs } from './src/notification-prefs.js';
import { getPrefs as getOperatorPrefs, setPrefs as setOperatorPrefs } from './src/operator-prefs.js';
import { getOperatorEmail, setOperatorEmail, isPlausibleEmail } from './src/operator-identity.js';
import { fetchSoOData } from './src/soo.js';
import { dataPath } from './src/paths.js';
import { checkDiskFree } from './src/disk-check.js';
import { LATEST_RELEASE_API, parseVersion, isBehind, archLabel, dmgAssetName, latestDownloadUrl, latestReleaseUrl } from './src/updater.js';
import {
  createUser, verifyCredentials, userExists,
  issueSessionCookie, clearSessionCookie, readSessionFromRequest,
  isEmailAllowed, deleteUser,
} from './src/auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

const pkg = JSON.parse(await readFile(resolve(__dirname, 'package.json'), 'utf8'));
const APP_VERSION = pkg.version;

app.use(express.json());
app.use(cookieParser());

// ── Public auth endpoints (no session required) ────────────────────
const PUBLIC_PATHS = new Set([
  '/login.html', '/signup.html', '/electron-login.html',
  '/api/auth/login', '/api/auth/signup', '/api/auth/logout', '/api/auth/electron-login',
  '/api/auth/reset',
  '/api/health',
  // help.html is a static onboarding manual with zero sensitive content —
  // safe to expose without auth so Electron's target="_blank" link works
  // from any browser (the link opens in the system browser, which lacks
  // the Electron session cookie and would otherwise bounce through login).
  '/help.html',
]);

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const verified = await verifyCredentials(email, password);
    if (!verified) return res.status(401).json({ error: 'Invalid email or password' });
    await issueSessionCookie(res, verified);
    res.json({ ok: true, email: verified });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/signup', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const normalized = (email || '').trim().toLowerCase();
    if (!normalized || !password) return res.status(400).json({ error: 'Email and password required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (await userExists(normalized)) return res.status(409).json({ error: 'An account already exists for this email' });

    let allowed;
    try {
      allowed = await isEmailAllowed(normalized);
    } catch (err) {
      return res.status(503).json({ error: `Could not verify email: ${err.message}` });
    }
    if (!allowed) return res.status(403).json({ error: 'This email isn\'t authorized — operators must use an @ortusclub.com or @ortus.solutions email.' });

    await createUser(normalized, password);
    await issueSessionCookie(res, normalized);
    res.json({ ok: true, email: normalized });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// v2.57.x — Forgot-password reset. Wipes the user's password record so
// they can re-sign-up with a new one. Campaigns, sheets, presets, and
// notification prefs are NOT touched — they live in separate files keyed
// by email and survive the wipe. Email must still pass isEmailAllowed,
// so this can't be abused to wipe arbitrary accounts.
app.post('/api/auth/reset', async (req, res) => {
  try {
    const { email } = req.body || {};
    const normalized = (email || '').trim().toLowerCase();
    if (!normalized.includes('@')) return res.status(400).json({ error: 'Enter a valid email' });

    let allowed;
    try {
      allowed = await isEmailAllowed(normalized);
    } catch (err) {
      return res.status(503).json({ error: `Could not verify email: ${err.message}` });
    }
    if (!allowed) return res.status(403).json({ error: 'This email isn\'t authorized — operators must use an @ortusclub.com or @ortus.solutions email.' });

    await deleteUser(normalized);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/logout', (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

// Electron-only frictionless login — email-only, no password. Verified against
// the SoO allowlist. Disabled outside Electron to keep the web/dev flow as-is.
app.post('/api/auth/electron-login', async (req, res) => {
  try {
    if (process.env.ORTUS_ELECTRON_MODE !== '1') {
      return res.status(404).json({ error: 'Not available outside Electron' });
    }
    const { email } = req.body || {};
    const normalized = (email || '').trim().toLowerCase();
    if (!normalized.includes('@')) return res.status(400).json({ error: 'Enter a valid email' });

    let allowed;
    try {
      allowed = await isEmailAllowed(normalized);
    } catch (err) {
      return res.status(503).json({ error: `Could not verify email: ${err.message}` });
    }
    if (!allowed) return res.status(403).json({ error: 'This email isn\'t authorized — operators must use an @ortusclub.com or @ortus.solutions email.' });

    if (!(await userExists(normalized))) {
      // Auto-create with a random unguessable password — never used (no
      // password login path exists in Electron mode), just satisfies the
      // existing user-store schema so /api/me etc. continue to work.
      const placeholder = (await import('node:crypto')).randomBytes(32).toString('hex');
      await createUser(normalized, placeholder);
    }
    await issueSessionCookie(res, normalized);
    res.json({ ok: true, email: normalized });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve login/signup assets + their CSS/JS/fonts before the auth gate so
// unauthenticated browsers can actually render the login page. The app.js
// and style.css are public by nature (client code) — no secrets there.
const PUBLIC_PREFIXES = ['/css/', '/js/', '/fonts/', '/images/'];
app.get('/login.html', (_req, res) => res.sendFile(resolve(__dirname, 'public', 'login.html')));
app.get('/signup.html', (_req, res) => res.sendFile(resolve(__dirname, 'public', 'signup.html')));
app.get('/electron-login.html', (_req, res) => res.sendFile(resolve(__dirname, 'public', 'electron-login.html')));
app.use((req, res, next) => {
  if (PUBLIC_PREFIXES.some(p => req.path.startsWith(p))) {
    return express.static(resolve(__dirname, 'public'))(req, res, next);
  }
  next();
});

// ── Session gate ───────────────────────────────────────────────────
app.use(async (req, res, next) => {
  if (PUBLIC_PATHS.has(req.path)) return next();
  if (req.path.startsWith('/sketches/') || req.path === '/sketches.html') return next();
  const email = await readSessionFromRequest(req);
  if (!email) {
    // API calls get 401 JSON; page navigations get redirected to the right login page.
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
    const loginPage = process.env.ORTUS_ELECTRON_MODE === '1' ? '/electron-login.html' : '/login.html';
    return res.redirect(loginPage);
  }
  req.user = email;
  next();
});

// Who-am-I endpoint used by the dashboard to show the logged-in user
app.get('/api/me', (req, res) => {
  res.json({ email: req.user });
});

app.use(express.static(resolve(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Server log capture (ring buffer for dashboard)
// ---------------------------------------------------------------------------
const serverLogs = [];
const MAX_SERVER_LOGS = 500;
const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;

function captureLog(level, args) {
  const line = `[${new Date().toISOString()}] [${level}] ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}`;
  serverLogs.push(line);
  if (serverLogs.length > MAX_SERVER_LOGS) serverLogs.shift();
}

console.log = (...args) => { captureLog('LOG', args); origLog.apply(console, args); };
console.warn = (...args) => { captureLog('WARN', args); origWarn.apply(console, args); };
console.error = (...args) => { captureLog('ERR', args); origError.apply(console, args); };

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
app.get('/api/health', (_req, res) => {
  // scraperConfigured lets the dashboard gate the "Sales Nav Scrape" mode —
  // it's enabled only when SCRAPER_ENGINE_URL points at a GKE engine.
  res.json({ ok: true, time: new Date().toISOString(), version: APP_VERSION, scraperConfigured: isScraperConfigured(), scraperEngineUrl: getScrapeEngineUrl() });
});

// ---------------------------------------------------------------------------
// In-app updater — check GitHub Releases, download + open the matching DMG.
// Unsigned builds can't silently self-update, so "update" = fetch the newest
// DMG and open it for the operator to drag into /Applications.
// ---------------------------------------------------------------------------
let _updateCheckCache = null; // { ts, payload }
const UPDATE_CHECK_TTL_MS = 5 * 60 * 1000;

app.get('/api/update-check', async (req, res) => {
  // Serve a recent cached result to avoid hammering GitHub's unauthenticated
  // 60-req/hr limit when the UI re-checks on every dashboard load / 30-min
  // poll. ?force=1 (the manual "Check for updates" button) bypasses the cache
  // so the operator gets an up-to-the-second answer.
  const force = req.query.force === '1' || req.query.force === 'true';
  if (!force && _updateCheckCache && Date.now() - _updateCheckCache.ts < UPDATE_CHECK_TTL_MS) {
    return res.json(_updateCheckCache.payload);
  }
  const arch = archLabel(process.arch);
  try {
    const resp = await fetch(LATEST_RELEASE_API, {
      headers: { 'User-Agent': 'ortus-outreach-app', Accept: 'application/vnd.github+json' },
    });
    if (!resp.ok) throw new Error(`GitHub API ${resp.status}`);
    const rel = await resp.json();
    const latest = parseVersion(rel.tag_name);
    const payload = {
      ok: true,
      current: APP_VERSION,
      latest,
      behind: isBehind(APP_VERSION, latest),
      arch,
      asset: dmgAssetName(arch),
      downloadUrl: latestDownloadUrl(arch),
      releaseUrl: latestReleaseUrl(),
    };
    _updateCheckCache = { ts: Date.now(), payload };
    res.json(payload);
  } catch (err) {
    // Network/API failure → tell the UI we couldn't check; it just hides the
    // pill rather than showing a false "up to date".
    res.json({ ok: false, current: APP_VERSION, arch, error: err.message });
  }
});

// Live download state so the UI can show a progress bar under the button.
// The DMG is ~108 MB; a full download takes a while on slow connections and
// the operator otherwise can't tell how long it'll take. The POST kicks the
// download off and returns immediately; the UI polls GET /api/update-progress.
let _downloadState = { active: false, received: 0, total: 0, done: false, error: null, path: null };

app.post('/api/update-download', (_req, res) => {
  if (_downloadState.active) return res.json({ ok: true, alreadyRunning: true });
  const arch = archLabel(process.arch);
  const asset = dmgAssetName(arch);
  const url = latestDownloadUrl(arch);
  // Prefer ~/Downloads so the operator can find the DMG; fall back to a temp dir.
  const downloads = join(homedir(), 'Downloads');
  const destDir = existsSync(downloads) ? downloads : tmpdir();
  const dest = join(destDir, asset);
  _downloadState = { active: true, received: 0, total: 0, done: false, error: null, path: dest };

  // Run the download in the background, streaming chunk counts into
  // _downloadState. Not awaited — the response returns right away.
  (async () => {
    try {
      const resp = await fetch(url, { headers: { 'User-Agent': 'ortus-outreach-app' } });
      if (!resp.ok || !resp.body) throw new Error(`download failed: HTTP ${resp.status}`);
      _downloadState.total = Number(resp.headers.get('content-length')) || 0;
      const nodeStream = Readable.fromWeb(resp.body);
      nodeStream.on('data', (chunk) => { _downloadState.received += chunk.length; });
      await pipeline(nodeStream, createWriteStream(dest));
      _downloadState.done = true;
      // NB: the DMG is NOT opened here anymore. The client calls
      // /api/update-install next, which either auto-swaps + relaunches
      // (packaged) or opens the DMG for a manual drag (dev/fallback).
    } catch (err) {
      _downloadState.error = err.message;
    } finally {
      _downloadState.active = false;
    }
  })();

  res.json({ ok: true, started: true });
});

app.get('/api/update-progress', (_req, res) => res.json(_downloadState));

// v2.77: one-click auto-install. After the DMG has downloaded, swap the new
// build into /Applications and relaunch — no manual quit/drag. Works on the
// unsigned build because we strip the quarantine flag exactly like
// install-mac.sh does, so Gatekeeper doesn't block. Only runs when the app is
// launched from a packaged .app bundle; otherwise the caller falls back to
// opening the DMG.
function _packagedAppBundlePath() {
  // process.execPath in a packaged build:
  //   /Applications/The Ortus Outreach.app/Contents/MacOS/The Ortus Outreach
  const m = String(process.execPath || '').match(/^(.*\.app)\/Contents\/MacOS\//);
  if (!m) return null;
  // In dev (`electron .`) execPath points at node_modules/.../Electron.app —
  // never swap that. Only the real installed bundle qualifies.
  if (!m[1].endsWith('/The Ortus Outreach.app')) return null;
  return m[1];
}

app.post('/api/update-install', (_req, res) => {
  const appBundle = _packagedAppBundlePath();
  const dmg = _downloadState.path;
  // Not packaged (dev) or no downloaded DMG → open the DMG for a manual
  // drag-install and tell the UI to show the drag hint.
  if (process.platform !== 'darwin' || !appBundle || !dmg || !existsSync(dmg)) {
    if (process.platform === 'darwin' && dmg && existsSync(dmg)) {
      spawn('open', [dmg], { detached: true, stdio: 'ignore' }).unref();
    }
    return res.json({ ok: true, fallback: true });
  }

  // A detached helper survives this app quitting: it waits for the process to
  // exit, swaps the bundle (with a backup for rollback), strips quarantine,
  // and relaunches. Keeps the DMG so the curl installer is always a fallback.
  const logPath = join(tmpdir(), 'ortus-update.log');
  const scriptPath = join(tmpdir(), 'ortus-update.sh');
  const script = `#!/bin/bash
DMG="$1"; APP="$2"; LOG="$3"
exec >"$LOG" 2>&1
echo "[updater] waiting for app to quit…"
for i in $(seq 1 120); do
  pgrep -f "$APP/Contents/MacOS/" >/dev/null || break
  sleep 0.5
done
sleep 1
MNT="$(mktemp -d /tmp/ortus-mnt.XXXXXX)"
if ! hdiutil attach "$DMG" -nobrowse -noautoopen -mountpoint "$MNT" >/dev/null 2>&1; then
  echo "[updater] mount failed — opening DMG for manual install"; open "$DMG"; exit 1
fi
# Pick the REAL app by explicit name — the DMG also contains
# "Ortus Outreach Setup.app", which sorts BEFORE "The Ortus Outreach.app".
# The old "ls *.app | head -1" grabbed that helper and clobbered the real app,
# so the update installed the Setup helper instead (install-mac.sh always
# copied by explicit name, which is why the terminal installer was immune).
SRC="$MNT/The Ortus Outreach.app"
if [ ! -d "$SRC" ]; then
  SRC="$(/bin/ls -d "$MNT/"*.app 2>/dev/null | grep -vi 'Setup' | head -1)"
fi
if [ -z "$SRC" ] || [ ! -d "$SRC" ]; then
  SRC="$(/bin/ls -d "$MNT/"*.app 2>/dev/null | head -1)"
fi
if [ -z "$SRC" ]; then
  echo "[updater] no .app in DMG"; hdiutil detach "$MNT" >/dev/null 2>&1; open "$DMG"; exit 1
fi
PARENT="$(dirname "$APP")"
STAGE="$PARENT/.ortus-update-stage.app"
BK="$PARENT/.ortus-update-backup.app"
rm -rf "$STAGE" "$BK"
echo "[updater] staging copy…"
if ! cp -R "$SRC" "$STAGE"; then
  echo "[updater] copy failed — opening DMG for manual install"
  rm -rf "$STAGE"; hdiutil detach "$MNT" >/dev/null 2>&1; open "$DMG"; exit 1
fi
hdiutil detach "$MNT" >/dev/null 2>&1
echo "[updater] swapping bundle…"
mv "$APP" "$BK" && mv "$STAGE" "$APP"
if [ ! -d "$APP" ]; then
  echo "[updater] swap failed — restoring backup"
  [ -d "$BK" ] && mv "$BK" "$APP"
  open "$DMG"; exit 1
fi
rm -rf "$BK"
xattr -dr com.apple.quarantine "$APP" 2>/dev/null
echo "[updater] relaunching"
open "$APP"
`;
  try {
    writeFileSync(scriptPath, script, 'utf8');
    chmodSync(scriptPath, 0o755);
    spawn('bash', [scriptPath, dmg, appBundle, logPath], { detached: true, stdio: 'ignore' }).unref();
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }

  // Respond first, then quit so the helper can swap + relaunch. Quitting needs
  // app.isQuitting=true to bypass the tray "hide on close" behavior.
  res.json({ ok: true, relaunching: true });
  if (process.versions && process.versions.electron) {
    import('electron')
      .then(({ app }) => { app.isQuitting = true; setTimeout(() => app.quit(), 400); })
      .catch(() => {});
  }
});

app.get('/api/server-log', (_req, res) => {
  res.json(serverLogs.slice(-200));
});

app.delete('/api/server-log', (_req, res) => {
  serverLogs.length = 0;
  res.json({ cleared: true });
});

// ---------------------------------------------------------------------------
// GoLogin profiles
// ---------------------------------------------------------------------------
app.get('/api/profiles', async (_req, res) => {
  try {
    const profiles = await getProfiles(process.env.GOLOGIN_API_TOKEN);
    res.json(profiles);
  } catch (err) {
    console.error('Error fetching profiles:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// SoO (State of Operations) — account status from internal sheet
// ---------------------------------------------------------------------------
// Admin-email debouncing: send one email per failure streak. Reset on success.
let sooFailureNotified = false;

async function emailAdminsOnSoOFailure(err) {
  if (sooFailureNotified) return;
  sooFailureNotified = true;
  const recipients = (process.env.ADMIN_EMAILS || 'antonio@ortusclub.com')
    .split(',').map(s => s.trim()).filter(Boolean);
  await Promise.all(recipients.map(to => notifyEmail(to, {
    title: 'SoO status unavailable',
    body:
      `The State of Operations endpoint is failing.\n\n` +
      `Error code: ${err.code}\nMessage: ${err.message}\n\n` +
      `GDs will see a "SoO unavailable — click refresh to try again" pill\n` +
      `in the right pane until this is fixed. No further emails will be sent\n` +
      `for this failure streak; a new email will only fire after a successful\n` +
      `fetch is observed in between.`,
    link: '/',
  }).catch(() => {})));
}

app.get('/api/soo-status', async (_req, res) => {
  try {
    const data = await fetchSoOData();
    sooFailureNotified = false; // reset on success
    res.json(data);
  } catch (err) {
    console.error(`SoO fetch error [${err.code}]:`, err.message);
    emailAdminsOnSoOFailure(err).catch(() => {});
    res.status(503).json({ error: err.message, errorCode: err.code });
  }
});

// ---------------------------------------------------------------------------
// Google Sheet preview
// ---------------------------------------------------------------------------
app.get('/api/sheet/preview', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'url query param required' });

    const rows = await fetchSheet(url);
    res.json({
      totalRows: rows.length,
      columns: rows.length > 0 ? Object.keys(rows[0]) : [],
      preview: rows.slice(0, 5),
    });
  } catch (err) {
    console.error('Sheet preview error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 2.8.29: Check Status preview. Reads the sheet, counts rows where Account
// Used (column D) is filled — that's the signal an invite went out. CC text
// is no longer the source of truth. Cross-references the senders with
// available GoLogin profile names and returns per-account coverage.
app.get('/api/check-status/preview', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'url query param required' });

    const [rows, profiles] = await Promise.all([
      fetchSheet(url),
      (async () => {
        try {
          const { getProfiles } = await import('./src/gologin-launcher.js');
          const token = process.env.GOLOGIN_API_TOKEN;
          if (!token) return [];
          return await getProfiles(token);
        } catch { return []; }
      })(),
    ]);

    const knownNames = new Set(profiles.map(p => p.name));
    // 2.8.29: local-browser variants are valid pseudo-profiles.
    const LOCAL_BROWSER_NAMES = new Set(['Local Browser', 'local-browser', 'local-browser - manual']);

    // 2.8.32: same endpoint serves both check_status (Account Used filled)
    // and message_only (CC ends with " Y") via ?mode= query param.
    const mode = (req.query.mode || 'check_status').toString();

    const byAccount = {};
    const unmatched = {};
    let totalPending = 0;
    for (const row of rows) {
      // v2.11.11: Sender is canonical; Account Used is legacy.
      const acct = (row['Sender'] || row['sender'] || row['Account Used'] || row['account used'] || '').toString().trim();
      if (!acct) continue;
      if (mode === 'message_only') {
        // Filter: CC ends with " Y" (Voyager-confirmed acceptance from a
        // prior Check Status run). Sender drives routing.
        const ccRaw = (row['CC'] || row['cc'] || '').toString();
        if (!/\sY\s*$/.test(ccRaw)) continue;
      }
      totalPending++;
      if (LOCAL_BROWSER_NAMES.has(acct)) {
        byAccount['Local Browser'] = (byAccount['Local Browser'] || 0) + 1;
      } else if (knownNames.has(acct)) {
        byAccount[acct] = (byAccount[acct] || 0) + 1;
      } else {
        unmatched[acct] = (unmatched[acct] || 0) + 1;
      }
    }

    // Rough runtime estimate: ~25s per lead with the 2.8.29 fast-path
    // (domcontentloaded nav + Voyager API, no DOM settle for degree-1 hits).
    const runtimeSeconds = totalPending * 25;

    res.json({
      totalPending,
      byAccount: Object.entries(byAccount).map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count),
      unmatched: Object.entries(unmatched).map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count),
      accountsCount: Object.keys(byAccount).length,
      runtimeSeconds,
    });
  } catch (err) {
    console.error('Check status preview error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Template preview — render current templates against the first 3 leads so
// the operator can spot missing variables / over-limit messages before launch.
// Same body shape as /api/campaign/start so the client can reuse its form-
// state gatherer. Errors are returned as 200 + { previews: [], error } so the
// UI can always render a readable message.
// ---------------------------------------------------------------------------
app.post('/api/templates/preview', async (req, res) => {
  try {
    const {
      sheetUrl,
      linkedinColumn = '',
      templates = {},
      profileIds = [],
      senderFirstNames = {},
      // v2.59.x — IC + message_only resolve {senderFirstName} per-row from
      // the sheet's sender column (the real send path does this). Without
      // mode + senderColumn the preview falls back to the operator's
      // locally-selected profile, which is the wrong identity for these
      // modes (each row can have a different sender).
      mode = '',
      senderColumn = '',
    } = req.body || {};

    if (!sheetUrl) return res.status(400).json({ error: 'sheetUrl required' });

    // Mirror campaign.js:280-289 template normalization so legacy aliases work.
    // v2.11.14: introTitle joins as a 7th preview field so operators can
    // sanity-check the LinkedIn group thread title before launching an IC run.
    const tpl = {
      connectionNote: templates.connectionNote || templates.note || '',
      followUpMessage: templates.followUpMessage || templates.followUp1 || '',
      inmailSubject: templates.inmail?.subject || templates.inmailSubject || '',
      inmailBody: templates.inmail?.message || templates.inmailBody || '',
      opProfileSubject: templates.openProfileSubject || templates.opSubject || '',
      opProfileBody: templates.openProfileBody || templates.opBody || '',
      introTitle: templates.introTitle || '',
      // v2.59.x — Render the Intro DM Body as its own preview field so IC
      // and CC+IC operators can see what they typed. Send-path routing
      // differs by mode (IC via followUpMessage, CC+IC via runAutoIntros'
      // primaryIntroBody) but the preview just needs to show the text.
      primaryIntroBody: templates.primaryIntroBody || '',
      // v2.62 — CC+DM (connect_and_message) phase-2 body. Plain 1:1 DM
      // after acceptance, no primary person.
      ccDmBody: templates.ccDmBody || '',
    };

    // v2.11.14: extract intro-mode signals so the preview can mirror the
    // runtime substitution in outreach.js (introData construction).
    const introMode = !!templates.introMode;
    const introName = (templates.introName || '').toString().trim();
    const introTokens = introName.split(/\s+/);
    const introFirst = introMode ? (introTokens[0] || '') : '';
    const introLast  = introMode ? (introTokens.slice(1).join(' ')) : '';

    const anyFilled = Object.values(tpl).some(v => v && v.trim());
    if (!anyFilled) {
      return res.status(400).json({ error: 'At least one template field must be provided' });
    }

    // Fetch the sheet — if this fails we return 200 + error so the UI can
    // show it without parsing error codes (mirrors the general pattern).
    let rows;
    try {
      rows = await fetchSheet(sheetUrl);
    } catch (err) {
      console.error('Templates preview — sheet fetch error:', err.message);
      return res.json({ previews: [], error: err.message });
    }

    // Pick the first 3 rows with an extractable LinkedIn URL.
    const picked = [];
    for (const row of rows) {
      if (picked.length >= 3) break;
      const url = extractLinkedInUrl(row, linkedinColumn);
      if (url) picked.push({ row, url });
    }

    const profileId = profileIds[0] || '';
    const pName = profileId; // no live GoLogin session in preview — id stands in for name

    // v2.59.x — Build SoO email → firstName map for per-row sender lookup
    // in IC and message_only previews. Done once per request, so picking 3
    // rows from a sheet of any size costs one SoO fetch. Failures are
    // logged but non-fatal — preview falls back to the old profileIds[0]
    // resolution if SoO is unreachable.
    const _wantsPerRowSender = (mode === 'introduce_back' || mode === 'message_only');
    const _soOFirstByName = {};
    if (_wantsPerRowSender) {
      try {
        const soo = await fetchSoOData();
        for (const acct of (soo && soo.accounts) || []) {
          if (acct && acct.email) {
            _soOFirstByName[acct.email.toLowerCase().trim()] = (acct.firstName || '').toString().trim();
          }
        }
      } catch (err) {
        console.warn('[preview] SoO fetch for per-row sender failed:', err.message);
      }
    }

    const previews = picked.map(({ row, url }) => {
      // Mirror campaign.js:603-612 data construction.
      const data = { ...row };
      data.firstName = row['First Name'] || row['firstName'] || row['first_name'] || '';
      data.lastName  = row['Last Name']  || row['lastName']  || row['last_name']  || '';
      data.company   = row['Company']    || row['company']   || '';
      data.title     = row['Title']      || row['title']     || row['Job Title']  || '';
      // v2.59.x — Per-row sender lookup for IC and message_only. The sheet
      // tells us which account owns each lead; the real send path uses
      // getSenderName(row, senderColumn) — we mirror that exactly here so
      // {senderFirstName} and {senderName} in the preview match what will
      // actually be sent. For CC+IC and other modes we keep the old logic
      // (resolvedFirst from selectedProfileIds → senderFirstNames map).
      let _perRowSender = '';
      if (_wantsPerRowSender) {
        if (senderColumn && row[senderColumn] != null) {
          _perRowSender = row[senderColumn].toString().trim();
        }
        if (!_perRowSender) {
          _perRowSender = (row.Sender || row.sender || '').toString().trim();
        }
      }
      const _perRowFirst = _perRowSender
        ? (_soOFirstByName[_perRowSender.toLowerCase()] || '')
        : '';

      data.senderName = _perRowSender || pName || '';
      const resolvedFirst = _perRowFirst || senderFirstNames[profileId];
      // v2.11.14: friendlier fallback for local-browser — if the operator
      // hasn't set a localBrowserFirstName yet, prefer "You" over the raw
      // profile id string so the preview reads naturally.
      const fallbackFirst = (profileId === 'local-browser')
        ? 'You'
        : ((pName || '').split(/\s+/)[0] || '');
      data.senderFirstName = (resolvedFirst && resolvedFirst.trim()) || fallbackFirst;

      // v2.11.14: when intro mode is on, mirror outreach.js:462's introData
      // injection so {intro name} / {intro first name} / {intro last name}
      // resolve in the preview the same way they will at send time. Keys
      // cover all three naming conventions used in the message templates.
      if (introMode && introName) {
        data['intro name']      = introName;
        data['introName']       = introName;
        data['intro_name']      = introName;
        data['intro first name']  = introFirst;
        data['introFirstName']    = introFirst;
        data['intro_first_name']  = introFirst;
        data['intro last name']   = introLast;
        data['introLastName']     = introLast;
        data['intro_last_name']   = introLast;
      }

      // v2.59.x — Primary-person substitution for CC+IC (and IC, which
      // shares the same chip vocabulary). Mirrors what auto-intro.js does
      // at send time so {primary full name} / {primary first name} /
      // {primary last name} / {primary url} resolve in the preview.
      const primaryName = (templates.primaryName || '').toString().trim();
      const primaryUrl  = (templates.primaryUrl  || '').toString().trim();
      if (primaryName) {
        const pTokens = primaryName.split(/\s+/);
        const pFirst  = pTokens[0] || '';
        const pLast   = pTokens.slice(1).join(' ');
        data['primary full name'] = primaryName;
        data['primary name']      = primaryName; // legacy alias
        data['primary first name'] = pFirst;
        data['primaryFirstName']   = pFirst;
        data['primary last name']  = pLast;
        data['primaryLastName']    = pLast;
      }
      if (primaryUrl) {
        data['primary url'] = primaryUrl;
        data['primaryUrl']  = primaryUrl;
      }

      // For each field, scan the raw template for {placeholders}, compute
      // unresolved ones, then render.
      const warnings = [];
      const rendered = {};
      const fieldLabels = {
        connectionNote: 'Connection Note',
        followUpMessage: 'Follow-up Message',
        inmailSubject: 'InMail Subject',
        inmailBody: 'InMail Body',
        opProfileSubject: 'Open Profile Subject',
        opProfileBody: 'Open Profile Body',
        introTitle: 'Group conversation title',
        primaryIntroBody: 'Intro DM Body',
        ccDmBody: 'CC+DM body',
      };
      for (const [key, raw] of Object.entries(tpl)) {
        if (!raw) { rendered[key] = ''; continue; }
        const placeholderMatches = raw.match(/\{([a-zA-Z0-9_ ]+)\}/g) || [];
        const unresolved = placeholderMatches
          .map(m => m.slice(1, -1))
          .filter(name => {
            const val = data[name];
            return val === undefined || val === null || val === '';
          });
        for (const name of unresolved) {
          warnings.push(`{${name}} not resolved for ${fieldLabels[key]}`);
        }
        rendered[key] = personalizeTemplate(raw, data);
      }

      return {
        lead: {
          firstName: data.firstName,
          lastName: data.lastName,
          company: data.company,
          url,
        },
        rendered,
        warnings,
      };
    });

    res.json({ previews });
  } catch (err) {
    console.error('Templates preview error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Campaign control
// ---------------------------------------------------------------------------
// Build a clean campaign config from a request body. Shared between the
// /api/campaign/start handler and the queue runner so a queued campaign
// v2.104: server-side mirror of the wizard's primary-URL hard-lock (defense in
// depth — covers re-run/restore/queue-only paths that don't go through the
// browser gate). For the intro flows only, a non-blank primaryUrl must be a
// real personal /in/ profile. Shares validatePrimaryUrl with the client, so
// the reject reason matches the inline error the operator saw. Returns true
// (and sends a 400) when the request should be rejected.
function rejectIfBadPrimaryUrl(body, res) {
  const mode = body && body.mode;
  if (mode !== 'connect_and_introduce' && mode !== 'introduce_back') return false;
  const url = ((body && body.templates && body.templates.primaryUrl) || '').toString().trim();
  const v = validatePrimaryUrl(url);
  if (!v.ok) {
    res.status(400).json({ error: `Primary person URL is invalid — ${v.reason}` });
    return true;
  }
  return false;
}

// Mandatory operator-identity gate. The shared dashboard login can't identify
// who's operating, so every reservation would mislabel; we hard-block campaign
// start until this machine's operator email is set. Returns true (and sends a
// 409 the UI turns into the mandatory modal) when it's missing.
function rejectIfNoOperatorEmail(res) {
  if (getOperatorEmail()) return false;
  res.status(409).json({ error: 'operator-email-required', code: 'OPERATOR_EMAIL_REQUIRED' });
  return true;
}

// runs with exactly the same shape as a directly-launched one.
function buildCampaignConfig(body) {
  const { profileIds, sheetUrl, templates, dailyLimit, mode, messageOpenProfiles,
          delayMin, delayMax, linkedinColumn, senderFirstNames, concurrency, name,
          acceptanceTrackingDays, preflightCheckStatus, checkIntervalMinutes,
          // v2.78: accounts to start benched (out of the rotation).
          benchedProfileIds,
          // v2.58.x — Introduction Campaign (introduce_back) sheet-mapping overrides.
          // Read for every campaign but only honored downstream when mode === 'introduce_back'.
          senderColumn, allLeadsConnected,
          // v2.59 (resume support): { totalProcessed } from the past history
          // entry being resumed. Seeded into campaign counters so the cockpit
          // continues counting from the saved total instead of zero.
          resumeContext } = body || {};
  let concurrencyClean = 1;
  if (Number.isFinite(Number(concurrency)) && Number(concurrency) >= 2) {
    const n = Math.min(5, Number(concurrency));
    if ((profileIds?.length || 0) >= 5) concurrencyClean = n;
  }
  return {
    profileIds,
    benchedProfileIds: Array.isArray(benchedProfileIds) ? benchedProfileIds.filter((x) => typeof x === 'string') : [],
    sheetUrl,
    templates: templates || {},
    dailyLimit: Number(dailyLimit),
    mode: mode || 'auto',
    messageOpenProfiles: !!messageOpenProfiles,
    delayMin: delayMin ? Number(delayMin) : undefined,
    delayMax: delayMax ? Number(delayMax) : undefined,
    linkedinColumn: linkedinColumn || '',
    // v2.58.x — IC-only overrides. Frontend already clears these for
    // non-IC modes; backend coerces here too for defence-in-depth.
    // v2.61: extended to include 'message_only' (Direct Messages) which
    // now mirrors IC's wizard extras (sender column + all-connected).
    senderColumn: (mode === 'introduce_back' || mode === 'message_only')
      ? (typeof senderColumn === 'string' ? senderColumn : '')
      : '',
    allLeadsConnected: (mode === 'introduce_back' || mode === 'message_only')
      ? !!allLeadsConnected
      : false,
    senderFirstNames: senderFirstNames || {},
    concurrency: concurrencyClean,
    name: typeof name === 'string' ? name : '',
    acceptanceTrackingDays: Math.max(0, Math.min(30, Number(acceptanceTrackingDays) || 0)),
    checkIntervalMinutes: clampCadenceMinutes(checkIntervalMinutes),
    // Honoured only when mode is message_only or introduce_back. campaign.js
    // gates further so other modes silently ignore the flag.
    preflightCheckStatus: !!preflightCheckStatus,
    // v2.59 resume — passed through to startCampaign which seeds counters.
    // Shape: { totalProcessed: number }. Other fields ignored for now.
    resumeContext: (resumeContext && typeof resumeContext === 'object') ? {
      totalProcessed: Number(resumeContext.totalProcessed) || 0,
    } : null,
  };
}

// Launch a campaign and chain into the queue when it finishes. Calling
// this while another campaign is still running will throw downstream from
// startCampaign — callers must check campaign.running first and queue
// instead if they want fire-and-forget semantics.
function launchCampaign(config, owner) {
  preventSleep('campaign');
  startCampaign({ ...config, createdBy: owner }).then(() => {
    const status = getCampaignStatus();
    notifyEmail(owner, {
      title: 'Campaign finished',
      body: `Your campaign finished: ${status.processedToday || 0} actions, ${(status.errors || []).length} error(s).`,
      link: '/',
    }).catch(() => {});
  }).catch(err => {
    console.error('Campaign error:', err.message);
    notifyEmail(owner, {
      title: 'Campaign failed',
      body: `Your campaign failed: ${err.message}`,
      link: '/',
    }).catch(() => {});
  }).finally(() => {
    allowSleep();
    // Chain into the queue. The next entry (if any) launches as soon as
    // the previous one fully cleans up. Sequential by design — we don't
    // run two campaigns in parallel.
    runNextFromQueue().catch(err => {
      console.error('Queue chain error:', err.message);
    });
  });
}

async function runNextFromQueue() {
  if (campaign.running) return;
  const next = await popNextQueued();
  if (!next) return;
  console.log(`[queue] Launching queued campaign "${next.name || '(unnamed)'}" (${next.id})`);
  launchCampaign(next.config, next.owner);
}

app.post('/api/campaign/start', async (req, res) => {
  try {
    // Phase 11.3 (DMS-04): mutex with Check DMs — both need the same browsers.
    if (checkDms.running) return res.status(409).json({ error: 'Check DMs is running — stop it first' });
    if (postAmp.running) return res.status(409).json({ error: 'Post Amplification is running — stop it first' });

    const body = req.body || {};
    const { profileIds, sheetUrl, dailyLimit, mode } = body;

    // 2.8.29 / 2.8.31: check_status and message_only auto-derive profiles from
    // the sheet's Account Used column inside campaign.js (only the original
    // sender can check / message a given lead), so empty profileIds is valid.
    if (mode !== 'check_status' && mode !== 'message_only' && mode !== 'introduce_back' && !profileIds?.length) {
      return res.status(400).json({ error: 'profileIds required' });
    }
    if (!sheetUrl) return res.status(400).json({ error: 'sheetUrl required' });
    if (!dailyLimit || dailyLimit < 1) return res.status(400).json({ error: 'dailyLimit must be >= 1' });
    if (rejectIfNoOperatorEmail(res)) return;
    if (rejectIfBadPrimaryUrl(body, res)) return;

    const config = buildCampaignConfig(body);
    const owner = req.user;

    // Clear the wizard draft name on launch so the next "+ Start new
    // campaign" click opens an empty wizard rather than re-prompting
    // about a now-stale draft with the same name.
    try { await writeDraftName(''); } catch { /* non-fatal */ }

    // If a campaign is already running, queue this one instead of erroring.
    // The queue chain in launchCampaign's finally{} will pick it up when
    // the current campaign finishes.
    if (campaign.running) {
      const entry = await addToQueue(config, owner);
      const runningName = campaign.name || '(unnamed)';
      return res.json({
        ok: true,
        queued: true,
        queueId: entry.id,
        message: `Added to queue. Will start when "${runningName}" finishes.`,
      });
    }
    // Defensive: if nothing is running but there ARE items already in the
    // queue, drain the queue's first item BEFORE starting this new one so
    // FIFO order is preserved (would otherwise jump the line).
    const existingQueue = await getQueue();
    if (existingQueue.length > 0) {
      const entry = await addToQueue(config, owner);
      // Now drain the head of the queue (which will be the previously-first
      // entry, not this newcomer).
      runNextFromQueue().catch(err => console.error('Drain failed:', err.message));
      return res.json({
        ok: true,
        queued: true,
        queueId: entry.id,
        message: `Added to queue (${existingQueue.length} ahead).`,
      });
    }

    // Fire-and-forget — campaign runs in background; dashboard polls
    // /api/status. launchCampaign handles preventSleep, allowSleep,
    // queue chaining, and finish/failure email notifications.
    launchCampaign(config, owner);

    // v2.59 — start-time same-name dedup. Moved from BEFORE launchCampaign
    // (the original site) to AFTER. Reason: the original placement
    // rewrote history.json before the launch was confirmed. If launchCampaign
    // failed synchronously (e.g., startCampaign threw before campaign.running
    // could be set), the prior history row was already gone. Now we gate
    // on `campaign.running` — startCampaign sets this synchronously at its
    // top before any await, so by the time we're back here we know the
    // launch is accepted. The v2.58 appendHistory dedup is still the
    // ultimate safety net at campaign END.
    if (campaign.running) {
      try {
        const incomingName = String(config.name || '').trim().toLowerCase();
        if (incomingName) {
          let history = [];
          try { history = JSON.parse(await readFile(HISTORY_PATH, 'utf8')); } catch { history = []; }
          if (Array.isArray(history)) {
            const before = history.length;
            history = history.filter((h) => ((h?.name || '').toString().trim().toLowerCase()) !== incomingName);
            if (history.length < before) {
              await writeFile(HISTORY_PATH, JSON.stringify(history, null, 2));
              console.log(`[history] start-time dedup: removed ${before - history.length} prior entr${before - history.length === 1 ? 'y' : 'ies'} named "${config.name}"`);
            }
          }
        }
      } catch (err) {
        console.warn('[history] start-time dedup failed (non-fatal):', err.message);
      }

      // Also drop any draft with the same name — the operator is launching
      // this one, the draft slot is now obsolete.
      try {
        const incomingName = String(config.name || '').trim().toLowerCase();
        if (incomingName) {
          const allDrafts = await getDrafts();
          for (const d of allDrafts) {
            const dn = String(d?.name || '').trim().toLowerCase();
            if (dn === incomingName) await removeDraft(d.id);
          }
        }
      } catch (err) {
        console.warn('[drafts] start-time dedup failed (non-fatal):', err.message);
      }
    }

    res.json({ ok: true, message: 'Campaign started' });
  } catch (err) {
    console.error('Campaign start error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// v2.58.x — IC preflight: validate that the sheet's sender column resolves
// to at least one matched GoLogin profile BEFORE starting. Mirrors the
// matching logic at src/campaign.js:1502-1564 but synchronous, no campaign
// side-effects. Lets the UI show a targeted modal instead of the operator
// finding the failure only in the post-start log rail.
app.post('/api/campaign/preflight-ic-senders', async (req, res) => {
  try {
    const { sheetUrl, senderColumn } = req.body || {};
    if (!sheetUrl) return res.status(400).json({ error: 'sheetUrl required' });

    const rows = await fetchSheet(sheetUrl);
    const token = process.env.GOLOGIN_API_TOKEN;
    const profiles = token ? await getProfiles(token) : [];
    const nameToId = {};
    for (const p of profiles) nameToId[p.name] = p.id;
    nameToId['You'] = 'local-browser';
    nameToId['Local Browser'] = 'local-browser';
    nameToId['local-browser'] = 'local-browser';
    nameToId['local-browser - manual'] = 'local-browser';

    const matched = new Map();
    const unmatched = new Map();
    let blanks = 0;
    for (const row of rows) {
      let acct = '';
      if (senderColumn && row && row[senderColumn] != null) {
        acct = row[senderColumn].toString().trim();
      }
      if (!acct) acct = (row?.Sender || row?.sender || '').toString().trim();
      if (!acct) { blanks++; continue; }
      if (nameToId[acct]) matched.set(acct, (matched.get(acct) || 0) + 1);
      else unmatched.set(acct, (unmatched.get(acct) || 0) + 1);
    }

    const totalRows = rows.length;
    if (matched.size > 0) {
      return res.json({ ok: true, totalRows, matchedCount: matched.size });
    }
    const reason = (blanks === totalRows) ? 'no_column' : 'no_match';
    const unmatchedArr = [...unmatched.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => ({ name, count }));
    res.json({ ok: false, reason, totalRows, blanks, unmatched: unmatchedArr });
  } catch (err) {
    console.error('IC preflight error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get a single queued campaign's full config (used by the dashboard Edit
// button — full payload, not the trimmed summary the list returns).
app.get('/api/queue/:id', async (req, res) => {
  try {
    const all = await getQueue();
    const entry = all.find((e) => e.id === req.params.id);
    if (!entry) return res.status(404).json({ error: 'Not found' });
    res.json(entry);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List queued campaigns for the dashboard's Queued section.
app.get('/api/queue', async (_req, res) => {
  try {
    const queue = await getQueue();
    // Strip large/sensitive fields the UI doesn't need (templates can be big).
    const summary = queue.map(e => ({
      id: e.id,
      name: e.name,
      queuedAt: e.queuedAt,
      mode: e.config?.mode || '',
      profileIds: e.config?.profileIds || [],
      sheetUrl: e.config?.sheetUrl || '',
    }));
    res.json({ queue: summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cancel a queued campaign before it starts.
app.delete('/api/queue/:id', async (req, res) => {
  try {
    const ok = await removeFromQueue(req.params.id);
    res.json({ ok });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// v2.60.0 — Edit a queued campaign entry. Body: subset of
// { name, scheduledAt, config } — any unknown keys are rejected by the
// helper. Used by the dashboard v0.3 "Edit" / "Reschedule" affordances
// on queue rows. Validation lives in updateQueueEntry; this handler
// just translates throws/null into HTTP status codes.
app.patch('/api/queue/:id', async (req, res) => {
  try {
    const updated = await updateQueueEntry(req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, entry: updated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Reorder a queued campaign within the FIFO order. Body: { direction: 'up' | 'down' }
app.post('/api/queue/:id/move', async (req, res) => {
  try {
    const dir = (req.body && req.body.direction) || '';
    if (dir !== 'up' && dir !== 'down') {
      return res.status(400).json({ error: 'direction must be "up" or "down"' });
    }
    const newIndex = await moveInQueue(req.params.id, dir);
    if (newIndex === -1) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, newIndex });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// v2.59.x — Atomic full-order reorder for drag-and-drop in the dashboard.
// Body: { ids: ["q_xxx", "q_yyy", ...] } in the desired new order. Validates
// the ids match the current queue exactly so a concurrent pop/cancel can't
// silently corrupt the order — client refreshes and retries on mismatch.
app.post('/api/queue/reorder', async (req, res) => {
  try {
    const ids = req.body && req.body.ids;
    if (!Array.isArray(ids)) {
      return res.status(400).json({ error: 'ids array required' });
    }
    const result = await reorderQueue(ids);
    if (!result.ok) {
      if (result.reason === 'mismatch') {
        return res.status(409).json({ error: 'Queue changed — refresh and retry', reason: 'mismatch' });
      }
      return res.status(400).json({ error: 'Invalid input', reason: result.reason || 'unknown' });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// v2.59.x — Add a campaign to the queue WITHOUT auto-draining. Mirrors the
// validation of /api/campaign/start but skips the running-or-empty branches
// — the operator clicks "Add to Queue" intentionally, even when idle, to
// stage runs without firing one immediately. Drain via /api/queue/run-next
// or wait for the next launchCampaign() chain.
app.post('/api/campaign/queue-only', async (req, res) => {
  try {
    if (checkDms.running) return res.status(409).json({ error: 'Check DMs is running — stop it first' });
    if (postAmp.running) return res.status(409).json({ error: 'Post Amplification is running — stop it first' });

    const body = req.body || {};
    const { profileIds, sheetUrl, dailyLimit, mode } = body;

    if (mode !== 'check_status' && mode !== 'message_only' && mode !== 'introduce_back' && !profileIds?.length) {
      return res.status(400).json({ error: 'profileIds required' });
    }
    if (!sheetUrl) return res.status(400).json({ error: 'sheetUrl required' });
    if (!dailyLimit || dailyLimit < 1) return res.status(400).json({ error: 'dailyLimit must be >= 1' });
    if (rejectIfNoOperatorEmail(res)) return;
    if (rejectIfBadPrimaryUrl(body, res)) return;

    const config = buildCampaignConfig(body);
    const owner = req.user;

    try { await writeDraftName(''); } catch { /* non-fatal */ }

    const entry = await addToQueue(config, owner);
    const position = (await getQueue()).length;
    res.json({
      ok: true,
      queued: true,
      queueId: entry.id,
      message: position === 1
        ? 'Added to queue. Press "Run next" or start another campaign to drain it.'
        : `Added to queue (position ${position}).`,
    });
  } catch (err) {
    console.error('Queue-only error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// v2.59.x — Explicitly drain the head of the queue when no campaign is
// running. Used by the dashboard's "Run next" pill, which is visible only
// when idle + non-empty queue. No-op (with a friendly response) if a
// campaign is already running — the queue will chain when it finishes.
app.post('/api/queue/run-next', async (_req, res) => {
  try {
    if (campaign.running) {
      return res.json({ ok: false, reason: 'running', message: 'A campaign is already running.' });
    }
    const queue = await getQueue();
    if (queue.length === 0) {
      return res.json({ ok: false, reason: 'empty', message: 'Queue is empty.' });
    }
    runNextFromQueue().catch(err => console.error('Run-next drain failed:', err.message));
    res.json({ ok: true, message: 'Draining next queued campaign…' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Monitoring routes (Task 8a) — Check now, Stop monitoring, State
// ---------------------------------------------------------------------------

app.post('/api/monitoring/check-now', async (req, res) => {
  try {
    const { runMonitoringCheckAll, getCampaignState } = await import('./src/campaign.js');
    const state = getCampaignState();
    if (state.state !== 'monitoring') {
      return res.status(400).json({ error: 'Campaign is not in monitoring state' });
    }
    // Fire and forget — the operator wants the button to feel responsive,
    // but the actual bulk-check pass takes 30-120s.
    runMonitoringCheckAll().catch((err) => console.warn('[check-now] threw:', err.message));
    res.json({ ok: true, started: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/monitoring/stop', async (_req, res) => {
  try {
    const { stopMonitoring: _stopMonitoring } = await import('./src/campaign.js');
    const result = await _stopMonitoring({ reason: 'operator-stopped' });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/monitoring/state', (_req, res) => {
  import('./src/campaign.js').then((mod) => {
    const c = mod.getCampaignState();
    // Return only the monitoring-relevant slice
    res.json({
      state: c.state || 'idle',
      mode: c.mode,
      sendingEndedAt: c.sendingEndedAt,
      monitoringUntil: c.monitoringUntil,
      nextCheckAt: c.nextCheckAt,
      participatingProfileIds: c.participatingProfileIds || [],
      profileIds: c.profileIds || [],
      profileNames: c.profileNames || [],
      logs: c.logs || [],
      sheetUrl: c.sheetUrl,
      name: c.name,
    });
  }).catch((err) => res.status(500).json({ error: err.message }));
});

// v2.14.x: macOS sleep-resume hook. Called by electron/main.js when the
// system wakes — kicks an immediate tick so an overdue auto-check fires
// without waiting up to 60s for the next setInterval boundary.
app.post('/api/monitoring/wake', async (_req, res) => {
  try {
    const { tickMonitoringNow } = await import('./src/campaign.js');
    tickMonitoringNow().catch((err) => console.warn('[wake] tick threw:', err.message));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// v2.78: guards for the manual /api/bulk-check-now sweep. _manualSweepRunning
// blocks overlapping sweeps; _manualSweepAbort lets Stop halt one in flight.
let _manualSweepRunning = false;
let _manualSweepAbort = false;

// v2.78: bench / un-bench an account in the live sending rotation. Body:
// { profileId, skip }. skip=false also retries an auto-parked account.
app.post('/api/campaign/profile-skip', (req, res) => {
  const { profileId, skip } = req.body || {};
  if (!profileId) return res.status(400).json({ error: 'profileId required' });
  const result = setProfileSkip(profileId, !!skip);
  res.json(result);
});

// v2.86.15: edit-while-paused. Three live setters apply new values to the
// running campaign object while it's paused; the send loop picks them up on
// Resume. Each is gated inside the setter on campaign.running && _paused.
app.post('/api/campaign/live/templates', (req, res) => {
  const templates = req.body?.templates || req.body || {};
  if (!templates || typeof templates !== 'object') {
    return res.status(400).json({ error: 'templates required' });
  }
  const result = setLiveTemplates(templates);
  res.json(result);
});

app.post('/api/campaign/live/daily-limit', (req, res) => {
  const dailyLimit = req.body?.dailyLimit;
  if (dailyLimit === undefined || dailyLimit === null) {
    return res.status(400).json({ error: 'dailyLimit required' });
  }
  const result = setLiveDailyLimit(dailyLimit);
  res.json(result);
});

app.post('/api/campaign/live/cadence', (req, res) => {
  const checkIntervalMinutes = req.body?.checkIntervalMinutes;
  if (checkIntervalMinutes === undefined || checkIntervalMinutes === null) {
    return res.status(400).json({ error: 'checkIntervalMinutes required' });
  }
  const result = setLiveCadence(checkIntervalMinutes);
  res.json(result);
});

app.post('/api/campaign/stop', async (req, res) => {
  // v2.14.x: optional `{ full: true }` body opts out of the
  // connect_and_introduce post-campaign sweep + auto-intros. Default
  // behaviour is unchanged (Stop sending, keep monitoring) — relevant only
  // when the running campaign is mode=connect_and_introduce.
  const fullHalt = !!(req.body && req.body.full);
  const result = stopCampaign({ full: fullHalt });
  // v2.14.x: ALSO flip the abort flags for Check DMs and Post Amplification.
  // The bottom-bar Stop button posts to /api/campaign/stop regardless of
  // which subsystem is currently running (the cockpit overlay sets
  // checkDms.running and postAmp.running to make the UI feel like a unified
  // campaign). Without these flips, the closeAllProfiles() below kills
  // their browsers but their loops keep iterating — post-amp launches a
  // FRESH browser for the next account and the operator sees a "stopped"
  // campaign mysteriously start sending again. checkDms has the same
  // shape. Flipping both flags here makes Stop actually mean Stop.
  checkDms._abort = true;
  postAmp._abort = true;
  // v2.78: also halt a manual /api/bulk-check-now sweep in flight — its
  // per-account loop checks this flag and breaks. stopCampaign() already
  // force-closes the in-flight check browser via activeBulkChecks.
  _manualSweepAbort = true;
  // v2.14.x: respond to the UI immediately so the dashboard flips to
  // 'stopping' without waiting for the browser-close round-trip. The actual
  // browser kill runs after a short drain window — see comment block below.
  res.json(result);

  // v2.14.x: drain-then-kill instead of kill-then-loop-discovers-it.
  //
  // The previous order (closeAllProfiles -> respond) force-closed every
  // browser BEFORE any in-flight worker had a chance to see _abort=true.
  // When that worker was inside runAutoIntros, the next iteration hit a
  // dead page and stamped 7-10 leads as 'Failed (MESSAGE_SEND_FAILED:
  // compose textbox did not appear)' — a cascade of phantom failures
  // (repro: franco.espino 2026-05-17T16:26:53).
  //
  // New order:
  //   1. stopCampaign() flips campaign._abort = true
  //   2. respond to UI
  //   3. wait 3s — gives in-flight runAutoIntros / monitoring loops time
  //      to see _abort at their next iteration boundary, stamp remaining
  //      leads as 'Skipped — Stop pressed', and exit their finally blocks
  //      (which close their own browser cleanly)
  //   4. closeAllProfiles() as a safety net for anything that didn't
  //      drain (e.g. hung navigations) — by now it's usually a no-op.
  //
  // Pattern matches Crawlee (apify/crawlee#1102) and the broader Puppeteer
  // graceful-abort guidance (puppeteer/puppeteer#4671). Worker-side
  // cleanup is already idempotent so the safety-net close is harmless.
  setTimeout(async () => {
    try { await closeAllProfiles(); } catch (err) { console.warn('[stop] closeAllProfiles:', err.message); }
    try { await closeLocalBrowser(); } catch (err) { console.warn('[stop] closeLocalBrowser:', err.message); }
  }, 3000);
});

// Phase 2.8.9: pause/resume control. Pause is non-destructive — browsers stay
// open, the loop sleeps at the next lead boundary. Resume picks up where it
// left off.
app.post('/api/campaign/pause', (_req, res) => {
  res.json(pauseCampaign());
});

app.post('/api/campaign/resume', (_req, res) => {
  res.json(resumeCampaign());
});

// Local-browser re-login recovery (2026-06-15): operator clicked "Done" in the
// "log into LinkedIn" popup. Flips campaign._loginDone so awaitLocalLogin's
// poll loop re-verifies health and resumes the run.
app.post('/api/campaign/login-done', (_req, res) => {
  res.json(confirmLogin());
});

// ---------------------------------------------------------------------------
// Sales Nav Scrape — control-panel proxy to the GKE scraper engine.
//
// These routes do NOT run a campaign or launch a local browser. They forward
// to the engine (src/scraper-client.js) and relay its JSON. The engine runs
// the GoLogin profile + scraping on GKE and writes results to the sheet. When
// SCRAPER_ENGINE_URL is unset every call returns { error } (never throws), so
// the UI can show "engine not configured" instead of failing.
// ---------------------------------------------------------------------------
app.post('/api/scrape/start', async (req, res) => {
  const { searchUrls, sheetUrl, tabName, profileId, slowMode } = req.body || {};
  const result = await startScrape({ searchUrls, sheetUrl, tabName, profileId, slowMode });
  res.status(result && result.error ? 400 : 200).json(result);
});

// Read input Sales Nav search URLs from a pasted Google Sheet (app-side only —
// the extracted URLs are dispatched as the same `searchUrls`, so the engine is
// unchanged). Never throws; returns { urls, count } or { error }.
app.get('/api/scrape/extract-urls', async (req, res) => {
  const sheetUrl = (req.query.sheetUrl || '').toString().trim();
  if (!sheetUrl) return res.status(400).json({ error: 'sheetUrl required' });
  try {
    // Row-aware read so the UI can offer a "scrape rows 2–10" picker. `items`
    // carries the 1-based sheet row number per URL; `urls` is the flat list
    // (back-compat / convenience).
    const rowsWithNumbers = await fetchSheetWithRows(sheetUrl);
    const items = extractSalesNavUrlsWithRows(rowsWithNumbers);
    res.json({ items, urls: items.map((i) => i.url), count: items.length });
  } catch (err) {
    res.status(400).json({ error: err && err.message ? err.message : 'could not read sheet' });
  }
});

app.post('/api/scrape/pause', async (req, res) => {
  res.json(await pauseScrape((req.body || {}).profileId));
});

app.post('/api/scrape/resume', async (req, res) => {
  res.json(await resumeScrape((req.body || {}).profileId));
});

app.post('/api/scrape/stop', async (req, res) => {
  res.json(await stopScrape((req.body || {}).profileId));
});

app.get('/api/scrape/jobs', async (_req, res) => {
  res.json(await getScrapeJobs());
});

app.get('/api/scrape/logs', async (req, res) => {
  res.json(await getScrapeLogs(req.query.since));
});

// Per-job live View — proxies the engine's MJPEG screencast stream
// (multipart/x-mixed-replace) straight through to the dashboard's <img>, which
// renders it as live video. Long-lived stream: we pipe frames as they arrive
// and abort the upstream when the viewer disconnects. 404 when not running.
app.get('/api/scrape/view/:jobId', async (req, res) => {
  const stream = await openScrapeJobViewStream(req.params.jobId);
  if (!stream.ok) return res.status(stream.status || 502).json({ error: stream.error });

  res.writeHead(200, {
    'Content-Type': stream.contentType,
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'X-Accel-Buffering': 'no',
  });

  const nodeStream = Readable.fromWeb(stream.body);
  const cleanup = () => {
    try { stream.abort(); } catch { /* */ }
    try { nodeStream.destroy(); } catch { /* */ }
  };
  req.on('close', cleanup);
  nodeStream.on('error', () => { try { res.end(); } catch { /* */ } });
  nodeStream.pipe(res);
});

// v2.14.x: Restore — "panic button" recovery endpoint. Force-kills
// browsers, force-resets in-memory campaign state (even if the in-flight
// loop is hung), and re-launches with the most recent settings. Settings
// source priority: live snapshot (_lastRunSettings) → last history.json
// entry → none (idle no-op with cleanup only). Always returns 200 with
// { ok, restartedFrom, reason? } — the loop runs async after the response.
app.post('/api/campaign/restore', async (_req, res) => {
  try {
    const result = await restoreCampaign();
    res.json(result);
  } catch (err) {
    console.error('[restore] failed:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/campaign/status', (_req, res) => {
  const base = getCampaignStatus();
  // v2.12.x: when Post Amplification is running, surface its state through
  // the same payload the Live Status panel already polls. Logs are already
  // mirrored into campaign.logs by pushPostAmpLog, so the log rail shows
  // them either way; this overlay just makes the headline tiles render.
  if (postAmp.running) {
    return res.json({
      ...base,
      running: true,
      mode: 'post_amplification',
      name: 'Post Amplification',
      currentProfile: postAmp.currentProfile || '',
      currentAction: {
        label: postAmp.currentProfile
          ? `Engaging ${postAmp.currentIndex}/${postAmp.total} · ${postAmp.currentProfile}`
          : 'Starting…',
        account: postAmp.currentProfile || '—',
        lead: postAmp.postUrl ? '(amplifying post)' : '—',
        mode: 'post_amplification',
        startedAt: postAmp.startedAt || Date.now(),
      },
      processedToday: postAmp.engaged,
      totalProcessed: postAmp.completed,
      totalTargets: postAmp.total,
      profileNames: [],
      errors: postAmp.errors.slice(-20).map(e => ({ message: e })),
    });
  }
  res.json(base);
});

// v2.83: live settings snapshot for the dashboard "Open" button. Returns the
// running/last campaign's full config (templates incl. primary contact,
// concurrency, delays, linkedinColumn, senderFirstNames) so the wizard can be
// pre-filled exactly like the past "Edit & resume" flow. { ok:false } when no
// campaign has run this process lifetime (nothing to open).
app.get('/api/campaign/active-settings', (_req, res) => {
  try {
    const settings = getLastRunSettings();
    if (!settings) return res.json({ ok: false, settings: null });
    res.json({ ok: true, settings });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Rename the active campaign. No-op if nothing is running — front-end disables
// the editable affordance in that case. Empty string clears the name.
app.post('/api/campaign/name', (req, res) => {
  try {
    const { name } = req.body || {};
    const updated = setCampaignName(typeof name === 'string' ? name : '');
    res.json({ ok: true, name: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Draft campaign name — persisted between sessions so the operator can stage a
// name from the wizard without launching a campaign. Dashboard surfaces it as
// a "Draft" row when nothing is running.
const DRAFT_NAME_FILE = dataPath('draft-name.json');

async function readDraftName() {
  try {
    const raw = await readFile(DRAFT_NAME_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed?.name === 'string' ? parsed.name : '';
  } catch { return ''; }
}

async function writeDraftName(name) {
  await mkdir(dirname(DRAFT_NAME_FILE), { recursive: true });
  const tmp = `${DRAFT_NAME_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify({ name, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
  const { rename } = await import('node:fs/promises');
  await rename(tmp, DRAFT_NAME_FILE);
}

app.get('/api/draft-name', async (_req, res) => {
  res.json({ name: await readDraftName() });
});

app.post('/api/draft-name', async (req, res) => {
  try {
    const name = (typeof req.body?.name === 'string' ? req.body.name : '').trim();
    // v2.59 name uniqueness: collision with running campaign is blocked
    // here too so the legacy single-draft path can't sneak around the
    // /api/drafts guard.
    const collision = _draftNameCollision(name);
    if (collision) return res.status(collision.status).json(collision.body);
    await writeDraftName(name);
    res.json({ ok: true, name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Active post-campaign acceptance-tracking windows. Used by the dashboard
// (future) to show the operator which sheets are still being swept and when
// they expire.
app.get('/api/post-campaign-tracking', async (_req, res) => {
  try {
    const list = await listPostCampaignSchedule();
    res.json({ windows: list });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// v2.72: Replies panel — inbound replies found by the hourly reply-check (and
// the manual Check DMs flow), newest first, plus the active reply-tracking
// windows. The dashboard polls this to show who replied + the message text.
app.get('/api/replies', async (_req, res) => {
  try {
    const [replies, unseen, windows] = await Promise.all([
      listReplies({ limit: 100 }),
      unseenReplyCount(),
      listReplyCheckSchedule(),
    ]);
    res.json({ replies, unseen, windows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mark all recorded replies as acknowledged (clears the panel's unseen badge).
app.post('/api/replies/seen', async (_req, res) => {
  try {
    await markRepliesSeen();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// v2.98 — resolve the swept-account NAMES (lowercased, for matching the sheet's
// Sender column) for a solo-check request. Returns null for "all senders".
// Mirrors the account resolution inside /api/bulk-check-now.
async function _resolveSweptAccountNames({ profileId, profileIds, allSenders }, token) {
  if (allSenders) return null;
  let ids = [];
  if (Array.isArray(profileIds) && profileIds.length) {
    ids = profileIds.filter((p) => typeof p === 'string' && p.length);
  } else if (profileId) {
    ids = [profileId];
  }
  if (!ids.length) return null;
  let nameById = new Map();
  try {
    const all = await getProfiles(token);
    nameById = new Map(all.map((p) => [p.id, String(p.name || '').toLowerCase()]));
  } catch { /* fall back to no names → treat as all */ }
  const names = new Set();
  for (const id of ids) { const n = nameById.get(id); if (n) names.add(n); }
  return names.size ? names : null;
}

// v2.98 — find rows stamped with the terminal "Failed — Primary not in your
// connections" intro failure, scoped to a set of sender names (null = all
// senders). Returns [{ linkedinUrl, sender }].
async function _findReconnectableIntroFailures(sheetUrl, linkedinColumn, accountNamesLower) {
  const rows = await fetchSheet(sheetUrl);
  const out = [];
  for (const row of rows) {
    const intro = (row['Introduction Status'] || row['introduction status'] || '').toString().trim();
    if (intro !== INTRO_FAILED_PRIMARY_NOT_CONNECTED) continue;
    const sender = (row['Sender'] || row['sender'] || row['Account Used'] || row['account used'] || '').toString().trim();
    if (accountNamesLower && !accountNamesLower.has(sender.toLowerCase())) continue;
    const url = extractLinkedInUrl(row, linkedinColumn);
    if (!url) continue;
    out.push({ linkedinUrl: url, sender });
  }
  return out;
}

// v2.98 — pre-scan for the "reconnect & retry" confirm. The solo-check UI calls
// this before sweeping; if count > 0 it shows a confirm naming the primary, then
// re-POSTs /api/bulk-check-now with reviveFailedIntros:true.
app.post('/api/intro-failures/preview', async (req, res) => {
  try {
    let { sheetUrl, linkedinColumn, profileId, profileIds, allSenders,
          primaryName, primarySource, autoAcceptPrimary } = req.body || {};
    if (!sheetUrl && campaign.running && campaign.sheetUrl) {
      sheetUrl = campaign.sheetUrl;
      linkedinColumn = linkedinColumn || campaign.linkedinColumn || '';
    }
    if (!sheetUrl) return res.status(400).json({ error: 'sheetUrl required' });
    const token = process.env.GOLOGIN_API_TOKEN;
    const names = await _resolveSweptAccountNames({ profileId, profileIds, allSenders }, token);
    const failures = await _findReconnectableIntroFailures(sheetUrl, linkedinColumn || '', names);
    const accounts = [...new Set(failures.map((f) => f.sender).filter(Boolean))];
    const effPrimary = (primaryName && String(primaryName).trim())
      || (campaign.templates && campaign.templates.primaryName) || '';

    // v2.98.1: resolve HOW the auto-accept will run so the confirm can spell it
    // out. Effective values fall back to the live campaign's templates when the
    // request didn't carry them (active-campaign solo check).
    const effSource = (primarySource !== undefined && primarySource !== null && primarySource !== '')
      ? primarySource
      : ((campaign.templates && campaign.templates.primarySource) || '');
    const effAutoAccept = (autoAcceptPrimary !== undefined)
      ? !!autoAcceptPrimary
      : !!(campaign.templates && campaign.templates.autoAcceptPrimary);
    let acceptVia = 'local';     // 'gologin' | 'local'
    let acceptViaName = '';
    if (effSource && effSource !== 'local-browser') {
      acceptVia = 'gologin';
      try {
        const all = await getProfiles(token);
        const p = all.find((x) => x.id === effSource);
        acceptViaName = (p && p.name) || effSource;
      } catch { acceptViaName = effSource; }
    }
    res.json({
      ok: true, count: failures.length, accounts, primaryName: effPrimary,
      autoAccept: effAutoAccept, acceptVia, acceptViaName,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manual bulk-check trigger. Bypasses the per-account cadence cooldown so the
// operator can on-demand sweep their sheet for newly-accepted invites.
//
// v2.71: works mid-campaign. If a campaign is running and not already
// paused, this endpoint pauses it, waits for the worker(s) to reach a
// lead boundary (so browsers go idle), runs the sweep + auto-intros, then
// resumes the campaign. Pause already triggered by the operator is left
// in place after the sweep (we only auto-resume what we auto-paused).
app.post('/api/bulk-check-now', async (req, res) => {
  // v2.78: refuse overlapping sweeps. A second click used to launch a parallel
  // 53-account sweep that fought the first for GoLogin browsers (see the
  // duplicate "sweeping 53 account(s)" lines in the field log).
  if (_manualSweepRunning) {
    return res.status(409).json({ error: 'A bulk check is already running. Wait for it to finish, or press Stop.' });
  }
  _manualSweepRunning = true;
  _manualSweepAbort = false;
  // v2.71: pause-if-running coordination. Captured before mutating campaign
  // state so the finally block knows whether to resume.
  const _weShouldAutoResume = campaign.running && !campaign._paused && !campaign._pauseRequested;
  try {
    let { sheetUrl, linkedinColumn, profileId, profileIds,
          primaryName, primaryIntroBody, primaryUrl, introTitle,
          autoAcceptPrimary, primarySource, allSenders, reviveFailedIntros } = req.body || {};
    // v2.78: "all senders in the sheet" — ignore any campaign/explicit accounts
    // and derive every account from the sheet's Sender column (below), even
    // while a campaign is running.
    if (allSenders) {
      profileIds = undefined;
      profileId = undefined;
    } else if (campaign.running && !(Array.isArray(profileIds) && profileIds.length > 0) && !profileId) {
      // v2.71: if running, default to the campaign's own selected profiles so
      // the sweep covers every account, not just the one the operator was
      // looking at. Operator-provided profileIds in req.body still wins.
      profileIds = Array.isArray(campaign.profileIds) ? campaign.profileIds.slice() : [];
    }
    // v2.71: fall back to the campaign's sheetUrl too — the live "Run check
    // now" button doesn't always re-post the sheet URL with the click.
    if (!sheetUrl && campaign.running && campaign.sheetUrl) {
      sheetUrl = campaign.sheetUrl;
      linkedinColumn = linkedinColumn || campaign.linkedinColumn || '';
    }
    if (!sheetUrl) return res.status(400).json({ error: 'sheetUrl required' });

    // v2.97: take precedence over a running campaign. Instead of waiting up to
    // 90s for a cooperative pause boundary (and failing if a slow lead — e.g. a
    // ~50s intro attempt — blew past it), we PREEMPT the in-flight lead so the
    // pause lands within ~1s. The preempted lead is left unstamped and is
    // re-attempted when the campaign resumes after the sweep.
    if (_weShouldAutoResume) {
      campaignLog('⏸ Manual bulk check — pausing campaign (taking precedence over the current lead)…');
      pauseCampaign();
      const preempted = preemptCurrentLead();
      campaignLog(preempted
        ? '⏭ Current lead preempted — it will be retried on resume.'
        : 'ℹ No lead in flight — pausing at the next boundary.');
      // Short wait for the pause to acknowledge. With preempt this is ~1s; allow
      // generous margin for a lead mid-cleanup, but never the old 90s hang.
      const deadline = Date.now() + 30_000;
      while (!campaign._paused && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250));
      }
      if (!campaign._paused) {
        campaignLog('⚠ Manual bulk check — pause did not acknowledge in 30s; sweeping anyway (browsers may contend briefly).');
      } else {
        campaignLog('✓ Campaign paused — starting sweep.');
      }
    }

    const token = process.env.GOLOGIN_API_TOKEN;
    const { bulkCheckConnections } = await import('./src/linkedin/bulk-check-connections.js');
    const { runAutoIntros } = await import('./src/linkedin/auto-intro.js');
    const { runAutoDms } = await import('./src/linkedin/auto-dm.js');
    const { closeProfile: _closeProfile } = await import('./src/gologin-launcher.js');

    // Build the list of profiles to sweep. Explicit selection wins (in
    // priority order: profileIds array > legacy profileId scalar). Fallback
    // is to derive unique account emails from the sheet's Account Used
    // column, then map to profile IDs via the GoLogin profile cache.
    let profileIdsToSweep = [];
    let derivedFromSheet = false;
    if (Array.isArray(profileIds) && profileIds.length > 0) {
      profileIdsToSweep = profileIds.filter((p) => typeof p === 'string' && p.length);
    } else if (profileId) {
      profileIdsToSweep = [profileId];
    } else {
      try {
        const rows = await fetchSheet(sheetUrl);
        const accountEmails = new Set();
        for (const row of rows) {
          // v2.78: prefer the canonical Sender column (the "all senders in the
          // sheet" solo check), falling back to Account Used for older sheets.
          const v = (row['Sender'] || row['sender'] || row['Account Used'] || row['account used'] || '').toString().trim();
          if (v && v.includes('@')) accountEmails.add(v.toLowerCase());
        }
        if (accountEmails.size === 0) {
          return res.status(400).json({ error: 'No accounts selected and no Account Used values found on the sheet to derive from.' });
        }
        const allProfiles = await getProfiles(token);
        const byName = new Map(allProfiles.map((p) => [String(p.name || '').toLowerCase(), p.id]));
        for (const email of accountEmails) {
          const pid = byName.get(email);
          if (pid) profileIdsToSweep.push(pid);
        }
        derivedFromSheet = true;
        if (profileIdsToSweep.length === 0) {
          return res.status(400).json({ error: `Found ${accountEmails.size} account email(s) on the sheet but none matched a GoLogin profile.` });
        }
      } catch (err) {
        return res.status(500).json({ error: `Could not derive accounts from sheet: ${err.message}` });
      }
    }

    // Resolve profile IDs → human names (the email, for Ortus accounts) so
    // the sidecar tab's Account column reads "rashank.khrera@ortus.solutions"
    // instead of an opaque GoLogin profile id. The campaign loop already
    // passes pName; the manual button used to skip this lookup.
    let nameByProfileId = new Map();
    try {
      const allProfiles = await getProfiles(token);
      nameByProfileId = new Map(allProfiles.map((p) => [p.id, p.name || p.id]));
    } catch { /* fall back to id-as-name if cache fetch fails */ }

    // Filter out accounts the most-recent campaign parked. parkedProfiles is
    // in-memory (not persisted across restarts) so this only catches the
    // current/last-run session-dead accounts — but that's exactly the case
    // the operator is hitting: ran a campaign, an account got parked for
    // session-expired, then they hit Bulk Check and it tried that dead
    // account anyway. Now skip it and tell them why in the response.
    const parkedSet = new Set((campaign.parkedProfiles || []).map((p) => p.profileId));
    const skippedParked = [];
    profileIdsToSweep = profileIdsToSweep.filter((pid) => {
      if (parkedSet.has(pid)) {
        const reason = (campaign.parkedProfiles.find((p) => p.profileId === pid) || {}).reason || 'parked';
        const pName = nameByProfileId.get(pid) || pid;
        skippedParked.push({ profileId: pid, profileName: pName, reason });
        campaignLog(`⏭ Skipping ${pName} — parked from last campaign (${reason}).`);
        return false;
      }
      return true;
    });
    if (profileIdsToSweep.length === 0) {
      return res.json({
        ok: true,
        derivedFromSheet,
        profilesSweep: 0,
        skippedParked,
        result: { matched: 0, stamped: 0, fetched: 0 },
        perProfile: [],
      });
    }

    // v2.98 — "reconnect & retry" revive (operator confirmed in the UI). For
    // each swept account, overwrite its terminal "Failed — Primary not in your
    // connections" rows with the non-terminal retry sentinel and remember their
    // URLs. Folding those URLs into connectedUrls below makes runAutoIntros'
    // connect-to-primary gate fire this run (send the connect + queue the
    // auto-accept); the sentinel makes future checks keep retrying until the
    // intro lands. We can't clear the cell to blank — the shared Apps Script
    // skips empty-string writes — so the sentinel doubles as the visible status.
    const reviveByAccount = new Map(); // pName.toLowerCase() -> Set(urls)
    if (reviveFailedIntros) {
      try {
        const sweptNames = new Set(
          profileIdsToSweep.map((pid) => (nameByProfileId.get(pid) || '').toLowerCase()).filter(Boolean)
        );
        const failures = await _findReconnectableIntroFailures(
          sheetUrl, linkedinColumn || '', sweptNames.size ? sweptNames : null
        );
        const { updateSheetRow } = await import('./src/sheets-writer.js');
        for (const f of failures) {
          const key = (f.sender || '').toLowerCase();
          if (!reviveByAccount.has(key)) reviveByAccount.set(key, new Set());
          reviveByAccount.get(key).add(f.linkedinUrl);
          try {
            await updateSheetRow(sheetUrl, f.linkedinUrl, { introductionStatus: INTRO_RETRY_RECONNECT }, linkedinColumn || '');
          } catch (e) {
            campaignLog(`⚠ Reconnect & retry — could not mark ${f.linkedinUrl}: ${e.message}`);
          }
        }
        if (failures.length) {
          campaignLog(`↻ Reconnect & retry — re-queued ${failures.length} failed intro(s) across ${reviveByAccount.size} account(s); they will reconnect to the primary and retry.`);
        }
      } catch (e) {
        campaignLog(`⚠ Reconnect & retry preflight failed: ${e.message}`);
      }
    }

    // Sweep each profile sequentially. Sequential because GoLogin browsers
    // are RAM-heavy and parallel launches can OOM the laptop on weak hosts.
    const perProfile = [];
    let totalMatched = 0;
    let totalStamped = 0;
    let totalFetched = 0;
    campaignLog(`📡 Manual bulk Connection Status check — sweeping ${profileIdsToSweep.length} account(s)…`);
    // v2.59.15: report "a check is running" so the monitoring dashboard hero
    // flips to the gold pulsing "CHECKING / now" during a manual sweep (it
    // previously only fired for the scheduled auto-check). try/finally so the
    // flag always clears — a stuck flag would block scheduled ticks forever.
    setBulkCheckInProgress(true);
    try {
    for (const pid of profileIdsToSweep) {
      // v2.78: stop the sweep the instant the operator hits Stop, instead of
      // grinding through every remaining account.
      if (_manualSweepAbort || campaign._abort) {
        campaignLog('■ Stop detected — halting bulk check sweep.');
        break;
      }
      const pName = nameByProfileId.get(pid) || pid;
      const wasAlreadyRunning = !!getProfilePid(pid);
      campaignLog(`📡 [${pName}] Launching browser…`);
      let launched;
      try {
        launched = await launchProfile(pid, token);
      } catch (err) {
        const msg = `Launch failed: ${err.message}`;
        campaignLog(`⚠ [${pName}] ${msg}`);
        perProfile.push({ profileId: pid, profileName: pName, error: msg });
        continue;
      }
      // v2.78: register the in-flight check so Stop (stopCampaign /
      // _forceCloseActiveBulkChecks) force-closes this browser and interrupts
      // a sweep already mid-flight.
      addActiveBulkCheck(pid);
      let r;
      try {
        campaignLog(`📡 [${pName}] Sweeping recent connections…`);
        r = await bulkCheckConnections(launched.page, sheetUrl, linkedinColumn || '', pName);
        // v2.14.x: Match the cockpit's "Check now" button — after bulk-check,
        // also fire auto-intros for any newly-accepted leads. Build the
        // templates object from req.body fields first (wizard direct call),
        // then fall back to campaign.templates (live-panel "Bulk Check" button
        // which has no DOM fields for primary person). Without this fallback,
        // the button only stamped Connection Accepted but never sent the intro
        // DM, leaving operators wondering why Bulk Check produced no IC messages.
        // Note: runAutoIntros reads templates.primaryName / templates.primaryIntroBody
        // (not top-level params), so we must pass a templates object.
        const _reqTemplates = {
          primaryName:      String(primaryName      || '').trim(),
          primaryIntroBody: String(primaryIntroBody || '').trim(),
          primaryUrl:       String(primaryUrl       || '').trim(),
          introTitle:       introTitle || '',
          // v2.97: carry the auto-accept config so the v2.96 connect-to-primary
          // self-heal can fire from the solo check too (fall back to the live
          // campaign's templates when the request didn't include them).
          autoAcceptPrimary: (autoAcceptPrimary !== undefined)
            ? autoAcceptPrimary
            : (campaign.templates && campaign.templates.autoAcceptPrimary),
          primarySource: (primarySource !== undefined)
            ? primarySource
            : (campaign.templates && campaign.templates.primarySource),
        };
        const _effectiveTemplates = (_reqTemplates.primaryName && _reqTemplates.primaryIntroBody)
          ? _reqTemplates
          : (campaign.templates || {});
        // v2.59.2: phase-2 routing MUST respect the campaign mode. Previously
        // this block fired runAutoIntros for ANY campaign whose templates
        // happened to carry primaryName + primaryIntroBody — so a CC+DM run
        // whose campaign.templates still held leftover primary fields (from a
        // prior CC+IC config) sent a 3-way INTRO instead of a plain DM. Repro
        // in dev-app.log 2026-05-29T12:47:19 ("Auto-introducing … to Antonio
        // Varlese" during a connect_and_message campaign). Gate by mode:
        // CC+DM → runAutoDms (plain DM only, never an IC), everything else →
        // the existing intro path.
        // v2.98: fold this account's revived failed-intro URLs into the set so
        // the connect-to-primary gate runs even when nobody newly accepted.
        // CSV-export lag means bulkCheckConnections may not have re-picked the
        // just-written sentinel rows yet; this guarantees they're processed now.
        const _revive = reviveByAccount.get((pName || '').toLowerCase());
        if (_revive && _revive.size) {
          if (!Array.isArray(r.connectedUrls)) r.connectedUrls = [];
          const _seen = new Set(r.connectedUrls);
          for (const u of _revive) if (!_seen.has(u)) r.connectedUrls.push(u);
        }
        const _phaseMode = campaign.mode || '';
        if (!r.error && Array.isArray(r.connectedUrls) && r.connectedUrls.length > 0) {
          if (_phaseMode === 'connect_and_message') {
            const _ccDmBody = ((campaign.templates && campaign.templates.ccDmBody) || '').trim();
            if (_ccDmBody) {
              try {
                await runAutoDms({
                  page: launched.page,
                  profileId: pid,
                  profileName: pName,
                  sheetUrl,
                  linkedinColumn: linkedinColumn || '',
                  connectedUrls: r.connectedUrls,
                  templates: campaign.templates || {},
                  senderFirstNames: campaign.senderFirstNames || {},
                  log: campaignLog,
                });
              } catch (dmErr) {
                campaignLog(`⚠ [${pName}] Auto-DM pass threw: ${dmErr.message}`);
              }
            } else {
              campaignLog(`⚠ [${pName}] CC+DM bulk-check: post-acceptance DM body missing — no DM sent.`);
            }
          } else if (_effectiveTemplates.primaryName && _effectiveTemplates.primaryIntroBody) {
            try {
              await runAutoIntros({
                page: launched.page,
                profileId: pid,
                profileName: pName,
                sheetUrl,
                linkedinColumn: linkedinColumn || '',
                connectedUrls: r.connectedUrls,
                templates: _effectiveTemplates,
                senderFirstNames: campaign.senderFirstNames || {},
                log: campaignLog,
              });
            } catch (introErr) {
              campaignLog(`⚠ [${pName}] Auto-intro pass threw: ${introErr.message}`);
            }
          }
        }
      } catch (err) {
        r = { error: `Sweep threw: ${err.message}` };
      } finally {
        removeActiveBulkCheck(pid);
        if (!wasAlreadyRunning) {
          try { await _closeProfile(pid); } catch { /* */ }
        }
      }
      if (r.error) {
        campaignLog(`⚠ [${pName}] Bulk check: ${r.error}`);
      } else {
        const stamped = r.stamped || 0;
        campaignLog(`📡 [${pName}] Bulk check: ${r.matched || 0} marked Connected, ${stamped} marked Still Pending (of ${r.fetched || 0} recent connections fetched)`);
      }
      if (r.diag) campaignLog(`📡 [${pName}] diag: ${r.diag}`);
      perProfile.push({ profileId: pid, profileName: pName, ...r });
      if (!r.error) {
        totalMatched += r.matched || 0;
        totalStamped += r.stamped || 0;
        totalFetched += r.fetched || 0;
      }
    }
    campaignLog(`📡 Manual bulk check complete — ${totalMatched} Connected, ${totalStamped} Still Pending across ${profileIdsToSweep.length} account(s).`);
    } finally {
      setBulkCheckInProgress(false);
    }

    res.json({
      ok: true,
      derivedFromSheet,
      profilesSweep: profileIdsToSweep.length,
      skippedParked,
      result: {
        matched: totalMatched,
        stamped: totalStamped,
        fetched: totalFetched,
      },
      perProfile,
      autoPaused: _weShouldAutoResume,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    _manualSweepRunning = false;
    // v2.71: ALWAYS resume if we were the ones who paused, even on error.
    // Operator-initiated pauses are left in place — we only undo our own.
    if (_weShouldAutoResume && campaign.running) {
      try {
        resumeCampaign();
        campaignLog('▶ Manual bulk check done — campaign resumed.');
      } catch (resumeErr) {
        campaignLog(`⚠ Manual bulk check — resume failed: ${resumeErr.message}`);
      }
    }
  }
});

// v2.78: stop a running manual/solo bulk-check sweep (the "Stop solo check"
// button). Sets the abort flag and force-closes the in-flight check browser so
// the sweep breaks within ~1-2s, then unwinds and resolves the original
// /api/bulk-check-now request.
app.post('/api/bulk-check/stop', (_req, res) => {
  const wasRunning = _manualSweepRunning;
  _manualSweepAbort = true;
  forceCloseActiveBulkChecks();
  if (wasRunning) campaignLog('■ Stop solo check requested — halting sweep.');
  res.json({ ok: true, wasRunning });
});

// v2.72: Manual "Run reply check now" — the messaging-campaign counterpart of
// /api/bulk-check-now. Instead of sweeping connection acceptances, it scrapes
// each sent lead's thread for inbound replies (writes Reply/ReplyAt/Stage to
// the sheet + Replies tab via checkProfileDmsPerLead, and records them to the
// in-app replies panel). Works mid-campaign with the same pause/resume +
// idempotent-launch pattern as bulk-check-now, so the paused campaign's own
// browser is reused and never closed out from under it.
app.post('/api/reply-check-now', async (req, res) => {
  const _weShouldAutoResume = campaign.running && !campaign._paused && !campaign._pauseRequested;
  try {
    let { sheetUrl, linkedinColumn, profileIds } = req.body || {};
    if (campaign.running && !(Array.isArray(profileIds) && profileIds.length > 0)) {
      profileIds = Array.isArray(campaign.profileIds) ? campaign.profileIds.slice() : [];
    }
    if (!sheetUrl && campaign.running && campaign.sheetUrl) {
      sheetUrl = campaign.sheetUrl;
      linkedinColumn = linkedinColumn || campaign.linkedinColumn || '';
    }
    if (!sheetUrl) return res.status(400).json({ error: 'sheetUrl required' });

    if (_weShouldAutoResume) {
      campaignLog('⏸ Manual reply check — pausing campaign so the browser can scan threads…');
      pauseCampaign();
      const deadline = Date.now() + 90_000;
      while (!campaign._paused && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
      }
      if (!campaign._paused) {
        campaignLog('⚠ Manual reply check — pause did not acknowledge in 90s; aborted.');
        return res.status(503).json({ error: 'Pause did not take effect within 90s. Wait for the current lead to finish, then retry.' });
      }
      campaignLog('✓ Campaign paused — starting reply check.');
    }

    const token = process.env.GOLOGIN_API_TOKEN;
    const { checkProfileDms } = await import('./src/linkedin/check-dms.js');
    const { appendReplies } = await import('./src/replies-log.js');
    const { scanRepliesForProfile } = await import('./src/post-campaign-reply-check.js');
    const { writeRecentMessagesTab } = await import('./src/sheets-writer.js');
    const { closeProfile: _closeProfile } = await import('./src/gologin-launcher.js');

    // Scan window: back to the campaign's first send-out minus a 12h buffer.
    const _startMs = campaign.startedAt ? Date.parse(campaign.startedAt) : NaN;
    const _replyWatermark = (Number.isFinite(_startMs) ? _startMs : (Date.now() - 14 * 86400000)) - 12 * 60 * 60 * 1000;

    // Load the sheet once, resolve profile names, group sent rows by sender.
    let rows;
    try { rows = await fetchSheet(sheetUrl); }
    catch (err) { return res.status(400).json({ error: `Could not load sheet: ${err.message}` }); }

    let nameByProfileId = new Map();
    let nameToId = {};
    try {
      const allProfiles = await getProfiles(token);
      nameByProfileId = new Map(allProfiles.map((p) => [p.id, p.name || p.id]));
      for (const p of allProfiles) nameToId[(p.name || '').toLowerCase()] = p.id;
    } catch { /* fall back to id-as-name */ }

    const hasStageSchema = rows.length > 0 && ('Stage' in rows[0]);
    const candidateRows = rows.filter((row) => {
      if (hasStageSchema) return CHECK_DMS_STAGE_FILTER.has(String(row.Stage || '').trim());
      return String(row.Message || '').trim().toLowerCase() === 'sent';
    });

    // Which profiles to check: explicit > campaign's > everyone with sent rows.
    let targetProfileIds = Array.isArray(profileIds) && profileIds.length
      ? profileIds.slice()
      : null;

    const leadsByProfile = new Map();
    for (const row of candidateRows) {
      const acct = String(row['Sender'] || row['sender'] || row['Account Used'] || row['account used'] || '').trim();
      if (!acct) continue;
      const pid = nameToId[acct.toLowerCase()] || acct;
      if (targetProfileIds && !targetProfileIds.includes(pid)) continue;
      if (!leadsByProfile.has(pid)) leadsByProfile.set(pid, []);
      leadsByProfile.get(pid).push(row);
    }

    if (leadsByProfile.size === 0) {
      return res.json({ ok: true, profilesChecked: 0, repliesFound: 0, perProfile: [], autoPaused: _weShouldAutoResume });
    }

    const perProfile = [];
    let totalReplies = 0;
    setBulkCheckInProgress(true);
    campaignLog(`📬 Manual reply check — scanning ${leadsByProfile.size} account(s) for replies…`);
    try {
      for (const [pid, leads] of leadsByProfile.entries()) {
        const pName = nameByProfileId.get(pid) || pid;
        const wasAlreadyRunning = !!getProfilePid(pid);
        let launched;
        try {
          launched = await launchProfile(pid, token);
        } catch (err) {
          campaignLog(`⚠ [${pName}] Launch failed: ${err.message}`);
          perProfile.push({ profileId: pid, profileName: pName, error: `Launch failed: ${err.message}` });
          continue;
        }
        try {
          campaignLog(`📬 [${pName}] Scanning inbox for replies…`);
          // v2.72: bulk inbox fetch first (fast), reusing this (paused) profile's
          // own browser; falls back to per-lead thread scrape if the inbox API
          // can't be read. Back to the campaign's first send-out − 12h.
          const result = await scanRepliesForProfile({
            profileId: pid,
            profileName: pName,
            leads,
            sheetUrl,
            linkedinColumn: linkedinColumn || 'Linkedin URL',
            watermark: _replyWatermark,
            page: launched.page, // reuse this session; do NOT let it self-close
          });
          if (Array.isArray(result.errors) && result.errors.length) {
            campaignLog(`⚠ [${pName}] reply scan: ${result.errors.join('; ')}`);
          }
          totalReplies += result.inboundCount;
          await appendReplies(result.logEntries || []);
          // v2.72: dump inbound 1:1 replies to the shared "Recent Messages" tab.
          try { await writeRecentMessagesTab(sheetUrl, pName, result.recentMessages || [], []); }
          catch (e) { campaignLog(`⚠ [${pName}] Recent Messages write failed: ${e.message}`); }
          campaignLog(`📬 [${pName}] ${result.inboundCount} reply(ies)${result.suspectedCount ? `, ${result.suspectedCount} suspected (ambiguous name)` : ''} found [${result.method}].`);
          perProfile.push({ profileId: pid, profileName: pName, replies: result.inboundCount, suspected: result.suspectedCount });
        } catch (err) {
          campaignLog(`⚠ [${pName}] Reply check threw: ${err.message}`);
          perProfile.push({ profileId: pid, profileName: pName, error: err.message });
        } finally {
          if (!wasAlreadyRunning) { try { await _closeProfile(pid); } catch { /* */ } }
        }
      }
      campaignLog(`📬 Manual reply check complete — ${totalReplies} new reply(ies) across ${leadsByProfile.size} account(s).`);
    } finally {
      setBulkCheckInProgress(false);
    }

    res.json({ ok: true, profilesChecked: leadsByProfile.size, repliesFound: totalReplies, perProfile, autoPaused: _weShouldAutoResume });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    if (_weShouldAutoResume && campaign.running) {
      try { resumeCampaign(); campaignLog('▶ Manual reply check done — campaign resumed.'); }
      catch (resumeErr) { campaignLog(`⚠ Manual reply check — resume failed: ${resumeErr.message}`); }
    }
  }
});

app.delete('/api/draft-name', async (_req, res) => {
  try {
    await writeDraftName('');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Multi-draft endpoints ──
// The single-draft /api/draft-name above is kept for back-compat (the
// wizard's saveDraftName still hits it). These power the new dashboard
// Drafts section and let the operator stage multiple campaigns in
// parallel without losing any.
app.get('/api/drafts', async (_req, res) => {
  try { res.json({ drafts: await getDrafts() }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/drafts/:id', async (req, res) => {
  try {
    const d = await getDraft(req.params.id);
    if (!d) return res.status(404).json({ error: 'Not found' });
    res.json(d);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// v2.59: name uniqueness check shared by POST + PATCH. Blocks saving a
// draft whose name collides with the currently-running campaign.
// Returns null when the name is OK, or an error payload when blocked.
function _draftNameCollision(name) {
  const norm = String(name || '').trim().toLowerCase();
  if (!norm) return null;
  const runningName = String(campaign.name || '').trim().toLowerCase();
  if (runningName && runningName === norm) {
    return {
      status: 409,
      body: {
        error: 'name_collides_with_running',
        message: `A campaign called "${campaign.name}" is currently running. Choose a different name, or stop the running campaign first.`,
      },
    };
  }
  return null;
}

app.post('/api/drafts', async (req, res) => {
  try {
    const { name, config } = req.body || {};
    const collision = _draftNameCollision(name);
    if (collision) return res.status(collision.status).json(collision.body);
    const entry = await addDraft({ name, config });
    res.json({ ok: true, draft: entry });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/drafts/:id', async (req, res) => {
  try {
    const collision = _draftNameCollision(req.body?.name);
    if (collision) return res.status(collision.status).json(collision.body);
    const updated = await updateDraft(req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, draft: updated });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/drafts/:id', async (req, res) => {
  try {
    const ok = await removeDraft(req.params.id);
    res.json({ ok });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------------------------------------------------------------------------
// Phase 11.2: Show Browsers — un-hide every active Chromium process (D-18).
// Called by the dashboard "Show Browsers" button and the tray menu item.
// ---------------------------------------------------------------------------
app.post('/api/browsers/show', async (_req, res) => {
  try {
    if (process.platform !== 'darwin') {
      return res.json({ ok: true, shown: 0, skipped: 0, platform: 'other' });
    }
    const pids = getActiveBrowserPids();
    const { shown, skipped } = await unhideByPids(pids);
    res.json({ ok: true, shown, skipped, platform: 'darwin' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Open the GoLogin browser for a specific profile. If the profile is already
// running (in activeProfiles), unhide its window and bring it onscreen.
// If not, launch it. Used by the Account Queue's Open Browser + Try Again
// buttons so the operator can manually intervene mid-run (e.g. log back in
// after a session-expired park).
app.post('/api/profile/:id/open-browser', async (req, res) => {
  const profileId = req.params.id;
  if (!profileId) return res.status(400).json({ error: 'profileId required' });
  try {
    const existingPid = getProfilePid(profileId);
    if (existingPid) {
      if (process.platform === 'darwin') {
        await unhideByPids([existingPid]);
      }
      return res.json({ ok: true, action: 'focused-existing', pid: existingPid });
    }
    const token = process.env.GOLOGIN_API_TOKEN;
    await launchProfile(profileId, token);
    const newPid = getProfilePid(profileId);
    if (process.platform === 'darwin' && newPid) {
      await unhideByPids([newPid]);
    }
    res.json({ ok: true, action: 'launched', pid: newPid });
  } catch (err) {
    console.error(`[open-browser] ${profileId}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Retry a parked profile mid-run: clears the campaign-side park state
// (weeklyLimited, parkedProfiles, profileEndReasons, consecutive counters)
// AND opens the GoLogin browser so the operator can re-authenticate. The
// next campaign rotation picks the profile up again.
app.post('/api/campaign/profile/:id/retry', async (req, res) => {
  const profileId = req.params.id;
  if (!profileId) return res.status(400).json({ error: 'profileId required' });
  try {
    const result = retryParkedProfile(profileId);
    if (!result.ok) return res.status(409).json({ error: result.reason || 'retry-failed' });
    // Same launch + unhide flow as /api/profile/:id/open-browser. We don't
    // delegate so the response can carry both the unpark + launch outcome.
    let launchInfo;
    const existingPid = getProfilePid(profileId);
    if (existingPid) {
      if (process.platform === 'darwin') await unhideByPids([existingPid]);
      launchInfo = { action: 'focused-existing', pid: existingPid };
    } else {
      const token = process.env.GOLOGIN_API_TOKEN;
      try {
        await launchProfile(profileId, token);
        const newPid = getProfilePid(profileId);
        if (process.platform === 'darwin' && newPid) await unhideByPids([newPid]);
        launchInfo = { action: 'launched', pid: newPid };
      } catch (launchErr) {
        // Unpark already happened — campaign loop will try the launch itself
        // on next rotation. Surface the failure but don't fail the whole call.
        launchInfo = { action: 'launch-failed', error: launchErr.message };
      }
    }
    res.json({ ok: true, profileName: result.profileName, browser: launchInfo });
  } catch (err) {
    console.error(`[retry] ${profileId}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Phase 11.3: Check DMs
// Scans LinkedIn inboxes for replies to previously messaged prospects and
// writes results to the sheet + in-memory cache for the UI to fetch.
// ---------------------------------------------------------------------------
const checkDms = {
  running: false,
  _abort: false,
  currentProfile: null,
  repliesFound: 0,
  errors: [],
  startedAt: null,
  _lastResults: null, // { byProfile: { name: [replies] }, ambiguous, completedAt }
};

const CHECK_DMS_STATE_FILE = dataPath('check-dms-state.json');

async function loadCheckDmsWatermarks() {
  try {
    const raw = await readFile(CHECK_DMS_STATE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch { return {}; }
}

async function saveCheckDmsWatermarks(state) {
  try {
    await mkdir(dirname(CHECK_DMS_STATE_FILE), { recursive: true });
    await writeFile(CHECK_DMS_STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    console.warn(`[check-dms] failed to save watermarks: ${err.message}`);
  }
}

// 2.9.7: Stages that mean "we've sent at least one outbound message and are
// now waiting for / tracking a reply." Check DMs only scrapes these rows.
const CHECK_DMS_STAGE_FILTER = new Set([
  'DM Sent', 'IC Sent', 'OP Sent', 'InM Sent', 'Replied',
]);

app.post('/api/check-dms/start', async (req, res) => {
  try {
    if (campaign.running) return res.status(409).json({ error: 'Campaign is running — stop it first' });
    if (checkDms.running) return res.status(409).json({ error: 'Check DMs is already running' });
    if (postAmp.running) return res.status(409).json({ error: 'Post Amplification is running — stop it first' });

    const { sheetUrl, linkedinColumn } = req.body;
    if (!sheetUrl) return res.status(400).json({ error: 'sheetUrl required' });

    // 2.9.7: Auto-route from the sheet's Account Used column. Same logic as
    // check_status / message_only — operator no longer picks profiles.
    let rows;
    try { rows = await fetchSheet(sheetUrl); }
    catch (err) { return res.status(400).json({ error: `Could not load sheet: ${err.message}` }); }

    let profiles = [];
    try {
      const token = process.env.GOLOGIN_API_TOKEN;
      if (token) profiles = await getProfiles(token);
    } catch (err) {
      console.warn(`[check-dms] getProfiles failed: ${err.message}`);
    }

    const nameToId = {};
    for (const p of profiles) nameToId[p.name] = p.id;
    // Local browser pseudo-profile aliases (mirror campaign.js).
    nameToId['You']                    = 'local-browser';
    nameToId['Local Browser']          = 'local-browser';
    nameToId['local-browser']          = 'local-browser';
    nameToId['local-browser - manual'] = 'local-browser';

    // Filter rows to Sent-stage rows. Fall back to legacy Message='sent' if
    // the sheet doesn't have a Stage column yet.
    const hasStageSchema = rows.length > 0 && ('Stage' in rows[0]);
    const candidateRows = rows.filter(row => {
      if (hasStageSchema) {
        const stage = String(row.Stage || '').trim();
        return CHECK_DMS_STAGE_FILTER.has(stage);
      }
      return String(row.Message || '').trim().toLowerCase() === 'sent';
    });

    // Group rows by Sender → profileId. New schema (2.9.x) writes the
    // canonical name to the 'Sender' column; legacy sheets use 'Account Used'.
    // Read both — prefer Sender, fall back to Account Used.
    const leadsByProfile = new Map();
    const unmatched = new Map();
    for (const row of candidateRows) {
      const acct = String(
        row['Sender'] || row['sender'] ||
        row['Account Used'] || row['account used'] || ''
      ).trim();
      if (!acct) {
        unmatched.set('(blank)', (unmatched.get('(blank)') || 0) + 1);
        continue;
      }
      const pid = nameToId[acct];
      if (!pid) {
        unmatched.set(acct, (unmatched.get(acct) || 0) + 1);
        continue;
      }
      if (!leadsByProfile.has(pid)) leadsByProfile.set(pid, []);
      leadsByProfile.get(pid).push(row);
    }

    if (leadsByProfile.size === 0) {
      let msg;
      if (candidateRows.length === 0) {
        msg = 'No rows in Sent stage found — nothing to check.';
      } else {
        const names = [...unmatched.entries()]
          .map(([n, c]) => `${n} (${c})`)
          .slice(0, 5)
          .join(', ');
        msg = `Found ${candidateRows.length} row(s) in Sent stage, but no GoLogin profile in this workspace matches the sender(s): ${names}.`;
      }
      return res.status(400).json({
        error: msg,
        unmatched: Object.fromEntries(unmatched),
      });
    }

    checkDms.running = true;
    checkDms._abort = false;
    checkDms.startedAt = Date.now();
    checkDms.repliesFound = 0;
    checkDms.errors = [];
    checkDms.currentProfile = null;
    checkDms._lastResults = null;

    const owner = req.user;

    preventSleep('check-dms');
    // Fire and forget
    (async () => {
      const byProfile = {};
      const ambiguous = [];
      try {
        for (const [profileId, leads] of leadsByProfile.entries()) {
          if (checkDms._abort) break;
          checkDms.currentProfile = profileId;
          const result = await checkProfileDmsPerLead(profileId, leads, {
            sheetUrl,
            linkedinColumn: linkedinColumn || 'Linkedin URL',
            shouldAbort: () => checkDms._abort,
            // 2.9.7: surface diagnostic lines to the Live Status log panel
            // (which polls campaign.logs on /api/campaign/status). The
            // check-dms vs campaign mutex makes mixing safe.
            log: (line) => {
              const stamped = `[${new Date().toISOString()}] ${line}`;
              campaign.logs.push(stamped);
              if (campaign.logs.length > 500) campaign.logs.shift();
            },
          });
          byProfile[profileId] = result.replies || [];
          // Inbound count drives the headline metric the operator sees.
          checkDms.repliesFound += (result.replies || []).filter(r => r.inbound).length;
          if (Array.isArray(result.ambiguous)) ambiguous.push(...result.ambiguous.map(a => ({ ...a, profileId })));
          if (Array.isArray(result.errors) && result.errors.length) {
            checkDms.errors.push(...result.errors.map(e => `[${profileId}] ${e}`));
          }
        }
        checkDms._lastResults = { byProfile, ambiguous, completedAt: Date.now() };
        notifyEmail(owner, {
          title: 'Check DMs finished',
          body: `Check DMs finished: ${checkDms.repliesFound} new reply(ies), ${checkDms.errors.length} error(s).`,
          link: '/',
        }).catch(() => {});
      } catch (err) {
        console.error('Check DMs error:', err.message);
        checkDms.errors.push(err.message);
      } finally {
        checkDms.running = false;
        checkDms.currentProfile = null;
        allowSleep();
      }
    })();

    res.json({
      ok: true,
      message: 'Check DMs started',
      profiles: leadsByProfile.size,
      threads: candidateRows.length,
      unmatched: Object.fromEntries(unmatched),
    });
  } catch (err) {
    console.error('Check DMs start error:', err.message);
    checkDms.running = false;
    res.status(500).json({ error: err.message });
  }
});

// 2.9.7: Preview endpoint — same shape as /api/check-status/preview so the
// dashboard can render coverage bars before the operator clicks Start.
app.get('/api/check-dms/preview', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'url query param required' });

    const [rows, profiles] = await Promise.all([
      fetchSheet(url),
      (async () => {
        try {
          const token = process.env.GOLOGIN_API_TOKEN;
          if (!token) return [];
          return await getProfiles(token);
        } catch { return []; }
      })(),
    ]);

    const knownNames = new Set(profiles.map(p => p.name));
    const LOCAL_BROWSER_NAMES = new Set(['You', 'Local Browser', 'local-browser', 'local-browser - manual']);
    const hasStageSchema = rows.length > 0 && ('Stage' in rows[0]);

    const byAccount = {};
    const unmatched = {};
    let totalThreads = 0;
    for (const row of rows) {
      // Same filter as the start route — only rows we have a thread for.
      if (hasStageSchema) {
        const stage = String(row.Stage || '').trim();
        if (!CHECK_DMS_STAGE_FILTER.has(stage)) continue;
      } else {
        if (String(row.Message || '').trim().toLowerCase() !== 'sent') continue;
      }
      const acct = String(
        row['Sender'] || row['sender'] ||
        row['Account Used'] || row['account used'] || ''
      ).trim();
      if (!acct) continue;
      totalThreads++;
      if (LOCAL_BROWSER_NAMES.has(acct)) {
        byAccount['You'] = (byAccount['You'] || 0) + 1;
      } else if (knownNames.has(acct)) {
        byAccount[acct] = (byAccount[acct] || 0) + 1;
      } else {
        unmatched[acct] = (unmatched[acct] || 0) + 1;
      }
    }

    // Rough estimate: ~12s per thread (nav + settle + scrape).
    const runtimeSeconds = totalThreads * 12;

    res.json({
      totalPending: totalThreads,
      byAccount: Object.entries(byAccount).map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count),
      unmatched: Object.entries(unmatched).map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count),
      accountsCount: Object.keys(byAccount).length,
      runtimeSeconds,
    });
  } catch (err) {
    console.error('Check DMs preview error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/check-dms/stop', (_req, res) => {
  checkDms._abort = true;
  res.json({ ok: true, message: 'Abort requested' });
});

app.get('/api/check-dms/status', (_req, res) => {
  res.json({
    running: checkDms.running,
    currentProfile: checkDms.currentProfile,
    repliesFound: checkDms.repliesFound,
    errors: checkDms.errors,
    startedAt: checkDms.startedAt,
  });
});

app.get('/api/check-dms/replies', (_req, res) => {
  res.json(checkDms._lastResults || { byProfile: {}, ambiguous: [], completedAt: null });
});

// ---------------------------------------------------------------------------
// Post Amplification (v2.12.x — Phase 2). Sequential per-account engagement
// on a single LinkedIn post URL. Mutually exclusive with campaign + check-dms
// (same Orbita process pool). Own dedup state at data/post-amplification-state.json.
// ---------------------------------------------------------------------------
const postAmp = {
  running: false,
  _abort: false,
  startedAt: null,
  completedAt: null,
  postUrl: null,
  total: 0,
  completed: 0,
  engaged: 0,
  skippedDedup: 0,
  errors: [],
  currentIndex: 0,
  currentProfile: null,
  // Tail of log lines surfaced through the same /api/campaign/status payload
  // the Live Status panel polls — so the operator sees progress without
  // adding a second polling loop.
  logs: [],
};

function pushPostAmpLog(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  postAmp.logs.push(stamped);
  if (postAmp.logs.length > 300) postAmp.logs.shift();
  // Mirror to campaign.logs so the existing Live Status panel renders it
  // without extra UI plumbing — the campaign vs post-amp mutex makes this
  // unambiguous (only one of them is running at a time).
  campaign.logs.push(stamped);
  if (campaign.logs.length > 500) campaign.logs.shift();
}

app.post('/api/post-amplification/start', async (req, res) => {
  try {
    if (campaign.running) return res.status(409).json({ error: 'Campaign is running — stop it first' });
    if (checkDms.running) return res.status(409).json({ error: 'Check DMs is running — stop it first' });
    if (postAmp.running) return res.status(409).json({ error: 'Post Amplification is already running' });

    const { postUrl, accountConfigs, name } = req.body || {};
    if (!postUrl || !/linkedin\.com\/posts\/[^/]+/.test(postUrl)) {
      return res.status(400).json({ error: 'postUrl required (linkedin.com/posts/<slug>-<id>)' });
    }
    if (!Array.isArray(accountConfigs) || accountConfigs.length === 0) {
      return res.status(400).json({ error: 'accountConfigs required' });
    }
    // Filter to actionable configs server-side so the engine doesn't waste
    // browser launches on accounts the operator left fully unchecked.
    const actionable = accountConfigs.filter(c => {
      if (!c || !c.profileId) return false;
      const hasComment = !!c.comment && (c.commentText || '').trim().length > 0;
      return c.like || hasComment;
    });
    if (actionable.length === 0) {
      return res.status(400).json({ error: 'No accounts have Like or a non-empty Comment configured.' });
    }

    // Reset state for this run.
    postAmp.running = true;
    postAmp._abort = false;
    postAmp.startedAt = Date.now();
    postAmp.completedAt = null;
    postAmp.postUrl = postUrl;
    postAmp.total = actionable.length;
    postAmp.completed = 0;
    postAmp.engaged = 0;
    postAmp.skippedDedup = 0;
    postAmp.errors = [];
    postAmp.currentIndex = 0;
    postAmp.currentProfile = null;
    postAmp.logs = [];

    const owner = req.user;
    const startedAt = postAmp.startedAt;
    const campaignName = (name || '').trim() || 'Post Amplification';

    preventSleep('post-amplification');
    pushPostAmpLog(`=== Post Amplification starting · ${actionable.length} account(s) · ${postUrl} ===`);

    // Fire-and-forget so the HTTP request returns immediately.
    (async () => {
      let endReason = 'completed';
      try {
        await runPostAmplification({
          postUrl,
          accountConfigs: actionable,
          status: postAmp,
          shouldAbort: () => postAmp._abort,
          log: pushPostAmpLog,
        });
        if (postAmp._abort) endReason = 'stopped';
        else if (postAmp.errors.length > 0 && postAmp.engaged === 0) endReason = 'errored';
      } catch (err) {
        console.error('[post-amp] orchestrator threw:', err.message);
        postAmp.errors.push(err.message);
        endReason = 'errored';
      } finally {
        postAmp.completedAt = Date.now();
        postAmp.running = false;
        allowSleep();

        // Append to history so it shows in the past-campaigns dashboard.
        try {
          let history = [];
          try { history = JSON.parse(await readFile(HISTORY_PATH, 'utf8')); } catch { /* */ }
          history.push({
            date: new Date(startedAt).toISOString(),
            name: campaignName,
            mode: 'post_amplification',
            profiles: actionable.map(c => c.profileName || c.profileId),
            dailyLimit: actionable.length,
            totalProcessed: postAmp.completed,
            successCount: postAmp.engaged,
            errorCount: postAmp.errors.length,
            duration: Math.round((postAmp.completedAt - startedAt) / 1000),
            templateNames: [],
            endReason,
            settings: {
              profileIds: actionable.map(c => c.profileId),
              postAmplification: {
                postUrl,
                accountConfigs: actionable.map(c => ({
                  profileId: c.profileId,
                  profileName: c.profileName,
                  like: !!c.like,
                  comment: !!c.comment,
                  commentText: c.commentText || '',
                })),
              },
            },
          });
          await writeFile(HISTORY_PATH, JSON.stringify(history, null, 2));
        } catch (err) {
          console.warn(`[post-amp] history append failed: ${err.message}`);
        }

        notifyEmail(owner, {
          title: `Post Amplification ${endReason}`,
          body: `Engaged ${postAmp.engaged}/${postAmp.total} · skipped ${postAmp.skippedDedup} · errors ${postAmp.errors.length}`,
          link: '/',
        }).catch(() => {});
        pushPostAmpLog(`=== Post Amplification ${endReason} · engaged ${postAmp.engaged}/${postAmp.total} · skipped-dedup ${postAmp.skippedDedup} · errors ${postAmp.errors.length} ===`);
      }
    })();

    res.json({
      ok: true,
      message: 'Post Amplification started',
      total: actionable.length,
    });
  } catch (err) {
    console.error('[post-amp] start error:', err.message);
    postAmp.running = false;
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/post-amplification/stop', (_req, res) => {
  postAmp._abort = true;
  res.json({ ok: true, message: 'Abort requested' });
});

app.get('/api/post-amplification/status', (_req, res) => {
  res.json({
    running: postAmp.running,
    postUrl: postAmp.postUrl,
    total: postAmp.total,
    completed: postAmp.completed,
    engaged: postAmp.engaged,
    skippedDedup: postAmp.skippedDedup,
    errors: postAmp.errors,
    currentIndex: postAmp.currentIndex,
    currentProfile: postAmp.currentProfile,
    startedAt: postAmp.startedAt,
    completedAt: postAmp.completedAt,
  });
});

// ---------------------------------------------------------------------------
// Campaign presets — whole-campaign snapshots (mode, sheet, accounts, templates,
// rate, limits, etc.) so operators can reload a full setup with one click.
// Stored globally (team-shared); "last used" is per-user.
// Shape of data/presets.json: { presets: { name: { config, meta } }, last_used: { email: { config, meta } } }
// ---------------------------------------------------------------------------
const PRESETS_PATH = dataPath('presets.json');

async function loadPresetsFile() {
  try {
    const raw = await readFile(PRESETS_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      presets: parsed.presets || {},
      last_used: parsed.last_used || {},
    };
  } catch {
    return { presets: {}, last_used: {} };
  }
}

async function savePresetsFile(data) {
  await mkdir(dirname(PRESETS_PATH), { recursive: true });
  await writeFile(PRESETS_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

app.get('/api/presets', async (_req, res) => {
  const file = await loadPresetsFile();
  // Return just the presets map with a small summary per entry.
  const summary = {};
  for (const [name, entry] of Object.entries(file.presets)) {
    summary[name] = {
      name,
      mode: entry.config?.mode || null,
      profileCount: (entry.config?.profileIds || []).length,
      createdBy: entry.createdBy || null,
      updatedAt: entry.updatedAt || entry.createdAt || null,
    };
  }
  res.json(summary);
});

app.get('/api/presets/:name', async (req, res) => {
  const file = await loadPresetsFile();
  const name = req.params.name;
  if (name === '_last_used') {
    const last = file.last_used[req.user];
    if (!last) return res.status(404).json({ error: 'No last-used preset for this operator' });
    return res.json(last);
  }
  const entry = file.presets[name];
  if (!entry) return res.status(404).json({ error: 'Preset not found' });
  res.json(entry);
});

app.post('/api/presets', async (req, res) => {
  try {
    const { name, config } = req.body || {};
    if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name required' });
    if (!config || typeof config !== 'object') return res.status(400).json({ error: 'config required' });
    const cleanName = name.trim();
    if (!cleanName) return res.status(400).json({ error: 'name cannot be empty' });

    const file = await loadPresetsFile();
    const existing = file.presets[cleanName];
    const now = new Date().toISOString();
    file.presets[cleanName] = {
      config,
      createdBy: existing?.createdBy || req.user,
      createdAt: existing?.createdAt || now,
      updatedBy: req.user,
      updatedAt: now,
    };
    await savePresetsFile(file);
    res.json({ saved: true, name: cleanName });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/presets/:name', async (req, res) => {
  try {
    const file = await loadPresetsFile();
    delete file.presets[req.params.name];
    await savePresetsFile(file);
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save current campaign config as "last used" for the current operator.
// Called automatically by the client right before starting a campaign.
app.post('/api/presets/_last_used', async (req, res) => {
  try {
    const { config } = req.body || {};
    if (!config || typeof config !== 'object') return res.status(400).json({ error: 'config required' });
    const file = await loadPresetsFile();
    file.last_used[req.user] = {
      config,
      savedAt: new Date().toISOString(),
    };
    await savePresetsFile(file);
    res.json({ saved: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Templates (save/load named template sets)
// ---------------------------------------------------------------------------
const TEMPLATES_PATH = dataPath('templates.json');

async function loadTemplates() {
  try {
    const raw = await readFile(TEMPLATES_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveTemplates(data) {
  await mkdir(dirname(TEMPLATES_PATH), { recursive: true });
  await writeFile(TEMPLATES_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

app.get('/api/templates', async (_req, res) => {
  const templates = await loadTemplates();
  res.json(templates);
});

app.post('/api/templates', async (req, res) => {
  try {
    const { name, templates: tpl } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });

    const all = await loadTemplates();
    all[name] = tpl;
    await saveTemplates(all);
    res.json({ saved: true, name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/templates/:name', async (req, res) => {
  try {
    const all = await loadTemplates();
    delete all[req.params.name];
    await saveTemplates(all);
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Schedules (node-cron persistence + CRUD)
// ---------------------------------------------------------------------------
const SCHEDULES_PATH = dataPath('schedules.json');
const activeJobs = new Map(); // id -> cron job instance

async function loadSchedules() {
  try {
    const raw = await readFile(SCHEDULES_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function saveSchedules(data) {
  await mkdir(dirname(SCHEDULES_PATH), { recursive: true });
  await writeFile(SCHEDULES_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

function shiftCronMinutes(cronExpr, deltaMinutes) {
  const parts = cronExpr.split(' ');
  if (parts.length !== 5) return null;
  const [mnStr, hrStr, dom, mon, dow] = parts;
  let minute = parseInt(mnStr, 10);
  let hour = parseInt(hrStr, 10);
  if (isNaN(minute) || isNaN(hour)) return null;
  minute += deltaMinutes;
  while (minute < 0) { minute += 60; hour -= 1; }
  while (minute >= 60) { minute -= 60; hour += 1; }
  while (hour < 0) hour += 24;
  while (hour >= 24) hour -= 24;
  return `${minute} ${hour} ${dom} ${mon} ${dow}`;
}

function registerSchedule(schedule) {
  // Stop existing jobs for this schedule (main + pre-fire)
  if (activeJobs.has(schedule.id)) {
    const { main, prefire } = activeJobs.get(schedule.id);
    main?.stop();
    prefire?.stop();
  }
  if (!schedule.enabled) return;
  if (!cron.validate(schedule.cron)) {
    console.error(`[scheduler] Invalid cron for schedule "${schedule.name}": ${schedule.cron}`);
    return;
  }

  // Pre-fire heads-up (5 minutes before) — sent to the creator of the schedule
  const preExpr = shiftCronMinutes(schedule.cron, -5);
  let prefire = null;
  if (preExpr && cron.validate(preExpr)) {
    prefire = cron.schedule(preExpr, () => {
      const [mn, hr] = schedule.cron.split(' ');
      const timeStr = `${String(hr).padStart(2, '0')}:${String(mn).padStart(2, '0')}`;
      const target = schedule.createdBy;
      (target ? notifyEmail(target, {
        title: 'Scheduled campaign starting soon',
        body: `${schedule.name} will start at ${timeStr} (in ~5 min).`,
        link: '/',
      }) : notifyAll({
        title: 'Scheduled campaign starting soon',
        body: `${schedule.name} will start at ${timeStr} (in ~5 min).`,
        link: '/',
      })).catch(() => {});
    });
  }

  // Main fire
  const main = cron.schedule(schedule.cron, async () => {
    console.log(`[scheduler] Firing schedule "${schedule.name}" (owner: ${schedule.createdBy || 'none'})`);
    const notify = (payload) => schedule.createdBy
      ? notifyEmail(schedule.createdBy, payload)
      : notifyAll(payload);

    notify({
      title: 'Campaign started',
      body: `${schedule.name} is running now on ${schedule.profileIds.length} account(s).`,
      link: '/',
    }).catch(() => {});
    preventSleep(`schedule:${schedule.name}`);
    try {
      await startCampaign({
        profileIds: schedule.profileIds,
        sheetUrl: schedule.sheetUrl,
        templates: schedule.templates || {},
        dailyLimit: schedule.dailyLimit || 50,
        mode: schedule.mode || 'connect_only',
        delayMin: schedule.delayMin,
        delayMax: schedule.delayMax,
        createdBy: schedule.createdBy || null,
      });
      const all = await loadSchedules();
      const s = all.find(x => x.id === schedule.id);
      if (s) { s.lastRun = new Date().toISOString(); await saveSchedules(all); }

      const status = getCampaignStatus();
      notify({
        title: 'Campaign finished',
        body: `${schedule.name}: ${status.processedToday || 0} actions, ${(status.errors || []).length} error(s).`,
        link: '/',
      }).catch(() => {});
    } catch (err) {
      console.error(`[scheduler] Schedule "${schedule.name}" failed:`, err.message);
      notify({
        title: 'Campaign failed',
        body: `${schedule.name} failed: ${err.message}`,
        link: '/',
      }).catch(() => {});
    } finally {
      allowSleep();
    }
  });
  activeJobs.set(schedule.id, { main, prefire });
}

// Schedule CRUD (D-03)
app.get('/api/schedules', async (_req, res) => {
  const schedules = await loadSchedules();
  res.json(schedules);
});

app.post('/api/schedules', async (req, res) => {
  try {
    const { name, cron: cronExpr, profileIds, sheetUrl, mode, templates, dailyLimit, delayMin, delayMax, enabled } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    if (!cronExpr || !cron.validate(cronExpr)) return res.status(400).json({ error: 'valid cron expression required' });
    if (!profileIds?.length) return res.status(400).json({ error: 'profileIds required' });
    if (!sheetUrl) return res.status(400).json({ error: 'sheetUrl required' });

    const all = await loadSchedules();
    // P-06 fix (2.8.18): validate any client-supplied id against the expected
    // shape (sched_<digits>). Without this, the client can inject arbitrary
    // strings — including ones that break out of the single-quote-delimited
    // onclick attribute in app.js:2409 and produce stored XSS in the schedules
    // panel. Reject anything not matching the canonical shape.
    let id;
    if (req.body.id) {
      if (!/^sched_\d+$/.test(req.body.id)) {
        return res.status(400).json({ error: 'invalid schedule id' });
      }
      id = req.body.id;
    } else {
      id = `sched_${Date.now()}`;
    }
    const existing = all.findIndex(s => s.id === id);
    const schedule = {
      id, name, cron: cronExpr, profileIds, sheetUrl,
      mode: mode || 'connect_only', templates: templates || {},
      dailyLimit: dailyLimit || 50,
      delayMin, delayMax,
      enabled: enabled !== false, lastRun: null,
      // P-06 fix (2.8.18): never trust req.body.createdBy — that lets a
      // logged-in user spoof schedule ownership and redirect notification
      // emails to other operators. createdBy is always derived from req.user
      // (set by the auth middleware from the session cookie). For updates,
      // preserve the existing owner.
      createdBy: existing >= 0 ? (all[existing].createdBy || req.user) : req.user,
    };
    if (existing >= 0) { all[existing] = { ...all[existing], ...schedule }; }
    else { all.push(schedule); }
    await saveSchedules(all);
    registerSchedule(schedule);
    res.json({ saved: true, schedule });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/schedules/:id', async (req, res) => {
  try {
    const all = await loadSchedules();
    const filtered = all.filter(s => s.id !== req.params.id);
    if (activeJobs.has(req.params.id)) {
      const { main, prefire } = activeJobs.get(req.params.id);
      main?.stop();
      prefire?.stop();
      activeJobs.delete(req.params.id);
    }
    await saveSchedules(filtered);
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Campaign history (D-11)
// ---------------------------------------------------------------------------
const HISTORY_PATH = dataPath('history.json');

// v2.60.0 — Added optional ?includeArchived=false to hide soft-archived
// entries. Default behaviour (no query param) is unchanged: returns ALL
// entries, including archived, so existing callers keep working.
// v2.76: extract a Google Sheet id from its URL (…/spreadsheets/d/<id>/…).
function _sheetIdFromUrl(url) {
  const m = String(url || '').match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : '';
}

// v2.76: collect every still-active background schedule (reply + bulk) and
// attach a `monitoring` summary to each history entry so the Past view can show
// "still monitoring · Nd left" and offer an on/off toggle.
async function _activeScheduleEntries() {
  const now = Date.now();
  let reply = [], bulk = [];
  try { reply = await listReplyCheckSchedule(); } catch { /* */ }
  try { bulk = await listPostCampaignSchedule(); } catch { /* */ }
  return [...reply, ...bulk].filter((e) => e && (!e.expiresAt || now < e.expiresAt));
}

function _monitoringForEntry(entry, active) {
  const sid = _sheetIdFromUrl(entry?.settings?.sheetUrl);
  const pids = entry?.settings?.profileIds || [];
  if (!sid || pids.length === 0) return { active: false, count: 0, expiresAt: null };
  const pidSet = new Set(pids);
  const matches = active.filter((e) => e.sheetId === sid && pidSet.has(e.profileId));
  const maxExp = matches.reduce((m, e) => Math.max(m, e.expiresAt || 0), 0);
  return { active: matches.length > 0, count: matches.length, expiresAt: maxExp || null };
}

app.get('/api/history', async (req, res) => {
  try {
    const includeArchived = req.query.includeArchived !== 'false';
    const list = await listHistory({ includeArchived });
    const active = await _activeScheduleEntries();
    for (const entry of list) {
      try { entry.monitoring = _monitoringForEntry(entry, active); }
      catch { entry.monitoring = { active: false, count: 0, expiresAt: null }; }
    }
    res.json(list);
  } catch {
    res.json([]);
  }
});

// v2.76: turn a Past campaign's background tracking (reply + accept checks)
// on or off from the Past view. off → remove the schedule entries (browsers
// stop reopening). on → re-register reply tracking for its accounts.
app.post('/api/history/:idx/monitoring', async (req, res) => {
  try {
    const idx = Number(req.params.idx);
    const on = !!(req.body && req.body.on);
    if (!Number.isInteger(idx) || idx < 0) return res.status(400).json({ error: 'Invalid idx' });
    const list = await listHistory({ includeArchived: true });
    const entry = list[idx];
    if (!entry) return res.status(404).json({ error: 'No such history entry' });
    const sheetUrl = entry?.settings?.sheetUrl || '';
    const sheetId = _sheetIdFromUrl(sheetUrl);
    const profileIds = entry?.settings?.profileIds || [];
    if (!sheetId || profileIds.length === 0) {
      return res.status(400).json({ error: 'Campaign has no sheet/accounts to track' });
    }

    if (!on) {
      const removed = (await removeReplySchedules(sheetId, profileIds))
                    + (await removeBulkSchedules(sheetId, profileIds));
      return res.json({ ok: true, on: false, removed });
    }

    // Re-enable: register reply tracking for each account. Resolve names so the
    // scheduler's name→id step works; best-effort if GoLogin is unreachable.
    let idToName = {};
    try {
      const profiles = await getProfiles(process.env.GOLOGIN_API_TOKEN);
      for (const p of profiles) idToName[p.id] = p.name;
    } catch { /* names optional */ }
    const linkedinColumn = entry?.settings?.linkedinColumn || '';
    const days = entry?.settings?.acceptanceTrackingDays || 7;
    const operatorEmail = (await readSessionFromRequest(req)) || null;
    let added = 0;
    for (const pid of profileIds) {
      await registerReplySchedule({
        sheetId, sheetUrl, profileId: pid,
        profileName: idToName[pid] || pid,
        linkedinColumn, days, operatorEmail,
      });
      added++;
    }
    return res.json({ ok: true, on: true, added });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/history', async (_req, res) => {
  try {
    await writeFile(HISTORY_PATH, '[]', 'utf-8');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// v2.11.8: delete a single past-campaign entry by index. :idx is the on-disk
// index in history.json (the dashboard preserves it across the newest-first
// sort), matching the convention the rename endpoint already uses.
app.delete('/api/history/:idx', async (req, res) => {
  try {
    const idx = Number(req.params.idx);
    if (!Number.isInteger(idx) || idx < 0) return res.status(400).json({ error: 'Invalid idx' });
    let history = [];
    try { history = JSON.parse(await readFile(HISTORY_PATH, 'utf-8')); } catch { /* empty */ }
    if (!Array.isArray(history) || idx >= history.length) {
      return res.status(404).json({ error: 'No such history entry' });
    }
    history.splice(idx, 1);
    await writeFile(HISTORY_PATH, JSON.stringify(history, null, 2), 'utf-8');
    res.json({ ok: true, remaining: history.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// v2.11.8: batch delete. Accepts { indexes: [int, ...] }. Sorts descending
// before splicing so removing earlier indexes doesn't shift later ones.
// Single-shot replacement of history.json — no partial-state risk.
app.post('/api/history/delete-batch', async (req, res) => {
  try {
    const { indexes } = req.body || {};
    if (!Array.isArray(indexes) || indexes.some(n => !Number.isInteger(n) || n < 0)) {
      return res.status(400).json({ error: 'indexes must be an array of non-negative integers' });
    }
    let history = [];
    try { history = JSON.parse(await readFile(HISTORY_PATH, 'utf-8')); } catch { /* empty */ }
    if (!Array.isArray(history)) history = [];
    // Dedupe + sort descending so each splice doesn't invalidate later targets.
    const sorted = [...new Set(indexes)].sort((a, b) => b - a);
    let deleted = 0;
    for (const i of sorted) {
      if (i < history.length) {
        history.splice(i, 1);
        deleted++;
      }
    }
    await writeFile(HISTORY_PATH, JSON.stringify(history, null, 2), 'utf-8');
    res.json({ ok: true, deleted, remaining: history.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Rename a past-campaign entry by its index in history.json. Index, not id,
// because legacy entries don't have ids. Sort order on the dashboard matches
// the on-disk array so :idx maps cleanly to what the operator clicked.
app.patch('/api/history/:idx/name', async (req, res) => {
  try {
    const idx = Number(req.params.idx);
    if (!Number.isInteger(idx) || idx < 0) return res.status(400).json({ error: 'Invalid idx' });
    const { name } = req.body || {};
    if (typeof name !== 'string') return res.status(400).json({ error: 'name must be a string' });

    let history = [];
    try { history = JSON.parse(await readFile(HISTORY_PATH, 'utf-8')); } catch { /* empty */ }
    if (!Array.isArray(history) || idx >= history.length) {
      return res.status(404).json({ error: 'No such history entry' });
    }
    history[idx].name = name.trim();
    await writeFile(HISTORY_PATH, JSON.stringify(history, null, 2), 'utf-8');
    res.json({ ok: true, name: history[idx].name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// v2.60.0 — Rerun a finished campaign by enqueuing a copy of its stored
// settings. The on-disk index :idx maps 1:1 to history.json (oldest-first).
// Logic lives in src/history-helpers.js#relaunchHistoryEntry — this route
// is a pure HTTP translator (result code → status code). Returns 422 when
// the history entry pre-dates the settings-capture change and has no
// rerunnable config.
app.post('/api/history/:idx/relaunch', async (req, res) => {
  try {
    const idx = Number(req.params.idx);
    const result = await relaunchHistoryEntry(idx);
    if (!result.ok) {
      if (result.code === 'invalid_idx') return res.status(400).json({ error: 'Invalid idx' });
      if (result.code === 'out_of_range') return res.status(404).json({ error: 'No such history entry' });
      if (result.code === 'missing_settings') return res.status(422).json({ error: 'history_entry_missing_settings' });
      return res.status(500).json({ error: 'unknown_error' });
    }
    // Operator expectation: rerun behaves like /api/campaign/start —
    // start immediately when idle, queue when a campaign is already
    // running. relaunchHistoryEntry always queues (FIFO-safe); we drain
    // the head here so an idle app fires the rerun right away instead of
    // leaving it parked in the queue.
    let started = false;
    if (!campaign.running) {
      try {
        await runNextFromQueue();
        started = true;
      } catch (err) {
        console.error('[history] Rerun drain failed:', err.message);
      }
    }
    res.json({
      ok: true,
      queueId: result.entry.id,
      started,
      queued: !started,
      message: started
        ? `Starting "${result.entry.name}" now`
        : `Queued "${result.entry.name}" — will start when current campaign finishes`,
      entry: result.entry,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// v2.60.0 — Soft-archive a past campaign so it disappears from the
// dashboard's "Past" section without losing the underlying history record.
// Pair with GET /api/history?includeArchived=false to hide it from the UI.
app.patch('/api/history/:idx/archive', async (req, res) => {
  try {
    const idx = Number(req.params.idx);
    const result = await archiveHistoryEntry(idx);
    if (!result.ok) {
      if (result.code === 'invalid_idx') return res.status(400).json({ error: 'Invalid idx' });
      if (result.code === 'out_of_range') return res.status(404).json({ error: 'No such history entry' });
      return res.status(500).json({ error: 'unknown_error' });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// v2.60.0 — Per-campaign filtered slice of data/campaign.log. The dashboard
// v0.3 Past dock "Open log" action calls this to show what a finished run
// actually did without dumping the entire shared log. Capped at last 500
// matching lines for UI responsiveness; { lines, name, total } in body.
app.get('/api/history/:idx/log', async (req, res) => {
  try {
    const idx = Number(req.params.idx);
    const result = await readCampaignLog(idx);
    if (!result.ok) {
      if (result.code === 'invalid_idx') return res.status(400).json({ error: 'Invalid idx' });
      if (result.code === 'out_of_range') return res.status(404).json({ error: 'No such history entry' });
      return res.status(500).json({ error: 'unknown_error' });
    }
    res.json({ lines: result.lines, name: result.name, total: result.total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// CSV export (D-13, D-14, D-15)
// ---------------------------------------------------------------------------
const STATE_PATH = dataPath('state.json');

app.get('/api/export/csv', async (_req, res) => {
  try {
    let state;
    try {
      state = JSON.parse(await readFile(STATE_PATH, 'utf-8'));
    } catch {
      return res.status(404).json({ error: 'No campaign data found' });
    }

    const processed = state.processed || {};
    const entries = Object.entries(processed);
    if (!entries.length) {
      return res.status(404).json({ error: 'No processed leads to export' });
    }

    // CSV header
    const columns = ['LinkedIn URL', 'Profile Used', 'Action', 'Date'];
    const rows = [columns.join(',')];

    for (const [url, data] of entries) {
      const row = [
        `"${url}"`,
        `"${(data.profileName || data.profileId || '').replace(/"/g, '""')}"`,
        `"${(data.action || '').replace(/"/g, '""')}"`,
        `"${data.date || ''}"`,
      ];
      rows.push(row.join(','));
    }

    const csv = rows.join('\n');
    const filename = `campaign-export-${new Date().toISOString().slice(0, 10)}.csv`;

    res.set('Content-Type', 'text/csv');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
app.listen(PORT, async () => {
  console.log(`\n  ✦ Ortus Outreach v${APP_VERSION}`);
  console.log(`  ✦ Dashboard: http://localhost:${PORT}`);
  startAmbientSampling(getActiveBrowserPids);
  console.log(`  ✦ GoLogin token: ${process.env.GOLOGIN_API_TOKEN ? '✓ loaded' : '✗ MISSING'}`);
  console.log(`  ✦ Sheet tracking: ✓ centralized (Antonio's Apps Script)`);

  await initNotifier();
  console.log(`  ✦ Notifications: ${process.env.SMTP_HOST ? 'email enabled' : 'email DISABLED — set SMTP_HOST/PORT/USER/PASS + NOTIFY_EMAILS'}\n`);

  // Post-campaign sweeps power the CC+IC auto-intro DM (and bulk-check
  // refresh for any other registered entry). Each tick respects per-entry
  // cooldown + 7-day expiry; runAutoIntros only fires for entries that
  // carry primaryName/primaryIntroBody, so Check Status-only entries are
  // bulk-checked but never DM'd.
  startPostCampaignScheduler();
  // v2.72: hourly reply tracking for message-sending campaigns (never in the
  // first hour, ≤1×/hour per account). Writes replies to the sheet + the
  // in-app replies panel; desktop/email alerts are opt-in.
  startReplyCheckScheduler();

  // Load and register saved schedules (D-05)
  loadSchedules().then(schedules => {
    for (const s of schedules) registerSchedule(s);
    if (schedules.length) console.log(`  ✦ Schedules: ${schedules.filter(s => s.enabled).length} active of ${schedules.length} total`);
  }).catch(err => console.error('Failed to load schedules:', err.message));

  // v2.14 — resume any in-flight monitoring state from disk before the watcher
  // starts, so the campaign global is populated on the first watcher tick.
  resumeMonitoringFromDisk()
    .then((r) => {
      if (r.action !== 'noop') console.log('[boot] monitoring:', r.action);
    })
    .catch((err) => console.warn('[boot] monitoring resume failed:', err.message));

  // v2.14 — start the T+7d monitoring auto-end watcher
  startMonitoringWatcher();

  // v2.91 — drain primary-side automation tasks (auto-accept + first follow-up)
  // in idle gaps, one browser at a time, gated on the global browser semaphore.
  startPrimaryTaskRunner();

  // Drain the campaign queue at startup. If the server crashed/restarted
  // while items were queued, this auto-promotes the next one to active so
  // the operator doesn't have to re-trigger anything.
  setTimeout(() => {
    runNextFromQueue().catch(err => console.error('Startup queue drain failed:', err.message));
  }, 1000);
});

// ---------------------------------------------------------------------------
// Disk-status endpoint (Phase 2.8.20 / W3-C2) — read-only free-bytes check.
// ---------------------------------------------------------------------------
app.get('/api/disk-status', async (_req, res) => {
  const status = await checkDiskFree();
  res.json(status);
});

// ---------------------------------------------------------------------------
// Persisted errors endpoint (Phase 2.8.20 / W1-B2) — read-only.
// Returns the contents of data/errors.log.json (empty array if missing).
// ---------------------------------------------------------------------------
app.get('/api/errors', async (_req, res) => {
  try {
    const raw = await readFile(dataPath('errors.log.json'), 'utf8');
    const arr = JSON.parse(raw);
    res.json(Array.isArray(arr) ? arr : []);
  } catch (_) {
    res.json([]);
  }
});

app.get('/api/warnings', async (_req, res) => {
  try {
    const buf = await readFile(dataPath('warnings-log.ndjson'), 'utf-8').catch(() => '');
    const lines = buf.split('\n').filter(Boolean);
    const warnings = lines
      .slice(-200)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
    res.json({ warnings });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// ---------------------------------------------------------------------------
// Notification status endpoint (Phase 2.8.19 / C4) — read-only check of SMTP
// configuration so the sidebar Notifications panel can show "wired" /
// "not configured" without dialing out.
// ---------------------------------------------------------------------------
app.get('/api/notify/status', (_req, res) => {
  res.json({ smtpConfigured: !!process.env.SMTP_HOST });
});

// Per-operator notification preferences (sidebar toggles).
app.get('/api/notification-prefs', async (req, res) => {
  try {
    const prefs = await getNotificationPrefs(req.user);
    res.json({ ok: true, prefs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/notification-prefs', async (req, res) => {
  try {
    const patch = req.body || {};
    const next = await setNotificationPrefs(req.user, patch);
    res.json({ ok: true, prefs: next });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// v2.58.x — per-operator preferences (timezone today). Stored locally,
// keyed by the signed-in email. Campaign launcher's tz becomes the
// stamping authority for sheet timestamps (Apps Script honours it when
// present, falls back to project timezone otherwise).
app.get('/api/operator-prefs', async (req, res) => {
  try {
    const prefs = await getOperatorPrefs(req.user);
    res.json({ ok: true, prefs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/operator-prefs', async (req, res) => {
  try {
    const patch = req.body || {};
    // tz is the only field for now; pass-through validation lives here so
    // garbage strings can't reach the bot. Empty string is allowed and means
    // "no preference" (skip the modal next time, fall back to GAS default).
    if (patch.tz !== undefined && typeof patch.tz !== 'string') {
      return res.status(400).json({ error: 'tz must be a string' });
    }
    const next = await setOperatorPrefs(req.user, patch);
    res.json({ ok: true, prefs: next });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Per-machine operator identity — the email stamped as the reserver in the SoO
// 'CC User App' column. Mandatory: campaign start is gated on it (see below),
// because the shared dashboard login can't identify who's actually operating.
app.get('/api/operator-identity', (req, res) => {
  const email = getOperatorEmail();
  res.json({ ok: true, email, set: !!email });
});

app.post('/api/operator-identity', (req, res) => {
  try {
    const email = (req.body && req.body.email != null) ? String(req.body.email).trim() : '';
    if (!email || !isPlausibleEmail(email)) {
      return res.status(400).json({ error: 'A valid email is required.' });
    }
    const saved = setOperatorEmail(email);
    res.json({ ok: true, email: saved, set: !!saved });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Renderer poll: pull recent desktop notifications since the last poll.
// Filters by the signed-in operator so other operators' personal reminders
// don't appear in this user's tab. Items with audience=null are broadcast.
app.get('/api/notifications/recent', (req, res) => {
  const since = Number.parseInt(req.query.since, 10) || 0;
  const items = getRecentNotifications({ sinceTs: since, audience: req.user });
  res.json({ items, now: Date.now() });
});

// ---------------------------------------------------------------------------
// Notification test endpoint — sends a test email to configured recipients
// ---------------------------------------------------------------------------
app.post('/api/notify/test', async (req, res) => {
  try {
    const result = await notifyEmail(req.user, {
      title: 'Ortus test notification',
      body: 'If you see this, email notifications are wired up correctly.',
      link: '/',
    });
    res.json({ ok: true, recipient: req.user, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Dev tools — Preview intro DM (pure text, no LinkedIn interaction)
// Fetches the first row from the configured sheet, runs personalizeTemplate
// with the same data dict that auto-intro uses, and returns the resolved body
// + title so the operator can catch stale placeholders before a campaign run.
// ---------------------------------------------------------------------------
app.post('/api/preview-intro-dm', async (req, res) => {
  try {
    const { sheetUrl, introBody, primaryName, primaryUrl, introTitle } = req.body || {};
    if (!sheetUrl)    return res.status(400).json({ error: 'sheetUrl required' });
    if (!introBody)   return res.status(400).json({ error: 'introBody required' });
    if (!primaryName) return res.status(400).json({ error: 'primaryName required' });

    const { personalizeTemplate } = await import('./src/linkedin/helpers.js');
    const { fetchSheet }          = await import('./src/sheets.js');

    let rows = [];
    try {
      rows = await fetchSheet(sheetUrl);
    } catch (e) {
      return res.status(400).json({ error: `Sheet fetch failed: ${e.message}` });
    }

    if (!rows.length) {
      return res.status(400).json({ error: 'Sheet has no rows' });
    }

    // Use the first row as the sample lead.
    const row = rows[0];

    // Mirror the introData dict built in outreach.js (case 'message', introMode).
    // The row is spread verbatim so raw column names (e.g. "First Name") resolve
    // directly; we also add normalised lowercase-spaced aliases that operators
    // typically write in their body copy.
    const introTokens = String(primaryName).trim().split(/\s+/);
    const introFirst  = introTokens[0] || '';
    const introLast   = introTokens.slice(1).join(' ');

    const data = {
      // Raw row — resolves whatever casing the operator actually used as a header
      ...row,
      // Normalised aliases for the most common lead name placeholders
      'first name': (row['First Name'] || row['first name'] || row['firstName'] || row['first_name'] || '').trim(),
      'last name':  (row['Last Name']  || row['last name']  || row['lastName']  || row['last_name']  || '').trim(),
      'name':       (row['Name']       || row['name']       || '').trim() ||
                    `${(row['First Name'] || row['first name'] || '').trim()} ${(row['Last Name'] || row['last name'] || '').trim()}`.trim(),
      'company':    (row['Company']    || row['company']    || '').trim(),
      // Primary / intro person tokens — all naming variants accepted by outreach.js
      'primary name': primaryName,
      'primary url':  primaryUrl || '',
      'intro name':       primaryName,
      'introName':        primaryName,
      'intro_name':       primaryName,
      'intro first name': introFirst,
      'introFirstName':   introFirst,
      'intro_first_name': introFirst,
      'intro last name':  introLast,
      'introLastName':    introLast,
      'intro_last_name':  introLast,
    };

    const resolvedBody  = personalizeTemplate(introBody, data);
    const resolvedTitle = personalizeTemplate(
      introTitle || 'Introduction: {first name} <> {intro name}',
      data
    );

    // Surface any remaining unresolved placeholders as a warning.
    const bodyLeftovers  = resolvedBody.match(/\{[^}]+\}/g)  || [];
    const titleLeftovers = resolvedTitle.match(/\{[^}]+\}/g) || [];
    const unresolvedPlaceholders = [...new Set([...bodyLeftovers, ...titleLeftovers])];

    res.json({
      ok: true,
      sampleLead: {
        firstName: data['first name'],
        lastName:  data['last name'],
        company:   data['company'],
      },
      resolvedTitle,
      resolvedBody,
      primaryName,
      primaryUrl: primaryUrl || '',
      unresolvedPlaceholders,
    });
  } catch (err) {
    console.error('[preview-intro-dm] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// v2.14.x — Diagnostic: navigate a URL inside a specific GoLogin profile and
// report what URL the page ACTUALLY ends up on (after redirects + JS-driven
// nav). Built to investigate the Sales-Nav redirect issue: paste the
// /messaging/compose/?recipient=… URL, see if LinkedIn server-side reroutes
// to /sales/lead/…, capture a screenshot of where we landed.
//
// Usage from terminal (port shows on dev:app boot — currently 61044):
//   curl -X POST http://localhost:<PORT>/api/diagnostic/navigate \
//     -H 'Content-Type: application/json' \
//     -d '{"profileEmail":"marife.espeleta@ortus.solutions","url":"https://www.linkedin.com/messaging/compose/?recipient=hannah-gywneth-samson-085a83378"}'
//
// Response includes the inputUrl we asked for, finalUrl after redirects,
// the full transition list (every URL the main frame visited), title,
// whether Sales Nav was detected, and a screenshot path. Refuses to run if
// a campaign is currently active so it doesn't fight for the semaphore.
// ---------------------------------------------------------------------------
app.post('/api/diagnostic/navigate', async (req, res) => {
  if (campaign.running) {
    return res.status(409).json({ error: 'A campaign is currently running. Stop it first to use the diagnostic.' });
  }
  const { profileEmail, profileId: profileIdRaw, url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url required' });
  if (!profileEmail && !profileIdRaw) {
    return res.status(400).json({ error: 'profileEmail or profileId required' });
  }
  const token = process.env.GOLOGIN_API_TOKEN;
  let profileId = profileIdRaw;
  let resolvedFromEmail = null;
  if (!profileId && profileEmail) {
    try {
      const allProfiles = await getProfiles(token);
      const match = allProfiles.find((p) => String(p.name || '').toLowerCase() === String(profileEmail).toLowerCase());
      if (!match) {
        return res.status(404).json({ error: `Profile not found for email: ${profileEmail}` });
      }
      profileId = match.id;
      resolvedFromEmail = match.name;
    } catch (err) {
      return res.status(500).json({ error: `Profile resolution failed: ${err.message}` });
    }
  }

  const { closeProfile: _closeProfile } = await import('./src/gologin-launcher.js');

  let launched;
  try {
    launched = await launchProfile(profileId, token);
  } catch (err) {
    return res.status(500).json({ error: `Launch failed: ${err.message}` });
  }
  const page = launched.page;

  const transitions = [];
  const navListener = (frame) => {
    try {
      if (frame === page.mainFrame()) {
        transitions.push({ at: new Date().toISOString(), url: frame.url() });
      }
    } catch { /* */ }
  };
  page.on('framenavigated', navListener);

  let navError = null;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (err) {
    navError = err.message;
  }
  // Let any client-side / meta-refresh redirects play out.
  await new Promise(r => setTimeout(r, 5000));

  let finalUrl = '';
  let title = '';
  try { finalUrl = page.url(); } catch { /* */ }
  try { title = await page.title(); } catch { /* */ }

  // Screenshot for visual confirmation of where we landed.
  const ts = Date.now();
  const screenshotPath = `/tmp/ortus-diagnose-${ts}.png`;
  try {
    await page.screenshot({ path: screenshotPath, fullPage: false });
  } catch (e) {
    console.warn(`[diagnostic] screenshot failed: ${e.message}`);
  }

  // Capture the visible DOM landmarks — different LinkedIn surfaces have
  // distinct top-bar markers. Helps identify Sales Nav vs regular UI.
  let landmarks = {};
  try {
    landmarks = await page.evaluate(() => {
      const out = {};
      out.hasSalesNavBar  = !!document.querySelector('#sales-nav-app-banner, .global-nav__nav, [data-control-name*="sales"]');
      out.hasMessagingForm = !!document.querySelector('.msg-form__contenteditable, div[role="textbox"][aria-label*="Write a message" i]');
      out.hasSalesCompose = !!document.querySelector('.lead-message-form, .ml-message-form, .msg-overlay-list-bubble');
      out.bodyTextSample  = (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      return out;
    });
  } catch { /* */ }

  page.off('framenavigated', navListener);
  try { await _closeProfile(profileId); } catch { /* */ }

  res.json({
    profileEmail: profileEmail || resolvedFromEmail,
    profileId,
    inputUrl: url,
    finalUrl,
    redirected: !!finalUrl && finalUrl !== url,
    salesNavDetected: !!finalUrl && finalUrl.includes('/sales/'),
    transitionCount: transitions.length,
    transitions,
    title,
    landmarks,
    navError,
    screenshotPath,
  });
});

// ---------------------------------------------------------------------------
// Phase 2.8.20 (W1-C1) — fatal-error sink. Sync write because the process is
// already dying — async writes risk being dropped before the event loop ends.
// Line-delimited JSON (NDJSON) keeps appends cheap and partial-write-safe.
// ---------------------------------------------------------------------------
function appendFatalErrorSync(entry) {
  try {
    const line = JSON.stringify(entry) + '\n';
    appendFileSync(dataPath('fatal-errors.log'), line);
  } catch (_) { /* truly nothing left to do */ }
}

// ---------------------------------------------------------------------------
// Graceful shutdown — close GoLogin profiles on SIGINT/SIGTERM (REL-03)
// ---------------------------------------------------------------------------
async function gracefulShutdown(signal) {
  console.log(`\n[shutdown] ${signal} received. Shutting down... waiting for current lead`);
  stopCampaign();

  // Wait for current lead to finish (campaign loop checks _abort between leads)
  const deadline = Date.now() + 30000;
  while (campaign.running && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500));
  }

  const count = await closeAllProfiles();
  await closeLocalBrowser();
  console.log(`[shutdown] Closing ${count} profiles...`);
  // Drain the central Operations Log buffer before exit — otherwise the last
  // 0–30s of buffered events (the ones not yet auto-flushed) are lost on every
  // quit/relaunch. Timeout-guarded so a dead network can't hang shutdown.
  try {
    await Promise.race([flushOpsLog(), new Promise((r) => setTimeout(r, 4000))]);
  } catch (_) { /* fire-and-forget */ }
  console.log('[shutdown] Done.');
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Phase 2.8.20 (W1-C1) — catch crashes that would otherwise leave orphan
// browsers and skip the cloud-commit phase. Writes a fatal-error line
// synchronously, then runs the same graceful shutdown path.
process.on('uncaughtException', (err) => {
  appendFatalErrorSync({
    at: new Date().toISOString(),
    kind: 'uncaughtException',
    message: err && err.message ? err.message : String(err),
    stack:   err && err.stack   ? err.stack   : '',
  });
  console.error(`[fatal] uncaughtException: ${err && err.message}`);
  gracefulShutdown('FATAL').catch(() => process.exit(1));
});
process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  const stack   = reason instanceof Error ? reason.stack   : '';
  appendFatalErrorSync({
    at: new Date().toISOString(),
    kind: 'unhandledRejection',
    message,
    stack,
  });
  console.error(`[fatal] unhandledRejection: ${message}`);
  gracefulShutdown('FATAL').catch(() => process.exit(1));
});
