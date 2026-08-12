import GoLogin from 'gologin';
import puppeteer from 'puppeteer-core';
import { hideByPid } from './mac-window.js';
import { checkDiskFree, formatBytes } from './disk-check.js';
import { configuredAccounts, tokenForAccount, DEFAULT_ACCOUNT_ID } from './gologin-accounts.js';

const activeProfiles = new Map();
const spawnedPids = new Map(); // profileId → Orbita pid (every spawn, even failed launches)

/**
 * Pick PIDs we spawned that are still alive but no longer tracked as active
 * (escaped activeProfiles — e.g. a failed launch, or a close that didn't take).
 * Pure + exported for unit testing; closeAllProfiles wires it to real signals.
 */
export function selectOrphanPids({ spawned, activePids, isAlive }) {
  const out = [];
  for (const pid of spawned.values()) {
    if (typeof pid !== 'number') continue;
    if (activePids.has(pid)) continue;
    if (!isAlive(pid)) continue;
    out.push(pid);
  }
  return out;
}

// Profile list cache — loaded once per GoLogin account, reused across the
// entire campaign. Keyed by account id since v2.160.138: the app lists more
// than one GoLogin workspace and a single shared cache would let whichever
// account refreshed last stand in for both.
const profileCaches = new Map(); // accountId → { list, time }
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// profileId → accountId, the answer to "whose token launches this profile".
// Populated as a side effect of every getProfiles() call and read by
// tokenForProfile(). It is a cache, not a store: a cold process that resumes a
// campaign has an empty map, which is why tokenForProfile() is async and
// re-lists on a miss rather than guessing.
const profileAccount = new Map();

/**
 * v2.14.x: Force a Puppeteer page to report itself as focused/active
 * regardless of OS window state. LinkedIn's typeahead (and many other
 * async features) check document.hasFocus() / visibility and skip or
 * degrade processing when the answer is "not focused" — which is what
 * the renderer reports when the operator backgrounds the Chrome window
 * (99% of campaign runtime).
 *
 * This uses CDP Emulation.setFocusEmulationEnabled, the same call
 * Playwright makes by default for every page. Puppeteer's own
 * emulateFocusedPage(true) (PR #14501) wraps it but isn't in 22.15.0
 * yet, so we call CDP directly.
 *
 * Idempotent: callers can invoke it after every page re-acquisition
 * without worrying about leaks — the page-level tag short-circuits
 * repeats so we don't stack `framenavigated` listeners.
 *
 * Why this is exported and called from outside: the launcher applies it
 * to the initial page, but every site in campaign.js that does
 * `page = pages[pages.length - 1]` is grabbing a DIFFERENT page object
 * whose CDP session has never been configured. Without re-applying,
 * those re-acquired pages silently lose focus emulation and the
 * background-tab typeahead fix is undone.
 */
export async function applyFocusEmulation(page, profileId = 'unknown') {
  if (!page) return;
  if (page.__ortusFocusEmulated) return;
  try {
    const cdp = await page.target().createCDPSession();
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    // Re-apply on every main-frame navigation. Puppeteer 22.15.0 doesn't yet
    // track this setting across nav (PR #14501 added that, post-22.x).
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
      }
    });
    page.__ortusFocusEmulated = true;
    console.log(`[gologin] Focus emulation enabled for ${profileId} (with nav re-apply)`);
  } catch (err) {
    console.warn(`[gologin] Focus emulation failed for ${profileId}: ${err.message}`);
  }
}

async function fetchAccountProfiles(accountId, token) {
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
      // Trim once, here, so no consumer has to. GoLogin lets a profile be named
      // with stray whitespace and one is ("nabungaires@gmail.com " — note the
      // trailing space). The SoO matchers happen to normalise
      // (account-guardrails lookupSoO trims, soo-writer normAccount strips all
      // whitespace), but plenty of paths use the name RAW: it is written
      // verbatim into the sheet's "Account Used" column, printed in logs and
      // tiles, and is the string `{sender first name}` email-splits from when
      // no nice name resolves. One padded name is a silent mismatch waiting for
      // the first consumer that compares without normalising.
      allProfiles.push({ id: p.id, name: String(p.name || '').trim(), notes: p.notes || '', account: accountId });
    }

    console.log(`[gologin] ${accountId} page ${page}: ${allProfiles.length}/${totalCount}`);
    page++;
  }

  return allProfiles;
}

