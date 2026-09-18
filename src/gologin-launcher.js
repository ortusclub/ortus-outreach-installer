import GoLogin from 'gologin';
import goLoginRequestPolicy from './gologin-request-policy.cjs';
import { setupPacing } from './gologin-pacing-setup.js';
setupPacing();
goLoginRequestPolicy.installSdkRequestPolicy();
import { startupAdmission } from './startup-admission.js';
import puppeteer from 'puppeteer-core';
import { hideByPid, unhideByPids } from './mac-window.js';
import { checkDiskFree, formatBytes } from './disk-check.js';
import { confirmOwnedProcessExit } from './process-exit-evidence.js';
import { guardSdkStartup } from './sdk-startup-control.js';
import { configuredAccounts, tokenForAccount, DEFAULT_ACCOUNT_ID } from './gologin-accounts.js';
import { dataRoot } from './paths.js';
import { readRosterSnapshot, saveRosterSnapshot, PICKER_ROSTER_FRESH_MS } from './gologin-roster-snapshot.js';

const activeProfiles = new Map();
const pendingLaunches = new Set();
const startingProfiles = new Map();
const closingProfiles = new Map();
const closedProfileEvidence = new Map();
const activeSessions = new Map(); // profileId → { browser, page }
const spawnedPids = new Map(); // profileId → Orbita pid (every spawn, even failed launches)

// Recovery readers may inspect an owned session, but must never implicitly
// launch it or change it from manual control to automation.
export function getProfileObservationBrowser(profileId) {
  if (pendingLaunches.has(profileId) || closingProfiles.has(profileId)) return null;
  return activeSessions.get(profileId)?.browser || null;
}

export function observeProfileShutdown(profileId) {
  if (pendingLaunches.has(profileId) || closingProfiles.has(profileId)) {
    return { state: 'unconfirmed', message: 'This profile is still starting or closing. Do not open another session.' };
  }
  const pid = activeProfiles.get(profileId)?.processSpawned?.pid || spawnedPids.get(profileId);
  if (pid) {
    try { process.kill(pid, 0); return { state: 'open', message: 'An owned browser process is still present. No browser was opened or restarted by this check.' }; }
    catch (error) {
      if (error.code !== 'ESRCH') return { state: 'unconfirmed', message: 'The owned process could not be inspected. Shutdown remains unconfirmed.' };
    }
  }
  if (closedProfileEvidence.get(profileId)?.browserClosed === true) {
    return { state: 'closed', message: 'The owned browser closure was confirmed. This check did not clear any account hold or resume a campaign.' };
  }
  // Absent tracking alone is NOT proof of closure.
  return { state: 'unconfirmed', message: 'No live process was found in the current tracking. This alone cannot certify shutdown; the campaign closure receipt must also be confirmed. Nothing was restarted.' };
}

/**
 * Pick PIDs we spawned that are still alive but no longer tracked as active
 * (escaped activeProfiles — e.g. a failed launch, or a close that didn't take).
 * Pure + exported for unit testing; closeAllProfiles wires it to real signals.
 */
// v3.1.33: hard ceiling on any promise that can hang forever.
//
// GoLogin's GL.start() has no internal timeout. When the GoLogin API is
// unreachable, or a profile is locked by another machine, or the local Orbita
// download stalls, the returned promise simply never settles. Every await above
// it parks with it, and a parked await never reaches a `finally` — which is how
// one unhealthy laptop bricked local bulk checks for its whole session: the
// sweep's `_manualSweepRunning` flag could never clear, so every later check
// answered "a bulk check is already running" and both Wait and Stop were dead
// ends (server.js:5602).
//
// Pure + exported so the timing contract is unit-testable without GoLogin.
// Rejects with `label` in the message; never swallows the original rejection.
export function withTimeout(promise, ms, label) {
  let timer;
  const ceiling = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([promise, ceiling]).finally(() => clearTimeout(timer));
}

