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

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { launchProfile, closeProfile, getProfiles } from './gologin-launcher.js';
import { fetchSheet as fetchSheetRows } from './sheets.js';
import { updateSheetRow } from './sheets-writer.js';
import { performOutreach } from './linkedin/outreach.js';

const STATE_FILE = './data/state.json';
const SUCCESS_ACTIONS = new Set(['connection_sent', 'message_sent', 'inmail_sent', 'already_processed']);

if (!existsSync('./data')) mkdirSync('./data');

function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); }
  catch { return { processed: {}, dailyCounts: {} }; }
}
function saveState(s) { writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

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
  return process.env.GOLOGIN_TOKEN || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI2ODY1NTFmNGQwMDM4NzI3ZGRhMTQ1YTYiLCJ0eXBlIjoiZGV2Iiwiand0aWQiOiI2ODY1NTI5MjU4NDMxMjY2YzY4MWRiNTIifQ.39y1T2hJsvQUMgcETGJlvwVTZ9anhvbwo-hGDqVsZGg';
}

// ═══════════════════════════════════════════════════════════════════════════
// Main campaign runner
// ═══════════════════════════════════════════════════════════════════════════

export async function startCampaign({ profileIds, sheetUrl, templates, dailyLimit = 5, mode = 'connect_only' }) {
  if (campaign.running) throw new Error('Campaign already running');

  campaign.running = true;
  campaign._abort = false;
  campaign.currentProfile = null;
  campaign.processedToday = 0;
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

  try {
    log('=== Campaign starting ===');
    log(`Mode: ${mode}`);
    log(`Profiles: ${profileIds.length} selected`);
    log(`Daily limit: ${dailyLimit}`);
    log(`Templates: note=${tpl.connectionNote ? '✓' : '—'} followUp=${tpl.followUpMessage ? '✓' : '—'} inmail=${tpl.inmail.subject ? '✓' : '—'}`);

    // ── Fetch leads from Google Sheet ──
    log('Fetching sheet…');
    const rows = await fetchSheetRows(sheetUrl);
    log(`${rows.length} row(s). Columns: ${Object.keys(rows[0] || {}).join(', ')}`);

    // Ensure tracking columns exist
    const sheetId = sheetUrl.match(/\/d\/([^/]+)/)?.[1];
    if (sheetId) {
      await updateSheetRow(sheetUrl, '__ensure_columns__', {}).catch(() => {});
    }

    const state = loadState();

    // Pre-filter targets
    const targets = rows.filter(row => {
      const url = extractLinkedInUrl(row);
      if (!url) return false;
      const prev = state.processed[url];
      if (mode === 'connect_only' && prev) return false;
      if (mode === 'auto' && prev) return false;
      // Skip if sheet already shows as sent/processed
      const sheetStatus = (row['Connection Status'] || row['connectionStatus'] || '').toLowerCase();
      if (sheetStatus.includes('sent') || sheetStatus.includes('pending') || sheetStatus.includes('connected')) return false;
      return true;
    });
    log(`Pre-filter → ${targets.length} to process, ${rows.length - targets.length} skipped (mode: ${mode})`);

    // Load profile names
    log('Loading profile names…');
    const token = getToken();
    for (const pid of profileIds) {
      await getProfileName(pid, token);
    }
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

        // Check session
        try {
          const u = page.url();
          if (u.includes('/login') || u.includes('/authwall')) {
            log(`⚠ ${pName}: not logged in. Skip.`);
            continue;
          }
        } catch (e) {
          log(`⚠ Session check failed: ${e.message}`);
          continue;
        }

        // ════════════════════════════════════════════════════
        // STEP 4: Ready to process leads
        // ════════════════════════════════════════════════════
        await page.evaluate(() => window.scrollTo(0, 0));
        log('✓ Session active. Starting leads…');

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

          // Re-check in case another profile processed this
          if (state.processed[url]) continue;

          // Skip if sheet already shows this lead as sent/processed
          const sheetStatus = (row['Connection Status'] || row['connectionStatus'] || '').toLowerCase();
          if (sheetStatus.includes('sent') || sheetStatus.includes('pending') || sheetStatus.includes('connected')) {
            continue;
          }

          const data = {
            firstName: row['First Name'] || row['firstName'] || row['first_name'] || '',
            lastName: row['Last Name'] || row['lastName'] || row['last_name'] || '',
            company: row['Company'] || row['company'] || '',
            title: row['Title'] || row['title'] || row['Job Title'] || '',
          };

          const hint = getModeHint(mode, state.processed[url]?.action);

          try {
            // Re-acquire page before each lead (prevents stale frame)
            try {
              const pages = await browser.pages();
              if (pages.length > 0) page = pages[pages.length - 1];
            } catch { /* keep current */ }

            log(`→ [${pName}] ${url} (${data.firstName || '?'}) [${hint || 'auto'}]`);

            // performOutreach handles: navigate, 30s wait, 67% zoom, action
            const result = await performOutreach(page, url, { ...tpl, data }, {}, hint);
            log(`  ${result.action}${result.error ? ' — ' + result.error : ''}`);

            const now = new Date().toISOString();

            if (SUCCESS_ACTIONS.has(result.action)) {
              state.processed[url] = { profileId, profileName: pName, action: result.action, date: now };
              bumpCampaignCount(profileId);
              done++;
              campaign.processedToday++;
              campaign.totalProcessed = Object.keys(state.processed).length;
              await saveState(state);

              // Write success to Google Sheet
              const sheetData = {};
              if (result.action === 'connection_sent') {
                sheetData.connectionStatus = 'Sent';
                sheetData.connectionDate = now;
                sheetData.connectionBy = pName;
              } else if (result.action === 'message_sent') {
                sheetData.firstMessageStatus = 'Sent';
                sheetData.firstMessageDate = now;
              } else if (result.action === 'inmail_sent') {
                sheetData.connectionStatus = 'InMail Sent';
                sheetData.connectionDate = now;
                sheetData.connectionBy = pName;
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
              log('  ⏳ 10s');
              await new Promise(r => setTimeout(r, 10000));
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
    logs: campaign.logs.slice(-100),
    errors: campaign.errors.slice(-20),
  };
}