/**
 * Every profile the app can see, across every configured GoLogin account,
 * each tagged with the `account` that owns it.
 *
 * The parameter is ignored and kept only so the ~15 legacy
 * `getProfiles(process.env.GOLOGIN_API_TOKEN)` call sites keep compiling and
 * transparently gain the second account. Tokens now come from the registry,
 * per account — passing one here cannot mean anything sensible once there is
 * more than one.
 */
export async function getProfiles(_ignoredLegacyToken) {
  const out = [];
  // Owner decided fresh on every run, then published in one go below — so a
  // profile that genuinely MOVES workspaces re-tags on the next list instead of
  // being frozen by the first answer we ever recorded.
  const owner = new Map();

  for (const acc of configuredAccounts()) {
    const cached = profileCaches.get(acc.id);
    let list;

    if (cached && Date.now() - cached.time < CACHE_TTL) {
      list = cached.list;
    } else {
      try {
        list = await fetchAccountProfiles(acc.id, tokenForAccount(acc.id));
        profileCaches.set(acc.id, { list, time: Date.now() });
      } catch (err) {
        // A secondary account being down must never blank the primary roster —
        // that would empty the picker for operators who have nothing to do with
        // it. Serve its last known list (or nothing) and carry on. The default
        // account still throws: an empty picker there is a real outage and has
        // always surfaced as one.
        if (acc.id === DEFAULT_ACCOUNT_ID) throw err;
        console.warn(`[gologin] ${acc.id} profile list failed (${err.message}) — using ${cached ? 'stale cache' : 'no profiles'} for it`);
        list = cached ? cached.list : [];
      }
    }

    // First workspace to list a profile owns it, NOT the last. GoLogin lets one
    // workspace share a profile into another, so the SAME id comes back from
    // two tokens (2026-08-11: 43 of them, including rj@ and marigona@, shared
    // from Ortus into marketing). Last-write-wins re-stamped every shared
    // profile as `marketing`, which then inherited that workspace's
    // Follower-Growth-and-Post-Amplification-only rule and refused every connect
    // campaign — and handed launchProfile the wrong token besides. GL_ACCOUNTS
    // is ordered ortus first, so first-wins gives a shared profile its real
    // home; a profile that lives ONLY in marketing still tags marketing and
    // stays restricted.
    for (const p of list) {
      // A shared profile is ONE profile, so it gets one tile in the picker —
      // the owning workspace's. Pushing both copies would show the operator the
      // same account twice, once greyed out by a rule that does not apply to it.
      if (owner.has(p.id)) continue;
      owner.set(p.id, acc.id);
      out.push(p);
    }
  }

  for (const [id, accId] of owner) profileAccount.set(id, accId);

  console.log(`[gologin] Total: ${out.length} profiles across ${configuredAccounts().length} account(s)`);
  return out;
}

/**
 * Which account owns a profile, or null when we have not listed it yet.
 * Synchronous and cache-only — callers that need an answer use
 * tokenForProfile().
 */
export function accountOfProfile(profileId) {
  return profileAccount.get(profileId) || null;
}

/**
 * The API token that can drive this profile.
 *
 * Async because the mapping is a cache: a freshly restarted process resuming a
 * campaign has never listed anything, and silently falling back to the default
 * account's token there would launch-fail every second-account profile with an
 * opaque GoLogin 404. On a miss we list once (which populates the map) and try
 * again; only then do we fall back.
 */
export async function tokenForProfile(profileId) {
  if (!profileAccount.has(profileId)) {
    try { await getProfiles(); } catch { /* fall through to the default token */ }
  }
  return tokenForAccount(profileAccount.get(profileId) || DEFAULT_ACCOUNT_ID);
}

export function clearProfileCache() {
  profileCaches.clear();
  profileAccount.clear();
}

