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

const SCHEDULE_FILE = dataPath('post-campaign-bulk-check.json');
const TICK_INTERVAL_MS = 30 * 60 * 1000; // 30 min between scheduler passes
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
export async function registerSchedule({ sheetId, sheetUrl, profileId, profileName, linkedinColumn, days }) {
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
    registeredAt: (sched[k]?.registeredAt) || now,
    expiresAt: now + days * 86400000,
    // The campaign's own bulk-check just ran, so no need to immediately
    // sweep again — set lastCheckedAt to "now" so the cooldown applies.
    lastCheckedAt: now,
  };
  await writeSchedule(sched);
  console.log(`[post-campaign] Registered ${profileName || profileId} on sheet ${sheetId} for ${days}d (expires ${new Date(sched[k].expiresAt).toISOString()})`);
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

  for (const k of Object.keys(sched)) {
    const entry = sched[k];

    // Expired? remove.
    if (now >= entry.expiresAt) {
      delete sched[k];
      changed = true;
      console.log(`[post-campaign] Schedule expired for ${entry.profileName} on sheet ${entry.sheetId}`);
      continue;
    }

    // Cooldown not elapsed? skip this tick.
    if (now < (entry.lastCheckedAt || 0) + SWEEP_COOLDOWN_MS) continue;

    console.log(`[post-campaign] Sweeping ${entry.profileName} on sheet ${entry.sheetId}…`);
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
        console.log(`[post-campaign] ${entry.profileName}: ${r.matched} Connected, ${r.stamped || 0} Still Pending`);
      }
    } catch (err) {
      console.warn(`[post-campaign] ${entry.profileName} sweep threw: ${err.message}`);
    } finally {
      try { await closeProfile(entry.profileId); } catch { /* */ }
    }

    entry.lastCheckedAt = now;
    changed = true;

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
  // First pass shortly after boot so overdue checks don't wait 30 min.
  setTimeout(() => { tick().catch((err) => console.warn(`[post-campaign] First-tick threw: ${err.message}`)); }, 30_000);
  console.log('[post-campaign] Scheduler started (30-min ticks)');
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
