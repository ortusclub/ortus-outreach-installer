/**
 * Post-campaign acceptance tracking.
 *
 * After a campaign ends, each (sheet, profile) used during the run is
 * registered for a configurable window (default 7 days). A background
 * scheduler ticks every 30 min and runs a bulk Connection Status sweep on
 * any entry whose 6h cooldown has elapsed and whose window hasn't expired.
 *
 * The bot must be running for sweeps to fire. If the operator closes the
 * Electron window, sweeps pause; they resume on the next boot's first tick.
 *
 * Persistent state lives in `data/post-campaign-bulk-check.json` so the
 * scheduler can recover from crashes and restarts.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dataPath } from './paths.js';
import { launchProfile, closeProfile } from './gologin-launcher.js';
import { bulkCheckConnections } from './linkedin/bulk-check-connections.js';
import { runAutoIntros } from './linkedin/auto-intro.js';
import { notifyEmail, enqueueDesktopNotification } from './notifier.js';
import { getPrefs } from './notification-prefs.js';
import { appendCampaignLog } from './campaign-log-bus.js';

const SCHEDULE_FILE = dataPath('post-campaign-bulk-check.json');
const TICK_INTERVAL_MS = 30 * 60 * 1000;
const SWEEP_COOLDOWN_MS = 6 * 60 * 60 * 1000; // per (sheet, profile)

let _tickTimer = null;

async function readSchedule() {
  try { return JSON.parse(await readFile(SCHEDULE_FILE, 'utf8')); }
  catch { return {}; }
}

async function writeSchedule(s) {
  try { await writeFile(SCHEDULE_FILE, JSON.stringify(s, null, 2)); }
  catch (err) { console.warn(`[post-campaign] write failed: ${err.message}`); }
}

function key(sheetId, profileId) { return `${sheetId}|${profileId}`; }

// Lazy import to avoid a load-time circular dep with campaign.js (which
// also imports from this file). Resolved at call time, never at module init.
async function isCampaignRunning() {
  try {
    const m = await import('./campaign.js');
    return !!(m.campaign && m.campaign.running);
  } catch { return false; }
}

/**
 * Register (or refresh) a post-campaign acceptance window.
 *
 * Called by campaign.js's finally block once per (sheet, profile) that
 * actually sent at least one invite. Re-registration extends the window
 * — the new expiry is `now + days`.
 */
export async function registerSchedule({ sheetId, sheetUrl, profileId, profileName, linkedinColumn, days,
                                          operatorEmail,
                                          mode = '', primaryName = '', primaryIntroBody = '',
                                          primaryUrl = '', introTitle = '' }) {
  if (!sheetId || !profileId || !Number.isFinite(days) || days <= 0) return;
  const sched = await readSchedule();
  const k = key(sheetId, profileId);
  const now = Date.now();
  sched[k] = {
    sheetId,
    sheetUrl,
    profileId,
    profileName: profileName || profileId,
    linkedinColumn: linkedinColumn || '',
    operatorEmail: operatorEmail || sched[k]?.operatorEmail || null,
    // Connect + Introduce Back: persist the primary fields so each
    // post-campaign sweep can fire the auto-intro DM after the
    // bulk-check stamps Connected.
    mode: mode || '',
    primaryName: primaryName || '',
    primaryIntroBody: primaryIntroBody || '',
    primaryUrl: primaryUrl || '',
    introTitle: introTitle || '',
    registeredAt: (sched[k]?.registeredAt) || now,
    expiresAt: now + days * 86400000,
    // The campaign's own bulk-check just ran, so no need to immediately
    // sweep again — set lastCheckedAt to "now" so the cooldown applies.
    lastCheckedAt: now,
  };
  await writeSchedule(sched);
  console.log(`[post-campaign] Registered ${profileName || profileId} on sheet ${sheetId} for ${days}d (expires ${new Date(sched[k].expiresAt).toISOString()}, owner: ${sched[k].operatorEmail || 'none'})`);
}

/**
 * Reminder for the operator: "we're about to launch a connection check for
 * accounts A, B, C." Fires both an email and a desktop popup. Groups by
 * operatorEmail — each operator gets one bundled notification per tick
 * listing only their own accounts. Entries with no operator (registered
 * before the field existed) are bundled under a null key and broadcast.
 */
async function notifyDueSweeps(dueEntries) {
  const byOwner = new Map();
  for (const e of dueEntries) {
    const key = e.operatorEmail || '__broadcast__';
    if (!byOwner.has(key)) byOwner.set(key, []);
    byOwner.get(key).push(e);
  }

  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  for (const [key, entries] of byOwner.entries()) {
    const audience = key === '__broadcast__' ? null : key;

    // Per-operator opt-in. Broadcast entries (no owner) skip the notification
    // entirely — there's no way to honor a per-user pref without an owner.
    if (!audience) continue;
    const prefs = await getPrefs(audience);
    if (!prefs.connectionCheckReminders) continue;

    const names = entries.map((e) => e.profileName).join(', ');
    const title = `Launching connection check at ${time}`;
    const body = entries.length === 1
      ? `About to check connections for ${names}.`
      : `About to check connections for ${entries.length} accounts: ${names}.`;

    enqueueDesktopNotification({ title, body, audience });
    try {
      await notifyEmail(audience, { title, body });
    } catch (err) {
      console.warn(`[post-campaign] notifyEmail failed for ${audience}: ${err.message}`);
    }
  }
}