/**
 * Launch a GoLogin browser profile.
 * The browser window is positioned off-screen to avoid stealing focus.
 *
 * `_ignoredLegacyToken` exists only so the ~15 existing
 * `launchProfile(pid, process.env.GOLOGIN_API_TOKEN)` call sites keep working.
 * The token is resolved HERE, from the profile itself, because the caller
 * cannot know which GoLogin account owns the profile it was handed — and every
 * one of those call sites was passing the default account's token
 * unconditionally, which is a 404 for any Linked Velocity profile.
 * Resolving in the one place they all funnel through is why adding a second
 * account did not need 22 edits.
 */
export async function launchProfile(profileId, _ignoredLegacyToken) {
  const token = await tokenForProfile(profileId);
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
      // v2.57.x: add CalculateNativeWinOcclusion to the existing disable-features.
      // Chromium has a parallel "is this window occluded by other windows?"
      // detector that downgrades the renderer to hidden state independently
      // of the backgrounding flags below. Without disabling it, a window
      // sitting behind another app on macOS can still throttle even though
      // it's technically not minimized. Belt-and-suspenders alongside the
      // backgrounding flags + CDP focus emulation in applyFocusEmulation().
      // Chromium only honors ONE --disable-features flag (last-wins), so all
      // disabled features must live in this single comma-joined arg.
      '--disable-features=TranslateUI,MediaRouter,CalculateNativeWinOcclusion',
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

  const _spawnedPid = GL?.processSpawned?.pid;
  if (_spawnedPid) spawnedPids.set(profileId, _spawnedPid);

  if (status !== 'success') {
    console.warn(`[gologin] start failed for ${profileId} (status="${status}") — force-killing any spawned process`);
    try { GL.killBrowser(); } catch { /* */ }
    if (_spawnedPid) { try { process.kill(_spawnedPid, 'SIGKILL'); } catch { /* already dead */ } }
    spawnedPids.delete(profileId);
    await GL.stop().catch(() => {});   // cloud-commit only; kill already done
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
  // v2.86: 15s → 30s default action timeout — slow operator machines were
  // timing out clicks / waitForSelector before the page settled.
  page.setDefaultTimeout(30000);

  // v2.14.x: enable focus emulation on the initial page. Callers that
  // re-acquire `page` from browser.pages() later (campaign.js:792-798,
  // 2099-2110, 2185-2196) MUST call applyFocusEmulation(newPage, profileId)
  // themselves — the setting + the framenavigated re-apply listener are
  // bound to the page object, not the browser, so a fresh page reference
  // starts with focus emulation OFF and silently nullifies LinkedIn-side
  // behaviour that depends on document.hasFocus().
  await applyFocusEmulation(page, profileId);

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

  const _proc = GL?.processSpawned;
  console.log(`[gologin] closeProfile ${profileId}: pid=${_proc?.pid ?? 'NONE'} killed=${_proc?.killed ?? '?'}${_proc?.pid ? '' : ' (no process handle — orphan risk)'}`);

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
  spawnedPids.delete(profileId);
}

export async function closeAllProfiles() {
  // Phase 2.8.10: parallel close. Each GL.stop() can take 2-5s for the
  // GoLogin SDK to sync profile state to the cloud — serialized that means
  // 8-20s wall-clock with 4 profiles. Run in parallel: ~5s for all of them.
  // closeProfile already swallows its own errors so Promise.all won't reject.
  const ids = [...activeProfiles.keys()];
  await Promise.all(ids.map(id => closeProfile(id)));

  // v2.86.14: safety net — SIGKILL any browser WE spawned that escaped
  // activeProfiles (failed launch / close that didn't take). Only PIDs we
  // recorded in spawnedPids — never a name-matched or operator-opened browser.
  const activePids = new Set(getActiveBrowserPids());
  const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const orphans = selectOrphanPids({ spawned: spawnedPids, activePids, isAlive });
  for (const pid of orphans) {
    console.warn(`[gologin] orphan Orbita pid ${pid} survived close — SIGKILL`);
    try { process.kill(pid, 'SIGKILL'); } catch { /* */ }
  }
  for (const [pidProfile, pid] of [...spawnedPids.entries()]) {
    if (orphans.includes(pid) || !isAlive(pid)) spawnedPids.delete(pidProfile);
  }

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