// Generous on purpose: colleagues run this on slow, loaded laptops, and a cold
// profile has to download before it starts. This is a "something is wrong"
// ceiling, not a performance target — a healthy launch takes seconds.
export const LAUNCH_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Attach to a browser GoLogin has just reported as started, tolerating the gap
 * before Orbita is actually listening.
 *
 * GL.start() can return status "success" and a port before the browser has
 * bound it, and the connect then fails instantly with ECONNREFUSED. Measured
 * 2026-08-29 on cindy.siapno: the account was skipped, the whole acceptance
 * check was stamped incomplete, and the card told the operator to go open the
 * profile by hand. The same profile opened normally 79 minutes later with no
 * intervention, so nothing was wrong with it.
 *
 * Backoff is short (2s, then 4s) rather than the flat 5s that first suggests
 * itself, because a refusal is answered instantly and a browser that is going
 * to come up comes up in a second or two. And if the process we spawned is
 * already dead there is nothing to wait for: no port will ever open, so we fail
 * immediately instead of spending the backoff. That matters when a sweep has
 * many accounts to get through.
 *
 * Only a connection-level refusal is retried. A protocol error means we DID
 * reach the browser and something else is wrong, and repeating it would just
 * delay a real failure.
 */
export const CONNECT_RETRY_DELAYS_MS = [2000, 4000];

export async function connectWithRetry(connect, {
  pid,
  label = 'profile',
  delays = CONNECT_RETRY_DELAYS_MS,
  isAlive = (p) => { try { process.kill(p, 0); return true; } catch { return false; } },
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      return await connect();
    } catch (err) {
      lastErr = err;
      if (attempt === delays.length) break;
      if (!/ECONNREFUSED|ECONNRESET|socket hang up/i.test(String(err && err.message))) break;
      if (typeof pid === 'number' && !isAlive(pid)) {
        console.warn(`[gologin] ${label}: browser process ${pid} is gone; not retrying the attach`);
        break;
      }
      const wait = delays[attempt];
      console.warn(`[gologin] ${label}: browser not listening yet (${err.message}); retrying attach in ${wait / 1000}s`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

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
// accountId → the in-flight fetch, so callers that arrive while one workspace is
// still listing WAIT for it instead of starting a second one. profileCaches only
// ever held a finished result, so two boot-time callers both missed and both
// paged the whole workspace: 34 GoLogin calls for 489 profiles instead of 17
// (Sam's log, 1 Sep, two interleaved 17-page sweeps). Rejections are never
// cached — the entry is dropped in a finally, so the next caller retries.
const profileFetches = new Map(); // accountId → Promise<list>
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
    const reapply = (frame) => {
      if (frame === page.mainFrame()) {
        cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
      }
    };
    page.on('framenavigated', reapply);
    page.__ortusFocusEmulated = true;
    page.__ortusFocusSession = cdp;
    page.__ortusFocusReapply = reapply;
    console.log(`[gologin] Focus emulation enabled for ${profileId} (with nav re-apply)`);
  } catch (err) {
    console.warn(`[gologin] Focus emulation failed for ${profileId}: ${err.message}`);
  }
}

async function releaseFocusEmulation(page) {
  if (!page) return;
  const reapply = page.__ortusFocusReapply;
  if (reapply) page.off('framenavigated', reapply);
  const cdp = page.__ortusFocusSession;
  if (cdp) {
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {});
    await cdp.detach().catch(() => {});
  }
  delete page.__ortusFocusEmulated;
  delete page.__ortusFocusSession;
  delete page.__ortusFocusReapply;
}