/**
 * One scheduler pass. Skips entirely if a foreground campaign is running.
 * Sweeps each due entry sequentially (not in parallel — keeps GoLogin
 * resource use predictable on weak laptops).
 */
async function tick() {
  if (await isCampaignRunning()) {
    console.log('[post-campaign] Tick skipped — campaign is running');
    return;
  }
  const sched = await readSchedule();
  if (Object.keys(sched).length === 0) return;

  const now = Date.now();
  let changed = false;
  const token = process.env.GOLOGIN_API_TOKEN;

  // First pass: expire-purge + identify due entries so we can fire a single
  // bundled "about to launch checks" notification per operator before any
  // sweep starts. Two-pass keeps the existing per-entry sweep semantics
  // (sequential, foreground-yielding) intact below.
  const dueKeys = [];
  for (const k of Object.keys(sched)) {
    const entry = sched[k];
    if (now >= entry.expiresAt) {
      delete sched[k];
      changed = true;
      console.log(`[post-campaign] Schedule expired for ${entry.profileName} on sheet ${entry.sheetId}`);
      continue;
    }
    if (now < (entry.lastCheckedAt || 0) + SWEEP_COOLDOWN_MS) continue;
    dueKeys.push(k);
  }

  if (dueKeys.length > 0) {
    await notifyDueSweeps(dueKeys.map((k) => sched[k]));
  }

  for (const k of dueKeys) {
    const entry = sched[k];
    // Entry may have been deleted above (expired) — guard.
    if (!entry) continue;

    const _sweepMsg = `📡 ${entry.profileName}: bulk check pass starting…`;
    console.log(`[post-campaign] ${_sweepMsg}`);
    appendCampaignLog(entry.sheetId, entry.profileId, _sweepMsg);
    let launched;
    try {
      launched = await launchProfile(entry.profileId, token);
    } catch (err) {
      console.warn(`[post-campaign] Launch failed for ${entry.profileName}: ${err.message}`);
      // Don't update lastCheckedAt — try again on next tick.
      continue;
    }

    try {
      const r = await bulkCheckConnections(launched.page, entry.sheetUrl, entry.linkedinColumn, entry.profileName);
      if (r.error) {
        console.warn(`[post-campaign] ${entry.profileName} sweep error: ${r.error}`);
      } else {
        const _resultMsg = `📡 ${entry.profileName}: bulk check, ${r.matched} new accepted · ${r.stamped || 0} still pending`;
        console.log(`[post-campaign] ${entry.profileName}: ${r.matched} Connected, ${r.stamped || 0} Still Pending`);
        appendCampaignLog(entry.sheetId, entry.profileId, _resultMsg);
        // Auto-intro pass for connect_and_introduce campaigns whose
        // primary fields were stored at registration time.
        if (Array.isArray(r.connectedUrls) && r.connectedUrls.length > 0
            && entry.primaryName && entry.primaryIntroBody) {
          try {
            await runAutoIntros({
              page: launched.page,
              profileId: entry.profileId,
              profileName: entry.profileName,
              sheetUrl: entry.sheetUrl,
              linkedinColumn: entry.linkedinColumn,
              connectedUrls: r.connectedUrls,
              primaryName: entry.primaryName,
              primaryIntroBody: entry.primaryIntroBody,
              primaryUrl: entry.primaryUrl || '',
              introTitle: entry.introTitle || 'Introduction: {first name} <> {intro name}',
              log: (line) => {
                console.log(`[post-campaign] ${line}`);
                appendCampaignLog(entry.sheetId, entry.profileId, line);
              },
            });
          } catch (introErr) {
            console.warn(`[post-campaign] ${entry.profileName} auto-intro threw: ${introErr.message}`);
          }
        }
      }
    } catch (err) {
      console.warn(`[post-campaign] ${entry.profileName} sweep threw: ${err.message}`);
    } finally {
      try { await closeProfile(entry.profileId); } catch { /* */ }
    }

    entry.lastCheckedAt = now;
    changed = true;

    const _nextCheckAt = new Date(now + SWEEP_COOLDOWN_MS);
    const _nextHHMM = _nextCheckAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const _idleMsg = `🛏 Monitoring idle · next check at ${_nextHHMM}`;
    appendCampaignLog(entry.sheetId, entry.profileId, _idleMsg);

    // Bail if a campaign started mid-tick (foreground takes priority).
    if (await isCampaignRunning()) {
      console.log('[post-campaign] Mid-tick: campaign started — pausing remaining sweeps');
      break;
    }
  }

  if (changed) await writeSchedule(sched);
}

export function startScheduler() {
  if (_tickTimer) return;
  _tickTimer = setInterval(() => { tick().catch((err) => console.warn(`[post-campaign] Tick threw: ${err.message}`)); }, TICK_INTERVAL_MS);
  // First pass shortly after boot so overdue checks don't wait the full interval.
  setTimeout(() => { tick().catch((err) => console.warn(`[post-campaign] First-tick threw: ${err.message}`)); }, 30_000);
  console.log(`[post-campaign] Scheduler started (30-min ticks, 6h per-account cooldown)`);
}

export function stopScheduler() {
  if (_tickTimer) clearInterval(_tickTimer);
  _tickTimer = null;
}

/**
 * For dashboard visibility — return active schedule entries.
 */
export async function listSchedule() {
  const sched = await readSchedule();
  return Object.values(sched);
}
