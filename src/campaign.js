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

export async function startCampaign({ profileIds, sheetUrl, templates, dailyLimit = 5, mode = 'connect_only', messageOpenProfiles = false, delayMin = 8, delayMax = 15 }) {
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
    const token = getToken();
    for (const pid of profileIds) {
      await getProfileName(pid, token);
    }
    campaign.profileNames = profileIds.map(id => profileNameCache[id] || id);
    log(`${Object.keys(profileNameCache).length} profiles in cache.`);

    // ── Process each GoLogin profile sequentially ──
    for (const profileId of profileIds) {
      if (campaign._abort) break;

      const pName = profileNameCache[profileId] || profileId;
      campaign.currentProfile = pName;

      let browser = null;

      try {
        // ════════════════════════════════════════════════════
        // STEP 1: Open GoLogin profile
        // ════════════════════════════════════════════════════
        log(`▶ Opening ${pName}…`);
        const launched = await launchProfile(profileId, token);
        browser = launched.browser;

        // ════════════════════════════════════════════════════
        // STEP 2: Load LinkedIn home page
        // ════════════════════════════════════════════════════
        let page = launched.page;

        try {
          await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 30000 });
        } catch (e) {
          log(`⚠ Home nav: ${e.message}`);
        }

        // Re-acquire page (prevents detached frame)
        try {
          const pages = await browser.pages();
          if (pages.length > 0) {
            page = pages[pages.length - 1];
            await page.setViewport({ width: 1366, height: 900 });
          }
        } catch { /* keep current */ }

        // ════════════════════════════════════════════════════
        // STEP 3: Wait 20 seconds on home page
        // ════════════════════════════════════════════════════
        log('⏳ Waiting 20s on home page…');
        await new Promise(r => setTimeout(r, 20000));

        // ════════════════════════════════════════════════════
        // STEP 3b: Profile health check (D-10 through D-13)
        // ════════════════════════════════════════════════════
        log(`Checking ${pName} health...`);
        const health = await checkProfileHealth(page, pName);
        if (!health.healthy) {
          log(`WARNING: ${pName} failed health check: ${health.issues.join(', ')}. Skipping.`);
          continue;  // Skip to next profile
        }
        log(`${pName} health check passed. Starting leads...`);

        // ════════════════════════════════════════════════════
        // STEP 5: Lead processing loop
        // ════════════════════════════════════════════════════
        let done = 0;

        for (const row of targets) {
          if (campaign._abort) break;

          // Check campaign limit
          const count = getCampaignCount(profileId);
          if (count >= dailyLimit) {
            log(`${pName}: campaign limit (${dailyLimit}) reached.`);
            break;
          }

          const url = extractLinkedInUrl(row);
          if (!url) continue;

          // Re-check in case another profile processed this (or is currently processing it)
          if (mode !== 'check_status' && mode !== 'message_only' && state.processed[url]) continue;

          // Mark as in-progress to prevent concurrent profiles from picking the same lead
          state.processed[url] = { profileId, profileName: pName, action: '_in_progress', date: new Date().toISOString() };
          await saveState(state);

          // Mode-aware skip logic
          const sheetStatus = (row['Connection Status'] || row['connectionStatus'] || '').toLowerCase();
          const msgStatus = (row['First Message Status'] || row['firstMessageStatus'] || '').toLowerCase();

          if (mode === 'connect_only' || mode === 'auto') {
            if (sheetStatus.includes('sent') || sheetStatus.includes('pending') || sheetStatus.includes('connected') || sheetStatus.includes('accepted')) continue;
          } else if (mode === 'message_only') {
            if (msgStatus.includes('sent')) continue; // already messaged
            if (!sheetStatus.includes('accepted') && !sheetStatus.includes('connected')) continue; // not yet accepted
            // Sender attribution: only the account that connected can message
            // Compare normalized names — strip spaces, punctuation, lowercase
            const connectedBy = (row['Connection By'] || row['connectionBy'] || '').toLowerCase().replace(/[\s._@-]+/g, '');
            const normalizedPName = pName.toLowerCase().replace(/[\s._@-]+/g, '');
            if (connectedBy && !connectedBy.includes(normalizedPName) && !normalizedPName.includes(connectedBy)) {
              continue; // This lead was connected by a different account
            }
          } else if (mode === 'check_status') {
            if (sheetStatus.includes('accepted') || sheetStatus.includes('declined')) continue; // already checked
          }

          // Spread all sheet columns as template variables
          const data = { ...row };
          // Add normalized aliases for backwards compatibility
          data.firstName = row['First Name'] || row['firstName'] || row['first_name'] || '';
          data.lastName = row['Last Name'] || row['lastName'] || row['last_name'] || '';
          data.company = row['Company'] || row['company'] || '';
          data.title = row['Title'] || row['title'] || row['Job Title'] || '';

          let hint = getModeHint(mode, state.processed[url]?.action);

          // Open Profile: if toggle is on and sheet says "Yes", message directly instead of connecting
          const isOpenProfile = (row['Open Profile'] || row['openProfile'] || row['open_profile'] || '').toLowerCase().trim();
          if (messageOpenProfiles && isOpenProfile === 'yes' && hint === 'force_connect') {
            hint = 'force_message';
            log(`  ↳ Open Profile detected — will message directly`);
          }

          try {
            // Re-acquire page before each lead (prevents stale frame)
            try {
              const pages = await browser.pages();
              if (pages.length > 0) page = pages[pages.length - 1];
            } catch { /* keep current */ }

            log(`→ [${pName}] ${url} (${data.firstName || '?'}) [${hint || 'auto'}]`);

            // performOutreach with retry: up to 3 attempts for transient failures
            let result;
            const MAX_RETRIES = 3;
            for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
              result = await performOutreach(page, url, { ...tpl, data }, {}, hint);

              // Don't retry terminal outcomes (success, weekly limit, email required, already processed)
              const isTransient = result.action === 'skipped' && result.error &&
                !result.error.includes('WEEKLY_LIMIT') &&
                !result.error.includes('EMAIL_REQUIRED') &&
                !result.error.includes('Login page') &&
                !result.error.includes('Already connected') &&
                !result.error.includes('Not yet connected') &&
                !result.error.includes('Still pending') &&
                !result.error.includes('Can connect directly') &&
                !result.error.includes('No message template');

              if (!isTransient || attempt === MAX_RETRIES) break;

              const backoff = attempt * 5000; // 5s, 10s
              log(`  ⟳ Retry ${attempt}/${MAX_RETRIES} in ${backoff / 1000}s — ${result.error}`);
              await new Promise(r => setTimeout(r, backoff));

              // Re-acquire page before retry
              try {
                const pages = await browser.pages();
                if (pages.length > 0) page = pages[pages.length - 1];
              } catch { /* keep current */ }
            }
            log(`  ${result.action}${result.error ? ' — ' + result.error : ''}`);

            const now = new Date().toISOString();

            if (SUCCESS_ACTIONS.has(result.action)) {
              state.processed[url] = { profileId, profileName: pName, action: result.action, date: now };
              bumpCampaignCount(profileId);
              done++;
              campaign.processedToday++;
              campaign.totalProcessed = campaign.processedToday;
              await saveState(state);

              // Write success to Google Sheet
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

              log(`  ✓ (${done}/${dailyLimit})`);
            } else {
              const errorMsg = result.error || result.action;

              // ── Weekly limit → log to sheet, skip to next GoLogin profile ──
              if (errorMsg.includes('WEEKLY_LIMIT')) {
                log(`  ⚠ WEEKLY LIMIT reached for ${pName}. Skipping to next profile.`);
                await updateSheetRow(sheetUrl, url, {
                  connectionStatus: `SKIPPED: Weekly invitation limit reached`,
                  connectionDate: now,
                  connectionBy: pName,
                }).catch(() => {});
                break; // Break out of leads loop → next profile
              }

              // ── Email required → log to sheet, continue to next lead ──
              if (errorMsg.includes('EMAIL_REQUIRED')) {
                log(`  ⚠ Email required for ${data.firstName || '?'}. Skipping lead.`);
                state.processed[url] = { profileId, profileName: pName, action: 'email_required', date: now };
                await saveState(state);
                await updateSheetRow(sheetUrl, url, {
                  connectionStatus: `SKIPPED: Email required to connect`,
                  connectionDate: now,
                  connectionBy: pName,
                }).catch(() => {});
                // Continue to next lead (don't break)
              } else {
                log('  ✗ Retry next run.');
                pushError(new Error(`${url}: ${errorMsg}`));
                // Clear in-progress marker so lead can be retried next run
                delete state.processed[url];
                await saveState(state);

                // Write error to Google Sheet
                await updateSheetRow(sheetUrl, url, {
                  connectionStatus: `FAILED: ${errorMsg}`,
                  connectionDate: now,
                  connectionBy: pName,
                }).catch(() => {});
              }
            }

            // ════════════════════════════════════════════════
            // STEP 5e: Wait 10 seconds, then next lead
            // ════════════════════════════════════════════════
            if (!campaign._abort) {
              const delay = Math.floor(Math.random() * (delayMax - delayMin + 1) + delayMin) * 1000;
              log(`  ⏳ ${(delay / 1000).toFixed(0)}s`);
              await new Promise(r => setTimeout(r, delay));
            }
          } catch (err) {
            log(`  ✗ ${err.message}`);
            pushError(err);
          }
        }

        log(`■ ${pName}: ${done} processed.`);

      } catch (err) {
        log(`✗ ${pName}: ${err.message}`);
        pushError(err);
      } finally {
        // ════════════════════════════════════════════════════
        // STEP 6: Close all tabs + close GoLogin browser
        // ════════════════════════════════════════════════════
        if (browser) {
          try {
            // Close all tabs
            const pages = await browser.pages();
            for (const p of pages) {
              try { await p.close(); } catch { /* */ }
            }
            await browser.close().catch(() => {});
            await closeProfile(profileId);
            log(`✓ ${profileNameCache[profileId] || profileId} browser closed.`);
          } catch (e) {
            log(`Close: ${e.message}`);
          }
        }
      }

      // ════════════════════════════════════════════════════
      // STEP 7: Move to next GoLogin profile (immediate)
      // ════════════════════════════════════════════════════
    }
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
