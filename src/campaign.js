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
import { readFile, writeFile } from 'node:fs/promises';
import { launchProfile, closeProfile, getProfiles } from './gologin-launcher.js';
import { launchLocalBrowser, closeLocalBrowser } from './local-launcher.js';
import { fetchSheet as fetchSheetRows } from './sheets.js';
import { updateSheetRow } from './sheets-writer.js';
import { performOutreach } from './linkedin/outreach.js';

const STATE_FILE = './data/state.json';
const HISTORY_PATH = './data/history.json';
const SUCCESS_ACTIONS = new Set(['connection_sent', 'message_sent', 'inmail_sent', 'already_processed', 'status_accepted', 'status_pending', 'status_declined']);

async function appendHistory(entry) {
  let history = [];
  try { history = JSON.parse(await readFile(HISTORY_PATH, 'utf8')); } catch { /* first run */ }
  history.push(entry);
  await writeFile(HISTORY_PATH, JSON.stringify(history, null, 2));
}

if (!existsSync('./data')) mkdirSync('./data');

async function loadState() {
  try { return JSON.parse(await readFile(STATE_FILE, 'utf8')); }
  catch { return { processed: {}, dailyCounts: {} }; }
}
async function saveState(s) { await writeFile(STATE_FILE, JSON.stringify(s, null, 2)); }

// Campaign-scoped counters — reset every time a campaign starts
const campaignCounts = {};

function getCampaignCount(profileId) {
  return campaignCounts[profileId] || 0;
}
function bumpCampaignCount(profileId) {
  campaignCounts[profileId] = (campaignCounts[profileId] || 0) + 1;
}

function extractLinkedInUrl(row) {
  for (const key of ['LinkedIn URL', 'linkedinUrl', 'linkedin_url', 'url', 'LinkedIn', 'Profile URL']) {
    const v = row[key];
    if (v && v.includes('linkedin.com/in/')) return v.trim();
  }
  return null;
}

function getModeHint(mode, prevAction) {
  if (mode === 'connect_only') return 'force_connect';
  if (mode === 'message_only') return 'force_message';
  if (mode === 'check_status') return 'check_only';
  if (mode === 'inmail_only') return 'force_inmail';
  if (mode === 'connect_and_message') {
    return prevAction === 'connection_sent' ? 'force_message' : 'force_connect';
  }
  return null;
}