export async function fetchAccountProfiles(accountId, token, {
  waitOnRateLimit = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  const allProfiles = [];
  let page = 1;
  let totalCount = Infinity;
  let rateLimitWaits = 0;

  while (allProfiles.length < totalCount) {
    // The ONLY unbounded call on the cloud-launch path (sheets is 30s x2, the
    // engine 20s). With no signal a hung GoLogin socket blocks handleStartCloud
    // forever, and the launch card sits on "Reading your lead sheet and
    // dispatching to the VM…" with nothing able to say why (Sam, 2026-08-27:
    // five minutes, no campaign row ever created). Same 30s + one retry the
    // sheet fetch uses, and the reason is named rather than swallowed.
    let res;
    try {
      res = await goLoginRequestPolicy.pacedFetch(`https://api.gologin.com/browser/v2?page=${page}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(30000),
      });
    } catch (err) {
      if (err.provider === 'gologin') throw err;
      const why = err.cause?.code || err.cause?.message || err.name;
      throw new Error(`GoLogin did not answer while listing accounts (page ${page}) — ${err.message}${why ? ` (${why})` : ''}`);
    }
    if (!res.ok) {
      const error = goLoginRequestPolicy.providerError(res.status, res.headers);
      if (error.code === 'GOLOGIN_RATE_LIMIT' && rateLimitWaits < 3) {
        // This is a read-only paged list. Keep completed pages in this one
        // attempt, then retry ONLY the limited page after a bounded pause.
        // Do not use this pattern for launches, writes, or LinkedIn actions.
        const delay = Number.isFinite(error.retryAfterMs) ? Math.max(1000, error.retryAfterMs) : 60_000;
        if (delay <= 120_000) {
          rateLimitWaits++;
          console.warn(`[gologin] ${accountId} profile list paused after HTTP 429 on page ${page}; retry ${rateLimitWaits}/3 after ${Math.ceil(delay / 1000)}s`);
          await waitOnRateLimit(delay);
          continue;
        }
      }
      throw error;
    }
    // Pagination guard: the loop's only other exits are an empty page or
    // reaching allProfilesCount. A count that never becomes reachable would
    // otherwise spin forever against the API.
    if (page > 100) throw new Error(`GoLogin pagination did not terminate (stopped at page ${page}, ${allProfiles.length}/${totalCount})`);

    const data = await res.json();
    totalCount = data.allProfilesCount || 0;
    const profiles = data.profiles || [];
    if (!profiles.length) {
      if (totalCount > allProfiles.length) {
        const gap = totalCount - allProfiles.length;
        // GoLogin can include a few non-returned profiles in allProfilesCount
        // (observed 501 returned / 503 counted on PR-19). A terminal empty
        // page is still the end of the accessible list. Never accept a large
        // shortfall as a complete roster.
        if (allProfiles.length < 30 || gap > 5 || allProfiles.length / totalCount < 0.99) {
          throw new Error(`GoLogin profile list ended early at ${allProfiles.length}/${totalCount}; no incomplete roster was saved.`);
        }
        console.warn(`[gologin] ${accountId} terminal page empty; provider counted ${totalCount}, returned ${allProfiles.length} accessible profiles`);
      }
      break;
    }

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
export async function getProfiles(_ignoredLegacyToken, { forceRefresh = false, onAccountFailure = null } = {}) {
  const out = [];
  // Owner decided fresh on every run, then published in one go below — so a
  // profile that genuinely MOVES workspaces re-tags on the next list instead of
  // being frozen by the first answer we ever recorded.
  const owner = new Map();

  for (const acc of configuredAccounts()) {
    const cached = profileCaches.get(acc.id);
    let list;

    if (!forceRefresh && cached && Date.now() - cached.time < CACHE_TTL) {
      list = cached.list;
    } else {
      try {
        let pending = profileFetches.get(acc.id);
        if (!pending) {
          pending = fetchAccountProfiles(acc.id, tokenForAccount(acc.id))
            .then((fresh) => {
              // Stamped when the list ARRIVES, not when it was asked for, so a
              // slow page-through cannot spend most of its own TTL loading.
              profileCaches.set(acc.id, { list: fresh, time: Date.now() });
              return fresh;
            })
            .finally(() => profileFetches.delete(acc.id));
          profileFetches.set(acc.id, pending);
        }
        list = await pending;
      } catch (err) {
        // A secondary account being down must never blank the primary roster —
        // that would empty the picker for operators who have nothing to do with
        // it. Serve its last known list (or nothing) and carry on. The default
        // account still throws: an empty picker there is a real outage and has
        // always surfaced as one.
        if (acc.id === DEFAULT_ACCOUNT_ID) throw err;
        try { onAccountFailure?.(acc.id); } catch {}
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

let lastForcedPickerRefreshAt = 0;
function pickerCredentialFingerprintInput() {
  // The snapshot is invalid when the workspace roster or any credential
  // changes, or when the same data directory is opened in another engine
  // environment. The tokens themselves are never written to disk or logs.
  const environment = process.env.ORTUS_ENGINE_ENVIRONMENT || 'production';
  const preview = environment === 'preview' ? String(process.env.ORTUS_PREVIEW_PR || '') : '';
  return JSON.stringify({ environment, preview,
    accounts: configuredAccounts().map(acc => [acc.id, tokenForAccount(acc.id)]) });
}

/** Read-only picker fallback. Campaign launches still use strict getProfiles(). */
export async function getProfilesForPicker({ forceRefresh = false } = {}) {
  const now = Date.now();
  const credential = pickerCredentialFingerprintInput();
  const snapshot = readRosterSnapshot(dataRoot(), 'picker', credential, { now });
  // A verified snapshot still carries the workspace owner. Preserve that
  // mapping so a later browser launch uses the matching workspace token.
  if (snapshot) for (const profile of snapshot.profiles) profileAccount.set(profile.id, profile.account);
  if (!forceRefresh && snapshot) {
    // A read-only picker should never block or repeatedly page GoLogin merely
    // because its last verified roster crossed an arbitrary one-hour mark.
    return { profiles: snapshot.profiles,
      source: now - snapshot.fetchedAt <= PICKER_ROSTER_FRESH_MS ? 'cached' : 'stale',
      fetchedAt: snapshot.fetchedAt };
  }
  if (forceRefresh) {
    // Repeated clicks must not turn a 503-profile picker into an API burst.
    if (now - lastForcedPickerRefreshAt < 60_000) {
      if (snapshot) return { profiles: snapshot.profiles, source: 'cooldown', fetchedAt: snapshot.fetchedAt };
      throw new Error('Profile refresh was just attempted. Wait a minute before trying again.');
    }
    lastForcedPickerRefreshAt = now;
  }
  try {
    const failedAccounts = [];
    const profiles = await getProfiles(undefined, { forceRefresh, onAccountFailure: id => failedAccounts.push(id) });
    if (profiles.length && failedAccounts.length === 0) saveRosterSnapshot(dataRoot(), 'picker', credential, profiles);
    return { profiles, source: failedAccounts.length ? 'partial' : 'fresh', fetchedAt: Date.now() };
  } catch (error) {
    const transient = error?.code === 'GOLOGIN_RATE_LIMIT' ||
      error?.code === 'GOLOGIN_ADMISSION_UNAVAILABLE' ||
      error?.code === 'GOLOGIN_UNAVAILABLE' ||
      /GoLogin did not answer while listing accounts/i.test(String(error?.message || ''));
    if (!transient || !snapshot) throw error;
    console.warn(`[gologin] picker using verified cached roster after ${error.code || error.name}; no campaign launch bypass`);
    return { profiles: snapshot.profiles,
      source: error?.code === 'GOLOGIN_RATE_LIMIT' ? 'limited' : 'stale',
      fetchedAt: snapshot.fetchedAt };
  } finally {
    // A multi-minute provider cooldown must not allow another full traversal
    // immediately after the first one finally returns.
    if (forceRefresh) lastForcedPickerRefreshAt = Date.now();
  }
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

// Dashboard/cloud payloads sometimes identify an account by its GoLogin
// display name (normally the login email), while the SDK launch API accepts
// only the internal profile id. Resolve either form without fuzzy matching:
// opening the wrong person's saved browser is worse than returning an error.
export function resolveProfileId(profiles, profileRef) {
  const ref = String(profileRef || '').trim();
  if (!ref) return null;
  const list = Array.isArray(profiles) ? profiles.filter(Boolean) : [];
  const byId = list.find((p) => String(p.id || '') === ref);
  if (byId) return String(byId.id);
  const key = ref.toLowerCase();
  const byName = list.filter((p) => String(p.name || '').trim().toLowerCase() === key);
  return byName.length === 1 ? String(byName[0].id) : null;
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
export async function launchProfile(profileId, _ignoredLegacyToken, { visible = false, signal, onOwnedStart } = {}) {
  startupAdmission.assertRuntimeReady();
  if (pendingLaunches.has(profileId)) throw new Error('GoLogin profile launch is already in progress');
  pendingLaunches.add(profileId);
  try {
  if (closingProfiles.has(profileId)) throw new Error('GoLogin profile shutdown is still in progress');
  if (closedProfileEvidence.get(profileId)?.browserClosed === false) throw new Error('GoLogin profile shutdown is unconfirmed; do not launch another session');
  if (signal?.aborted) throw (signal.reason instanceof Error ? signal.reason : new Error('GoLogin launch cancelled'));
  const token = await tokenForProfile(profileId);
  // Phase 2.8.20 (W3-C2): refuse to launch when free disk is below threshold.
  // Profile downloads + screenshots + logs accumulate; a full disk silently
  // corrupts state (writes return ENOSPC and the campaign limps on).
  const disk = await checkDiskFree();
  startupAdmission.assertRuntimeReady();
  if (signal?.aborted) throw signal.reason || new Error('GoLogin launch cancelled');
  if (closingProfiles.has(profileId) || closedProfileEvidence.get(profileId)?.browserClosed === false) throw new Error('GoLogin profile shutdown is pending or unconfirmed');
  if (!disk.ok) {
    throw new Error(`Disk space too low (${formatBytes(disk.freeBytes)} free, ${formatBytes(disk.thresholdBytes)} required) — clear space before launching.`);
  }

  // Recovery leaves the exact GoLogin profile open so its newly-authenticated
  // cookies are preserved. Retry must take that browser back rather than start
  // a second Orbita process against the same locked profile directory.
  if (activeProfiles.has(profileId) && activeSessions.has(profileId)) {
    if (visible) await showProfileForManualControl(profileId);
    else await prepareProfileForAutomation(profileId);
    const session = activeSessions.get(profileId);
    return { browser: session.browser, page: session.page };
  }
  console.log(`[gologin] Starting ${profileId}…`);
  // A manual Stop may close this launch only after this call has passed the
  // shared pending-launch guard. A competing campaign launch owns its own stop.
  if (typeof onOwnedStart === 'function') onOwnedStart();

  const GL = new GoLogin({
    token,
    profile_id: profileId,
    // Push the window off-screen so it doesn't steal focus
    extra_params: [
      visible ? '--window-position=60,60' : '--window-position=-2400,-2400',
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

  // Never await GL.start() bare — see withTimeout above. On timeout we still
  // own whatever Orbita process it managed to spawn, so kill it before
  // rethrowing; otherwise a stalled launch leaks a headless Chromium per retry.
  let status, wsUrl;
  const startup = guardSdkStartup(GL, { signal, onSpawn: child => {
    if (child?.pid) spawnedPids.set(profileId, child.pid);
  } });
  startingProfiles.set(profileId, startup);
  startup.source.then(() => {}, () => {}).finally(() => {
    if (startup.failed && startingProfiles.get(profileId) === startup && !activeProfiles.has(profileId)) pendingLaunches.delete(profileId);
  });
  try {
    ({ status, wsUrl } = await withTimeout(startup.promise, LAUNCH_TIMEOUT_MS, `GoLogin launch for ${profileId}`));
  } catch (err) {
    startup.failed = true;
    startup.cancel(err);
    closedProfileEvidence.set(profileId, await startup.close(confirmOwnedProcessExit));
    throw err;
  }

  const _spawnedPid = GL?.processSpawned?.pid;
  if (_spawnedPid) spawnedPids.set(profileId, _spawnedPid);

  if (status !== 'success') {
    console.warn(`[gologin] start failed for ${profileId} (status="${status}") — force-killing any spawned process`);
    startup.failed = true;
    closedProfileEvidence.set(profileId, await startup.close(confirmOwnedProcessExit));
    throw new Error(`GoLogin start failed: status="${status}"`);
  }

  activeProfiles.set(profileId, GL);
  closedProfileEvidence.delete(profileId);

  const browser = await connectWithRetry(
    () => puppeteer.connect({
      browserWSEndpoint: wsUrl,
      ignoreHTTPSErrors: true,
      // A recovery window belongs to the human until they press Retry. Do not
      // install Puppeteer's synthetic 800x600 viewport on that window.
      defaultViewport: visible ? null : { width: 1366, height: 900 },
      // 2.8.27: bumped 120s -> 180s. Slow profiles (large cookie jars, many
      // tabs from --restore-last-session) were timing out on Network.enable
      // before Puppeteer could attach. Rakibul.islam was launch-failing every
      // round all night because of this.
      protocolTimeout: 180000,
    }),
    { pid: _spawnedPid, label: profileId },
  );

  const pages = await browser.pages();
  if (signal?.aborted) { await closeProfile(profileId); throw signal.reason || new Error('GoLogin attachment cancelled'); }
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

  if (!visible) await page.setViewport({ width: 1366, height: 900 });
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
  if (!visible) await applyFocusEmulation(page, profileId);
  activeSessions.set(profileId, { browser, page });

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
  if (pid && !visible) { hideByPid(pid).catch(() => {}); }

  if (signal?.aborted) { await closeProfile(profileId); throw signal.reason || new Error('GoLogin setup cancelled'); }
  startup.detach();
  startingProfiles.delete(profileId);
  return { browser, page };
  } finally {
    // Test/recovery harnesses can evaluate launchProfile in isolation. More
    // importantly, cleanup must never mask the actual launch/abort error.
    const starts = typeof startingProfiles === 'undefined' ? null : startingProfiles;
    if (!starts || !starts.has(profileId) || starts.get(profileId).settled) pendingLaunches.delete(profileId);
  }
}

/**
 * Turn an already-running automated GoLogin profile into a normal operator
 * recovery window. This is what every "Open browser / Logged out" action uses;
 * merely unhiding the Orbita process left its synthetic viewport and forced
 * focus emulation active, which made the visible page feel locked.
 */
export async function showProfileForManualControl(profileId) {
  const GL = activeProfiles.get(profileId);
  const session = activeSessions.get(profileId);
  if (!GL || !session) return false;
  const pages = await session.browser.pages();
  const page = pages.find((p) => !p.isClosed()) || session.page;
  if (!page || page.isClosed()) return false;

  await releaseFocusEmulation(page);
  await page.setViewport(null).catch(() => {});
  const pid = GL?.processSpawned?.pid;
  if (pid) await unhideByPids([pid]);
  try {
    const client = await page.target().createCDPSession();
    const { windowId } = await client.send('Browser.getWindowForTarget');
    await client.send('Browser.setWindowBounds', {
      windowId,
      bounds: { left: 60, top: 60, width: 1600, height: 1000, windowState: 'normal' },
    });
    await client.detach();
  } catch { /* visible + native viewport are already enough */ }
  await page.bringToFront().catch(() => {});
  activeSessions.set(profileId, { browser: session.browser, page });
  console.log(`[gologin] Manual control enabled for ${profileId}`);
  return true;
}

async function prepareProfileForAutomation(profileId) {
  const GL = activeProfiles.get(profileId);
  const session = activeSessions.get(profileId);
  if (!GL || !session) return false;
  const pages = await session.browser.pages();
  const page = pages.find((p) => !p.isClosed()) || session.page;
  if (!page || page.isClosed()) return false;

  await page.setViewport({ width: 1366, height: 900 });
  await applyFocusEmulation(page, profileId);
  try {
    const client = await page.target().createCDPSession();
    const { windowId } = await client.send('Browser.getWindowForTarget');
    await client.send('Browser.setWindowBounds', {
      windowId,
      bounds: { left: -2400, top: -2400, width: 1366, height: 900, windowState: 'normal' },
    });
    await client.detach();
  } catch { /* hiding is best-effort */ }
  const pid = GL?.processSpawned?.pid;
  if (pid) await hideByPid(pid);
  activeSessions.set(profileId, { browser: session.browser, page });
  console.log(`[gologin] Automation control restored for ${profileId}`);
  return true;
}

export async function closeProfile(profileId) {
  if (closingProfiles.has(profileId)) return closingProfiles.get(profileId);
  const starts = typeof startingProfiles === 'undefined' ? null : startingProfiles;
  const pending = typeof pendingLaunches === 'undefined' ? null : pendingLaunches;
  const startup = starts?.get(profileId);
  if (startup) {
    const evidence = await startup.close(confirmOwnedProcessExit);
    closedProfileEvidence.set(profileId, evidence);
    if (!evidence.browserClosed) return evidence;
    if (startup.settled) { startup.detach(); starts?.delete(profileId); pending?.delete(profileId); }
    if (!activeProfiles.has(profileId)) return evidence;
  }
  const GL = activeProfiles.get(profileId);
  if (!GL) return closedProfileEvidence.get(profileId) || { browserClosed: false };
  const closing = (async () => {
    try { GL.killBrowser(); } catch (err) { console.warn(`[gologin] killBrowser warning: ${err.message}`); }
    const evidence = await confirmOwnedProcessExit(GL.processSpawned);
    closedProfileEvidence.set(profileId, evidence);
    if (evidence.browserClosed && activeProfiles.get(profileId) === GL) {
      activeProfiles.delete(profileId);
      activeSessions.delete(profileId);
      spawnedPids.delete(profileId);
      Promise.resolve().then(() => GL.stopAndCommit({ posting: true }, false))
        .catch(err => console.warn(`[gologin] background commit for ${profileId}: ${err.message}`));
    }
    return evidence;
  })();
  closingProfiles.set(profileId, closing);
  try { return await closing; }
  finally { if (closingProfiles.get(profileId) === closing) closingProfiles.delete(profileId); }
}

export async function closeAllProfiles() {
  // Phase 2.8.10: parallel close. Each GL.stop() can take 2-5s for the
  // GoLogin SDK to sync profile state to the cloud — serialized that means
  // 8-20s wall-clock with 4 profiles. Run in parallel: ~5s for all of them.
  // closeProfile already swallows its own errors so Promise.all won't reject.
  const ids = [...new Set([...activeProfiles.keys(), ...startingProfiles.keys()])];
  await Promise.all(ids.map(id => closeProfile(id)));

  // v2.86.14: safety net — SIGKILL any browser WE spawned that escaped
  // activeProfiles (failed launch / close that didn't take). Only PIDs we
  // recorded in spawnedPids — never a name-matched or operator-opened browser.
  const activePids = new Set(getActiveBrowserPids());
  const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
  const orphans = selectOrphanPids({ spawned: spawnedPids, activePids, isAlive });
  for (const pid of orphans) {
    console.warn(`[gologin] orphan Orbita pid ${pid} survived close — SIGKILL`);
    try { process.kill(pid, 'SIGKILL'); } catch { /* */ }
  }
  for (const [pidProfile, pid] of [...spawnedPids.entries()]) {
    if (!isAlive(pid)) spawnedPids.delete(pidProfile);
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
