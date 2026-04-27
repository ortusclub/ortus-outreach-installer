import GoLogin from 'gologin';
import puppeteer from 'puppeteer-core';
import { hideByPid } from './mac-window.js';
import { checkDiskFree, formatBytes } from './disk-check.js';

const activeProfiles = new Map();

// Profile list cache — loaded once, reused across the entire campaign
let profileCache = null;
let profileCacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export async function getProfiles(token) {
  // Return cache if fresh
  if (profileCache && Date.now() - profileCacheTime < CACHE_TTL) {
    return profileCache;
  }

  const allProfiles = [];
  let page = 1;
  let totalCount = Infinity;

  while (allProfiles.length < totalCount) {
    const res = await fetch(`https://api.gologin.com/browser/v2?page=${page}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`GoLogin API ${res.status}`);

    const data = await res.json();
    totalCount = data.allProfilesCount || 0;
    const profiles = data.profiles || [];
    if (!profiles.length) break;

    for (const p of profiles) {
      allProfiles.push({ id: p.id, name: p.name, notes: p.notes || '' });
    }

    console.log(`[gologin] Page ${page}: ${allProfiles.length}/${totalCount}`);
    page++;
  }

  console.log(`[gologin] Total: ${allProfiles.length} profiles`);
  profileCache = allProfiles;
  profileCacheTime = Date.now();
  return allProfiles;
}

export function clearProfileCache() {
  profileCache = null;
  profileCacheTime = 0;
}

/**
 * Launch a GoLogin browser profile.
 * The browser window is positioned off-screen to avoid stealing focus.
 */
export async function launchProfile(profileId, token) {
  // Phase 2.8.20 (W3-C2): refuse to launch when free disk is below threshold.
  // Profile downloads + screenshots + logs accumulate; a full disk silently
  // corrupts state (writes return ENOSPC and the campaign limps on).
  const disk = await checkDiskFree();
  if (!disk.ok) {
    throw new Error(`Disk space too low (${formatBytes(disk.freeBytes)} free, ${formatBytes(disk.thresholdBytes)} required) — clear space before launching.`);
  }
  console.log(`[gologin] Starting ${profileId}…`);

  const GL = new GoLogin({
    token,
    profile_id: profileId,
    // Push the window off-screen so it doesn't steal focus
    extra_params: [
      '--window-position=-2400,-2400',
      '--window-size=1366,900',
      // Reduce per-Chromium RAM footprint (~100-150MB each) on low-resource hosts
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-features=TranslateUI,MediaRouter',
      '--disable-renderer-backgrounding',
      '--renderer-process-limit=2',
      '--js-flags=--max-old-space-size=512',
    ],
  });

  const { status, wsUrl } = await GL.start();

  if (status !== 'success') {
    await GL.stop().catch(() => {});
    throw new Error(`GoLogin start failed: status="${status}"`);
  }

  activeProfiles.set(profileId, GL);

  const browser = await puppeteer.connect({
    browserWSEndpoint: wsUrl,
    ignoreHTTPSErrors: true,
    protocolTimeout: 120000, // 120s: prevent "Runtime.callFunctionOn timed out" on slow hosts
  });

  const pages = await browser.pages();
  const page = pages.length > 0 ? pages[0] : await browser.newPage();

  await page.setViewport({ width: 1366, height: 900 });
  page.setDefaultNavigationTimeout(30000);
  page.setDefaultTimeout(15000);

  // Phase 11.2 (D-16): minimize the Chromium window on macOS. Best-effort,
  // fire-and-forget so we don't stall the launch hot path.
  const pid = GL?.processSpawned?.pid;
  if (pid) { hideByPid(pid).catch(() => {}); }

  return { browser, page };
}

export async function closeProfile(profileId) {
  const GL = activeProfiles.get(profileId);
  if (!GL) return;

  // Phase 2.8.11 root-cause fix: GL.stop() does NOT kill the Orbita Chromium
  // process — it only uploads cookies + commits profile state to GoLogin's
  // cloud (see node_modules/gologin/src/gologin.js stopAndCommit, line 1045).
  // The actual process kill must come from GL.killBrowser() which calls
  // processSpawned.kill() directly. Without this, the browser window stays
  // visible until something else (Puppeteer's browser.close() over CDP) finally
  // takes the process down — and for parked/idle profiles the CDP path is
  // unreliable, leaving "ghost" windows after Stop.
  try { GL.killBrowser(); }
  catch (err) { console.warn(`[gologin] killBrowser warning: ${err.message}`); }

  // Cloud commit (cookies, profile state) is fire-and-forget — we don't want
  // the Stop endpoint blocked for 3-20s of cloud sync just to acknowledge the
  // user. The SDK's is_stopping guard makes a duplicate stopAndCommit safe.
  GL.stopAndCommit({ posting: true }, false).catch(err => {
    console.warn(`[gologin] background commit for ${profileId}: ${err.message}`);
  });

  activeProfiles.delete(profileId);
}

export async function closeAllProfiles() {
  // Phase 2.8.10: parallel close. Each GL.stop() can take 2-5s for the
  // GoLogin SDK to sync profile state to the cloud — serialized that means
  // 8-20s wall-clock with 4 profiles. Run in parallel: ~5s for all of them.
  // closeProfile already swallows its own errors so Promise.all won't reject.
  const ids = [...activeProfiles.keys()];
  await Promise.all(ids.map(id => closeProfile(id)));
  return ids.length;
}

/**
 * Return the OS PID of the GoLogin-spawned Chromium for this profile,
 * or null if the profile isn't launched / the SDK didn't record a process.
 *
 * Added for phase 11.1 (resource-monitor). puppeteer.connect() returns null
 * from browser.process(), so we reach into the SDK's own process handle.
 * See .planning/phases/11.1.../11.1-RESEARCH.md §Pitfall 1.
 */
export function getProfilePid(profileId) {
  const GL = activeProfiles.get(profileId);
  return GL?.processSpawned?.pid ?? null;
}

/**
 * Return every live GoLogin Chromium PID known to the launcher. Used by the
 * ambient resource sampler so tiles reflect launched browsers even before
 * the round-robin loop takes over.
 */
export function getActiveBrowserPids() {
  return [...activeProfiles.values()]
    .map(GL => GL?.processSpawned?.pid)
    .filter(pid => typeof pid === 'number');
}