// ── Campaign state (exposed to dashboard) ──
export const campaign = {
  running: false,
  _abort: false,
  currentProfile: null,
  processedToday: 0,
  totalProcessed: 0,
  logs: [],
  errors: [],
};

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  campaign.logs.push(line);
  if (campaign.logs.length > 500) campaign.logs.shift();
}
function pushError(err) {
  campaign.errors.push({ time: new Date().toISOString(), message: err.message });
  if (campaign.errors.length > 100) campaign.errors.shift();
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
// Profile health check (REL-04) — verifies LinkedIn session before leads
// ═══════════════════════════════════════════════════════════════════════════

async function checkProfileHealth(page, profileName) {
  const issues = [];

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

// ═══════════════════════════════════════════════════════════════════════════
// Main campaign runner
// ═══════════════════════════════════════════════════════════════════════════

export async function startCampaign({ profileIds, sheetUrl, templates, dailyLimit = 40, mode = 'connect_only', messageOpenProfiles = false, delayMin = 15, delayMax = 45 }) {
  if (campaign.running) throw new Error('Campaign already running');

  campaign.running = true;
  campaign._abort = false;
  campaign.currentProfile = null;
  campaign.processedToday = 0;
  campaign.totalProcessed = 0;
  campaign.totalTargets = 0;
  campaign.mode = mode;
  campaign.profileNames = [];
  campaign.errors = [];

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
  };

  const campaignStartTime = Date.now();

  try {
    log('=== Campaign starting ===');
    log(`Mode: ${mode}`);
    log(`Profiles: ${profileIds.length} selected`);
    log(`Daily limit: ${dailyLimit}`);
    log(`Templates: note=${tpl.connectionNote ? '✓' : '—'} followUp=${tpl.followUpMessage ? '✓' : '—'} inmail=${tpl.inmail.subject ? '✓' : '—'}`);
    if (messageOpenProfiles) log('Open Profile messaging: ON');

    // ── Fetch leads from Google Sheet ──
    log('Fetching sheet…');
    const rows = await fetchSheetRows(sheetUrl);
    log(`${rows.length} row(s). Columns: ${Object.keys(rows[0] || {}).join(', ')}`);

    // Ensure tracking columns exist
    const sheetId = sheetUrl.match(/\/d\/([^/]+)/)?.[1];
    if (sheetId) {
      await updateSheetRow(sheetUrl, '__ensure_columns__', {}).catch(() => {});
    }

    const state = await loadState();

    // Pre-filter targets
    const targets = rows.filter(row => {
      const url = extractLinkedInUrl(row);
      if (!url) return false;

      const sheetStatus = (row['Connection Status'] || row['connectionStatus'] || '').toLowerCase();
      const msgStatus = (row['First Message Status'] || row['firstMessageStatus'] || '').toLowerCase();

      if (mode === 'check_status') {
        // Only check leads where we sent a connection request
        return sheetStatus.includes('sent') && !sheetStatus.includes('accepted') && !sheetStatus.includes('declined');
      }

      if (mode === 'message_only') {
        // Only message leads that accepted and haven't been messaged
        return (sheetStatus.includes('accepted') || sheetStatus.includes('connected')) && !msgStatus.includes('sent');
      }

      if (mode === 'connect_only' || mode === 'auto') {
        const prev = state.processed[url];
        if (prev) return false;
        if (sheetStatus.includes('sent') || sheetStatus.includes('pending') || sheetStatus.includes('connected') || sheetStatus.includes('accepted')) return false;
        return true;
      }

      if (mode === 'connect_and_message') {
        if (!sheetStatus && !state.processed[url]) return true;
        if ((sheetStatus.includes('accepted') || sheetStatus.includes('connected')) && !msgStatus.includes('sent')) return true;
        return false;
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

    // ── ROUND-ROBIN: Open ALL profiles, then rotate 1 lead per profile ──
    // Instead of processing all leads per profile sequentially, we cycle:
    // Account 1 → lead 1, Account 2 → lead 2, ... Account N → lead N, then repeat
    // This spreads activity evenly and looks more natural to LinkedIn.

    if (profileIds.length > 3) {
      log(`⚠ RAM warning: ${profileIds.length} browsers will be open simultaneously. 4 is fine, 10+ may slow your machine.`);
    }

    // STEP 1: Open all browsers and run health checks
    const activeSessions = []; // { profileId, pName, browser, page }

    for (const profileId of profileIds) {
      if (campaign._abort) break;

      const pName = profileNameCache[profileId] || profileId;
      campaign.currentProfile = pName;

      try {
        log(`▶ Opening ${pName}…`);
        let launched;
        if (profileId === 'local-browser') {
          launched = await launchLocalBrowser();
        } else {
          launched = await launchProfile(profileId, token);
        }

        let page = launched.page;

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
              continue;
            }
            log(`✓ Local Browser: logged in! Moving window off-screen.`);
            try {
              const client = await page.target().createCDPSession();
              const { windowId } = await client.send('Browser.getWindowForTarget');
              await client.send('Browser.setWindowBounds', { windowId, bounds: { left: -2400, top: -2400 } });
            } catch { /* */ }
          } else {
            log(`WARNING: ${pName} failed health check: ${health.issues.join(', ')}. Skipping.`);
            try { await launched.browser.close().catch(() => {}); await closeProfile(profileId); } catch { /* */ }
            continue;
          }
        }
        log(`${pName} health check passed.`);

        // Warmup
        log(`⏳ ${pName}: waiting 20s on home page…`);
        await new Promise(r => setTimeout(r, 20000));
        log(`✓ ${pName} warmup done.`);

        activeSessions.push({ profileId, pName, browser: launched.browser, page });
      } catch (err) {
        log(`✗ ${pName}: failed to open — ${err.message}`);
        pushError(err);
      }
    }

    if (activeSessions.length === 0) {
      log('✗ No healthy profiles available. Campaign cannot proceed.');
    } else {
      log(`\n✓ ${activeSessions.length} profile(s) ready. Starting round-robin…\n`);

      // STEP 2: Round-robin lead processing
      let leadIndex = 0;
      let totalDone = 0;
      const weeklyLimited = new Set(); // Profiles that hit weekly limit

      while (!campaign._abort) {
        // Check if all profiles have reached their daily limit or are weekly-limited
        const activeProfiles = activeSessions.filter(s =>
          getCampaignCount(s.profileId) < dailyLimit && !weeklyLimited.has(s.profileId)
        );
        if (activeProfiles.length === 0) {
          log('All profiles reached their campaign limit or weekly limit.');
          break;
        }

        // Find the next unprocessed lead
        let row = null;
        while (leadIndex < targets.length) {
          const candidate = targets[leadIndex];
          const candidateUrl = extractLinkedInUrl(candidate);
          leadIndex++;
          if (!candidateUrl) continue;
          if (mode !== 'check_status' && mode !== 'message_only' && state.processed[candidateUrl]) continue;
          const sheetStatus = (candidate['Connection Status'] || candidate['connectionStatus'] || '').toLowerCase();
          if (mode === 'connect_only' || mode === 'auto') {
            if (sheetStatus.includes('sent') || sheetStatus.includes('pending') || sheetStatus.includes('connected') || sheetStatus.includes('accepted')) continue;
          }
          row = candidate;
          break;
        }

        if (!row) {
          log('All leads processed or filtered out.');
          break;
        }

        // Pick the next profile in rotation (round-robin among active profiles)
        const session = activeProfiles[totalDone % activeProfiles.length];
        const { profileId, pName, browser } = session;
        let { page } = session;

        campaign.currentProfile = pName;

        const url = extractLinkedInUrl(row);

        // Mark as in-progress
        state.processed[url] = { profileId, profileName: pName, action: '_in_progress', date: new Date().toISOString() };
        await saveState(state);

        // Mode-aware skip logic for message_only and check_status
        const sheetStatus = (row['Connection Status'] || row['connectionStatus'] || '').toLowerCase();
        const msgStatus = (row['First Message Status'] || row['firstMessageStatus'] || '').toLowerCase();

        if (mode === 'message_only') {
          if (msgStatus.includes('sent')) { delete state.processed[url]; continue; }
          if (!sheetStatus.includes('accepted') && !sheetStatus.includes('connected')) { delete state.processed[url]; continue; }
          const connectedBy = (row['Connection By'] || row['connectionBy'] || '').toLowerCase().replace(/[\s._@-]+/g, '');
          const normalizedPName = pName.toLowerCase().replace(/[\s._@-]+/g, '');
          if (connectedBy && !connectedBy.includes(normalizedPName) && !normalizedPName.includes(connectedBy)) {
            delete state.processed[url]; continue;
          }
        } else if (mode === 'check_status') {
          if (sheetStatus.includes('accepted') || sheetStatus.includes('declined')) { delete state.processed[url]; continue; }
        }

        // Build template data
        const data = { ...row };
        data.firstName = row['First Name'] || row['firstName'] || row['first_name'] || '';
        data.lastName = row['Last Name'] || row['lastName'] || row['last_name'] || '';
        data.company = row['Company'] || row['company'] || '';
        data.title = row['Title'] || row['title'] || row['Job Title'] || '';

        let hint = getModeHint(mode, state.processed[url]?.action);

        const isOpenProfile = (row['Open Profile'] || row['openProfile'] || row['open_profile'] || '').toLowerCase().trim();
        if (messageOpenProfiles && isOpenProfile === 'yes' && hint === 'force_connect') {
          hint = 'force_message';
          log(`  ↳ Open Profile detected — will message directly`);
        }

        try {
          // Re-acquire page before each lead
          try {
            const pages = await browser.pages();
            if (pages.length > 0) page = pages[pages.length - 1];
            session.page = page;
          } catch { /* keep current */ }

          log(`→ [${pName}] ${url} (${data.firstName || '?'}) [${hint || 'auto'}]`);

          // performOutreach with retry
          let result;
          const MAX_RETRIES = 3;
          for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            result = await performOutreach(page, url, { ...tpl, data }, {}, hint);

            const isTransient = result.action === 'skipped' && result.error &&
              !result.error.includes('WEEKLY_LIMIT') &&
              !result.error.includes('EMAIL_REQUIRED') &&
              !result.error.includes('Login page') &&
              !result.error.includes('Already connected') &&
              !result.error.includes('Not yet connected') &&
              !result.error.includes('Still pending') &&
              !result.error.includes('Can connect directly') &&
              !result.error.includes('No message template') &&
              !result.error.includes('SEND_NOT_CONFIRMED');

            if (!isTransient || attempt === MAX_RETRIES) break;

            const backoff = attempt * 5000;
            log(`  ⟳ Retry ${attempt}/${MAX_RETRIES} in ${backoff / 1000}s — ${result.error}`);
            await new Promise(r => setTimeout(r, backoff));

            try {
              const pages = await browser.pages();
              if (pages.length > 0) { page = pages[pages.length - 1]; session.page = page; }
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

            const sheetData = {};
            if (result.action === 'connection_sent') {
              sheetData.connectionStatus = 'Sent';
              sheetData.connectionDate = now;
              sheetData.connectionBy = pName;
            } else if (result.action === 'message_sent') {
              sheetData.firstMessageStatus = (messageOpenProfiles && isOpenProfile === 'yes') ? 'Sent (Open Profile)' : 'Sent';
              sheetData.firstMessageDate = now;
            } else if (result.action === 'inmail_sent') {
              sheetData.connectionStatus = 'InMail Sent';
              sheetData.connectionDate = now;
              sheetData.connectionBy = pName;
            } else if (result.action === 'status_accepted') {
              sheetData.connectionStatus = 'Accepted';
              sheetData.connectionDate = now;
            } else if (result.action === 'status_pending') {
              sheetData.connectionStatus = 'Still Pending';
            } else if (result.action === 'status_declined') {
              sheetData.connectionStatus = 'Declined';
              sheetData.connectionDate = now;
            }
            await updateSheetRow(sheetUrl, url, sheetData).catch(() => {});

            log(`  ✓ [${pName}] (${getCampaignCount(profileId)}/${dailyLimit})`);
          } else {
            const errorMsg = result.error || result.action;

            if (errorMsg.includes('WEEKLY_LIMIT')) {
              log(`  ⚠ WEEKLY LIMIT reached for ${pName}. Removing from rotation.`);
              weeklyLimited.add(profileId);
              await updateSheetRow(sheetUrl, url, {
                connectionStatus: `SKIPPED: Weekly invitation limit reached`,
                connectionDate: now,
                connectionBy: pName,
              }).catch(() => {});
            } else if (errorMsg.includes('EMAIL_REQUIRED')) {
              log(`  ⚠ Email required for ${data.firstName || '?'}. Skipping lead.`);
              state.processed[url] = { profileId, profileName: pName, action: 'email_required', date: now };
              await saveState(state);
              await updateSheetRow(sheetUrl, url, {
                connectionStatus: `SKIPPED: Email required to connect`,
                connectionDate: now,
                connectionBy: pName,
              }).catch(() => {});
            } else {
              log('  ✗ Retry next run.');
              pushError(new Error(`${url}: ${errorMsg}`));
              delete state.processed[url];
              await saveState(state);
              await updateSheetRow(sheetUrl, url, {
                connectionStatus: `FAILED: ${errorMsg}`,
                connectionDate: now,
                connectionBy: pName,
              }).catch(() => {});
            }
          }

          // Delay between leads + session breaks (interruptible by abort)
          if (!campaign._abort) {
            const SESSION_BREAK_EVERY = 15;
            let waitMs;
            if (totalDone > 0 && totalDone % SESSION_BREAK_EVERY === 0) {
              const breakMin = 10 * 60 * 1000;
              const breakMax = 20 * 60 * 1000;
              waitMs = Math.floor(Math.random() * (breakMax - breakMin + 1) + breakMin);
              log(`  ☕ Session break: ${(waitMs / 60000).toFixed(0)} min (${totalDone} leads processed across all accounts)`);
            } else {
              waitMs = Math.floor(Math.random() * (delayMax - delayMin + 1) + delayMin) * 1000;
              log(`  ⏳ ${(waitMs / 1000).toFixed(0)}s`);
            }
            // Sleep in 2s chunks so abort is checked frequently
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
      }

      // Log per-profile stats
      for (const s of activeSessions) {
        log(`■ ${s.pName}: ${getCampaignCount(s.profileId)} processed.`);
      }
    }

    // STEP 3: Close all browsers (with 2-minute timeout)
    log('Closing all browsers...');
    const closeTimeout = setTimeout(() => {
      log('⚠ Browser close timed out after 2 minutes. Force-ending campaign.');
    }, 120000);

    for (const session of activeSessions) {
      try {
        if (session.profileId === 'local-browser') {
          await closeLocalBrowser();
        } else {
          const pages = await session.browser.pages();
          for (const p of pages) {
            try { await p.close(); } catch { /* */ }
          }
          await session.browser.close().catch(() => {});
          await closeProfile(session.profileId);
        }
        log(`✓ ${session.pName} browser closed.`);
      } catch (e) {
        log(`Close ${session.pName}: ${e.message}`);
      }
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
  }
}

export function stopCampaign() {
  campaign._abort = true;
  log('■ Stop requested.');
}

export function getCampaignStatus() {
  return {
    running: campaign.running,
    currentProfile: campaign.currentProfile,
    processedToday: campaign.processedToday,
    totalProcessed: campaign.totalProcessed,
    totalTargets: campaign.totalTargets || 0,
    mode: campaign.mode || '',
    profileNames: campaign.profileNames || [],
    logs: campaign.logs.slice(-100),
    errors: campaign.errors.slice(-20),
  };
}
