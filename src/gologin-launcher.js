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
      // v2.14.x: Chrome aggressively throttles renderers when the OS window is
      // backgrounded/occluded — page.type() keystrokes get dropped by the
      // typeahead component during its throttled re-render. Operator confirmed
      // 2026-05-16 that the IC DM hang only fires when the GoLogin window is
      // in the background; bringing it foreground unblocks it instantly. These
      // three flags together force every renderer to behave as foreground.
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
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
    // 2.8.27: bumped 120s -> 180s. Slow profiles (large cookie jars, many
    // tabs from --restore-last-session) were timing out on Network.enable
    // before Puppeteer could attach. Rakibul.islam was launch-failing every
    // round all night because of this.
    protocolTimeout: 180000,
  });

  const pages = await browser.pages();
  const page = pages.length > 0 ? pages[0] : await browser.newPage();

  // 2.8.27: close excess tabs that --restore-last-session brought back from
  // the previous run. GoLogin's SDK appends --restore-last-session to every
  // launch and we can't override it, so over time stale tabs accumulate
  // (one user saw 10+ tabs piled up). We keep pages[0] and close the rest.
  if (pages.length > 1) {
    console.log(`[gologin] Closing ${pages.length - 1} stale tab(s) from previous session`);
    for (let i = 1; i < pages.length; i++) {
      try { await pages[i].close({ runBeforeUnload: false }); } catch { /* best-effort */ }
    }
  }

  await page.setViewport({ width: 1366, height: 900 });
  page.setDefaultNavigationTimeout(30000);
  page.setDefaultTimeout(15000);

  // v2.14.x: Force the page to report itself as focused/active regardless of
  // OS window state. LinkedIn's typeahead (and many other async features)
  // check document.hasFocus() / visibility — when the answer is "not focused"
  // they skip or degrade processing, which is why typing into the IC DM
  // recipient input fails when the GoLogin window is backgrounded but CC
  // clicks work fine. This is the same CDP call Playwright makes by default
  // for every page, and what Puppeteer's emulateFocusedPage(true) (added in
  // PR #14501, post-22.x) wraps. Source:
  // chromedevtools.github.io/devtools-protocol — Emulation.setFocusEmulationEnabled
  try {
    const cdp = await page.target().createCDPSession();
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    // Re-apply on every main-frame navigation. Puppeteer 22.15.0 doesn't yet
    // have the EmulationManager logic from PR #14501 that tracks this setting
    // and re-applies it after nav. ensureProfileLoggedIn does a page.goto +
    // re-acquire dance (campaign.js:714) where the setting could be lost on
    // a process-swap navigation. Listener uses the same long-lived CDP
    // session; cost is one CDP call per navigation, swallowed errors only.
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
      }
    });
    console.log(`[gologin] Focus emulation enabled for ${profileId} (with nav re-apply)`);
  } catch (err) {
    console.warn(`[gologin] Focus emulation failed for ${profileId}: ${err.message}`);
  }

  // 2.8.44: auto-handle browser dialogs. LinkedIn's compose page registers a
  // beforeunload handler when the textarea has unsaved text — if a send fails
  // and we navigate to the next lead, the dialog blocks Puppeteer until it
  // times out (and is visible to the user as a "Leave site?" prompt). We're
  // a bot: dialogs are never useful, always dismiss/accept.
  page.on('dialog', async (dialog) => {
    try {
      if (dialog.type() === 'beforeunload') await dialog.accept();
      else await dialog.dismiss();
    } catch { /* already handled */ }
  });

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

  // 2.8.27: SIGKILL fallback. GL.killBrowser() sends SIGTERM to the spawned
  // Orbita process. If Chromium is mid-something (uploading a profile,
  // hung renderer, etc.), SIGTERM may be ignored and the process — plus all
  // its visible windows — lingers indefinitely. After 2s, force-kill.
  const proc = GL?.processSpawned;
  if (proc?.pid && !proc.killed) {
    setTimeout(() => {
      try {
        process.kill(proc.pid, 0); // throws ESRCH if already dead
        console.warn(`[gologin] SIGTERM didn't take after 2s — SIGKILL pid ${proc.pid}`);
        try { process.kill(proc.pid, 'SIGKILL'); } catch { /* */ }
      } catch { /* already dead — good */ }
    }, 2000);
  }

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
