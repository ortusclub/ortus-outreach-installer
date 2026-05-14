import 'dotenv/config';

// ── Startup env validation (D-06) ──────────────────────────────────
const REQUIRED_ENV = ['GOLOGIN_API_TOKEN', 'SHEETS_WEBAPP_URL'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`\n  FATAL: Missing required environment variables:\n${missing.map(k => '    - ' + k).join('\n')}\n\n  Copy .env.example to .env and fill in all values.\n`);
  process.exit(1);
}

import express from 'express';
import cookieParser from 'cookie-parser';
import cron from 'node-cron';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startCampaign, stopCampaign, pauseCampaign, resumeCampaign, restoreCampaign, getCampaignStatus, setCampaignName, retryParkedProfile, campaign, extractLinkedInUrl, log as campaignLog, startMonitoringWatcher, stopMonitoringWatcher, stopMonitoring, resumeMonitoringFromDisk } from './src/campaign.js';
import { getQueue, addToQueue, removeFromQueue, moveInQueue, popNext as popNextQueued } from './src/campaign-queue.js';
import { getDrafts, getDraft, addDraft, updateDraft, removeDraft } from './src/drafts.js';
import { startScheduler as startPostCampaignScheduler, listSchedule as listPostCampaignSchedule } from './src/post-campaign-bulk-check.js';
import { startAmbientSampling } from './src/resource-monitor.js';
import { personalizeTemplate } from './src/linkedin/helpers.js';
import { checkProfileDms, checkProfileDmsPerLead } from './src/linkedin/check-dms.js';
import { runAmplification as runPostAmplification } from './src/linkedin/post-amplification.js';
import { fetchSheet } from './src/sheets.js';
import { getProfiles, closeAllProfiles, getActiveBrowserPids, getProfilePid, launchProfile } from './src/gologin-launcher.js';
import { closeLocalBrowser } from './src/local-launcher.js';
import { unhideByPids } from './src/mac-window.js';
import { preventSleep, allowSleep } from './src/caffeinate.js';
import { initNotifier, notifyAll, notifyEmail, getRecentNotifications } from './src/notifier.js';
import { getPrefs as getNotificationPrefs, setPrefs as setNotificationPrefs } from './src/notification-prefs.js';
import { fetchSoOData } from './src/soo.js';
import { dataPath } from './src/paths.js';
import { checkDiskFree } from './src/disk-check.js';
import {
  createUser, verifyCredentials, userExists,
  issueSessionCookie, clearSessionCookie, readSessionFromRequest,
  isEmailAllowed,
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
  '/api/health',
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
      return res.status(503).json({ error: `Could not verify email against State of Operations: ${err.message}` });
    }
    if (!allowed) return res.status(403).json({ error: 'This email is not in the State of Operations — ask an admin to add you.' });

    await createUser(normalized, password);
    await issueSessionCookie(res, normalized);
    res.json({ ok: true, email: normalized });
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
      return res.status(503).json({ error: `Could not verify email against State of Operations: ${err.message}` });
    }
    if (!allowed) return res.status(403).json({ error: 'This email is not in the State of Operations — ask an admin to add you.' });

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
  res.json({ ok: true, time: new Date().toISOString(), version: APP_VERSION });
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

    const previews = picked.map(({ row, url }) => {
      // Mirror campaign.js:603-612 data construction.
      const data = { ...row };
      data.firstName = row['First Name'] || row['firstName'] || row['first_name'] || '';
      data.lastName  = row['Last Name']  || row['lastName']  || row['last_name']  || '';
      data.company   = row['Company']    || row['company']   || '';
      data.title     = row['Title']      || row['title']     || row['Job Title']  || '';
      data.senderName = pName || '';
      const resolvedFirst = senderFirstNames[profileId];
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
// runs with exactly the same shape as a directly-launched one.
function buildCampaignConfig(body) {
  const { profileIds, sheetUrl, templates, dailyLimit, mode, messageOpenProfiles,
          delayMin, delayMax, linkedinColumn, senderFirstNames, concurrency, name,
          acceptanceTrackingDays, preflightCheckStatus } = body || {};
  let concurrencyClean = 1;
  if (Number.isFinite(Number(concurrency)) && Number(concurrency) >= 2) {
    const n = Math.min(5, Number(concurrency));
    if ((profileIds?.length || 0) >= 5) concurrencyClean = n;
  }
  return {
    profileIds,
    sheetUrl,
    templates: templates || {},
    dailyLimit: Number(dailyLimit),
    mode: mode || 'auto',
    messageOpenProfiles: !!messageOpenProfiles,
    delayMin: delayMin ? Number(delayMin) : undefined,
    delayMax: delayMax ? Number(delayMax) : undefined,
    linkedinColumn: linkedinColumn || '',
    senderFirstNames: senderFirstNames || {},
    concurrency: concurrencyClean,
    name: typeof name === 'string' ? name : '',
    acceptanceTrackingDays: Math.max(0, Math.min(30, Number(acceptanceTrackingDays) || 0)),
    // Honoured only when mode is message_only or introduce_back. campaign.js
    // gates further so other modes silently ignore the flag.
    preflightCheckStatus: !!preflightCheckStatus,
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

    launchCampaign(config, owner);
    res.json({ ok: true, message: 'Campaign started' });
  } catch (err) {
    console.error('Campaign start error:', err.message);
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

app.post('/api/campaign/stop', async (req, res) => {
  // v2.14.x: optional `{ full: true }` body opts out of the
  // connect_and_introduce post-campaign sweep + auto-intros. Default
  // behaviour is unchanged (Stop sending, keep monitoring) — relevant only
  // when the running campaign is mode=connect_and_introduce.
  const fullHalt = !!(req.body && req.body.full);
  const result = stopCampaign({ full: fullHalt });
  // Phase 2.8.9: force-close all Orbita/local browsers immediately so the
  // operator sees them disappear rather than waiting for the loop to wind down.
  // Errors here are non-fatal — the loop's own cleanup is idempotent.
  try { await closeAllProfiles(); } catch (err) { console.warn('[stop] closeAllProfiles:', err.message); }
  try { await closeLocalBrowser(); } catch (err) { console.warn('[stop] closeLocalBrowser:', err.message); }
  res.json(result);
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

// Manual bulk-check trigger from the wizard. Bypasses the 6h cooldown so
// the operator can on-demand sweep their sheet for newly-accepted invites.
// Refuses to run while a campaign is active to avoid GoLogin contention.
app.post('/api/bulk-check-now', async (req, res) => {
  try {
    if (campaign.running) {
      return res.status(409).json({ error: 'A campaign is currently running. Wait for it to finish or stop it first.' });
    }
    const { sheetUrl, linkedinColumn, profileId, profileIds,
            primaryName, primaryIntroBody, primaryUrl, introTitle } = req.body || {};
    if (!sheetUrl) return res.status(400).json({ error: 'sheetUrl required' });

    const token = process.env.GOLOGIN_API_TOKEN;
    const { bulkCheckConnections } = await import('./src/linkedin/bulk-check-connections.js');
    const { runAutoIntros } = await import('./src/linkedin/auto-intro.js');
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
          const v = (row['Account Used'] || row['account used'] || '').toString().trim();
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

    // Sweep each profile sequentially. Sequential because GoLogin browsers
    // are RAM-heavy and parallel launches can OOM the laptop on weak hosts.
    const perProfile = [];
    let totalMatched = 0;
    let totalStamped = 0;
    let totalFetched = 0;
    campaignLog(`📡 Manual bulk Connection Status check — sweeping ${profileIdsToSweep.length} account(s)…`);
    for (const pid of profileIdsToSweep) {
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
      let r;
      try {
        campaignLog(`📡 [${pName}] Sweeping recent connections…`);
        r = await bulkCheckConnections(launched.page, sheetUrl, linkedinColumn || '', pName);
        // If primary fields were supplied (manual button clicked from a
        // wizard with Connect + Introduce Back configured), follow up with
        // an auto-intro pass while the browser is still open.
        if (!r.error && Array.isArray(r.connectedUrls) && r.connectedUrls.length > 0
            && primaryName && primaryIntroBody) {
          try {
            await runAutoIntros({
              page: launched.page,
              profileId: pid,
              profileName: pName,
              sheetUrl,
              linkedinColumn: linkedinColumn || '',
              connectedUrls: r.connectedUrls,
              primaryName: String(primaryName).trim(),
              primaryIntroBody: String(primaryIntroBody).trim(),
              primaryUrl: String(primaryUrl || '').trim(),
              introTitle: introTitle || 'Introduction: {first name} <> {intro name}',
              log: campaignLog,
            });
          } catch (introErr) {
            campaignLog(`⚠ [${pName}] Auto-intro pass threw: ${introErr.message}`);
          }
        }
      } catch (err) {
        r = { error: `Sweep threw: ${err.message}` };
      } finally {
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
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
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

app.post('/api/drafts', async (req, res) => {
  try {
    const { name, config } = req.body || {};
    const entry = await addDraft({ name, config });
    res.json({ ok: true, draft: entry });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/drafts/:id', async (req, res) => {
  try {
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

app.get('/api/history', async (_req, res) => {
  try {
    const raw = await readFile(HISTORY_PATH, 'utf-8');
    res.json(JSON.parse(raw));
  } catch {
    res.json([]);
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
  console.log(`  ✦ Sheet tracking: ${process.env.SHEETS_WEBAPP_URL ? '✓ configured' : '✗ not configured (set SHEETS_WEBAPP_URL)'}`);

  await initNotifier();
  console.log(`  ✦ Notifications: ${process.env.SMTP_HOST ? 'email enabled' : 'email DISABLED — set SMTP_HOST/PORT/USER/PASS + NOTIFY_EMAILS'}\n`);

  // Post-campaign acceptance tracking sweeps are disabled. Operators run
  // the dedicated Check Status campaign manually when they want to refresh
  // Connected status. The scheduler module is left in the codebase but not
  // started — existing `data/post-campaign-bulk-check.json` schedules will
  // simply sit idle (no harm).

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
