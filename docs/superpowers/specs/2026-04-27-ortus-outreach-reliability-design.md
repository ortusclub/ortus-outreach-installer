# Ortus Outreach — Reliability Under Stress

**Date:** 2026-04-27
**Lens:** B (Reliability under stress) — colleagues' slow/overloaded laptops
**Approach:** 3-wave surgical patch series, single spec scoping all three waves
**Target version:** 2.8.20
**Memory anchors:** colleagues run on overloaded machines; never modify core campaign logic; user has been burned by broken changes — bias toward additive code.

## Scope

Seven patches across three waves. All patches are **additive** — they add new state fields, new files, new endpoints, new wrappers, or new pre/post-flight checks. None modifies the existing campaign loop's success path.

| Wave | Patches | Theme | Risk |
|---|---|---|---|
| **W1 — Observability** | B1, B2, C1 | "Show what's happening / went wrong" | Low |
| **W2 — Recovery mechanics** | A1, A2 | "Catch hangs and boot-outs early" | Medium |
| **W3 — Maintenance** | C2, D1 | "Don't grow forever" | Low |

Each wave is independently shippable and revertible. Plan/execute proceeds wave-by-wave with manual browser verification between waves.

**Out of scope:**
- Any change to `performOutreach` internals (`src/linkedin/outreach.js` and `src/linkedin/actions.js` are off-limits)
- Any change to the existing retry / backoff / parking thresholds (3 retries, 15/30/45s backoff, BATCH_SIZE=5 — all preserved)
- Any change to `decideThrottle` engagement/release thresholds (RAM 90/80, load 0.9/0.7)
- New monitoring infrastructure (Datadog, Sentry, etc.) — local persistence + UI only
- Any redesign of the existing throttle banner / Live Cockpit

---

## Wave 1 — Observability

### B1 — Surface parked profiles in the UI

**Problem:** `src/campaign.js:1023-1032` parks a profile after `BATCH_SIZE` (5) consecutive non-success outcomes via `log()` only. The campaign cockpit and right pane show no signal that an account has been benched.

**Change:**

In `src/campaign.js`:
- Add `parkedProfiles: []` to the `campaign` state object near line 170 (alongside `running`, `_abort`, `errors`, etc.)
- Reset to `[]` in `startCampaign()` alongside the other resets (around line 461)
- At the parking site (line ~1023), push `{ profileId, pName, parkedAt: Date.now(), reason: 'consecutive_skips', skipCount }` to `campaign.parkedProfiles`
- Include `parked: campaign.parkedProfiles.slice()` in the `getCampaignStatus()` payload (around line 1329)

In `public/index.html`:
- Add a new right-pane row `Parked` between `Status` and `Passover` (so it's visible during runs):
  ```html
  <div class="rp-section" id="rp-parked-row" hidden>
    <div class="rp-label" data-edit="rp-label-parked">Parked</div>
    <div class="rp-parked-line" id="rp-parked-line">—</div>
    <div class="rp-parked-detail" id="rp-parked-detail" hidden></div>
  </div>
  ```

In `public/css/style.css`:
- New `.rp-parked-line` and `.rp-parked-detail` rules (using existing `--gray`, `--red` tokens)
- The row text uses `--red` color when count > 0 to draw attention

In `public/js/app.js`:
- In the existing campaign-status polling code (find via `grep -n "/api/campaign/status"`), read `data.parked` array
- Show/hide `#rp-parked-row`; render count + names; clicking the line toggles a detail popover with `{pName, reason, parkedAt-as-relative-time}` per row

**Acceptance:** During a run where one profile gets parked (manually triggerable by setting BATCH_SIZE=1 in env temporarily for testing), the right pane shows "1 parked · <name>" in red within one polling interval. Clicking expands the detail.

### B2 — Persist campaign errors to disk

**Problem:** `campaign.errors` (`src/campaign.js:185`) is a module-local in-memory array. It's reset on every `startCampaign()` (line ~467) AND wiped if the operator refreshes the dashboard. Operators lose all error history.

**Change:**

In `src/campaign.js`:
- New helper `appendErrorLog(entry)` that:
  - Reads `data/errors.log.json` (or treats missing file as `[]`)
  - Appends the new entry: `{ at: ISO timestamp, message, profileId?, profileName?, leadUrl? }`
  - Caps the array at `MAX_ERROR_LOG_ENTRIES` (default 500), dropping oldest
  - Writes back atomically (write-to-tmp + rename)
- Modify `pushError(err)` (line 208) to call `appendErrorLog` after the existing `campaign.errors.push(...)` — keep the in-memory array (it's still useful for the live `/api/campaign/status` payload)

In `server.js`:
- New endpoint `GET /api/errors` (read-only, returns the JSON file contents — empty array if missing)
- Place above the existing `app.get('/api/notify/status', ...)` endpoint we shipped in 2.8.19

In `public/js/app.js`:
- Add a `loadPersistedErrors()` helper that fetches `/api/errors` and merges with the in-memory `campaign.errors` from the status payload (deduplicated by `at + message`)
- The existing errors-rendering surface (the `#hero-errors` count and any errors panel) uses the merged list

**Acceptance:**
- Trigger an error during a run (e.g., bad sheet URL).
- Refresh the dashboard.
- The error count + content survive the refresh.
- File `data/errors.log.json` exists and contains the entry.

### C1 — Uncaught exception/rejection handlers

**Problem:** `gracefulShutdown` (`server.js:1078`) only catches `SIGINT`/`SIGTERM`. An uncaught synchronous throw or an unhandled Promise rejection crashes the Node process — leaving GoLogin Chromium browsers as orphan processes and skipping the cloud-commit phase.

**Change:**

In `server.js`:
- Add immediately after the existing SIGINT/SIGTERM handlers (line ~1095):
  ```js
  process.on('uncaughtException', (err) => {
    appendFatalErrorSync({ at: new Date().toISOString(), kind: 'uncaughtException', message: err.message, stack: err.stack });
    console.error(`[fatal] uncaughtException: ${err.message}`);
    gracefulShutdown('FATAL').catch(() => process.exit(1));
  });
  process.on('unhandledRejection', (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : '';
    appendFatalErrorSync({ at: new Date().toISOString(), kind: 'unhandledRejection', message, stack });
    console.error(`[fatal] unhandledRejection: ${message}`);
    gracefulShutdown('FATAL').catch(() => process.exit(1));
  });
  ```
- Add `appendFatalErrorSync(entry)` helper using `fs.appendFileSync` (sync because the process is dying — async writes risk being dropped). Writes one JSON line to `data/fatal-errors.log` (line-delimited JSON, not array — keeps appends cheap and crash-safe).
- `gracefulShutdown('FATAL')` is the same function but with the new signal name; the existing log line will say `[shutdown] FATAL received...`

**Acceptance:**
- Manually trigger via `node -e "setTimeout(() => { throw new Error('test'); }, 100)"` against a test instance, OR
- Add a temporary `/api/test-crash` route during dev that throws → confirm `data/fatal-errors.log` gets a line + browsers close cleanly.

---

## Wave 2 — Recovery mechanics

### A1 — Hung-lead watchdog

**Problem:** `performOutreach` (called at `src/campaign.js:881`) can in theory hang without throwing — e.g., a Puppeteer `page.click` that completes at the protocol level but never produces a follow-up event. The 120-second `protocolTimeout` (`src/gologin-launcher.js:91`) is the only backstop. Operators see "Connecting…" indefinitely.

**Change:**

In `src/campaign.js`:
- Define `LEAD_TIMEOUT_MS = Number(process.env.LEAD_TIMEOUT_MS) || 90000` near the top constants
- New helper:
  ```js
  function withWatchdog(promise, timeoutMs, profileId) {
    let timer;
    const watchdog = new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(
        new Error('lead_timeout_watchdog'),
        { kind: 'watchdog', profileId, timeoutMs }
      )), timeoutMs);
    });
    return Promise.race([promise, watchdog]).finally(() => clearTimeout(timer));
  }
  ```
- Wrap the existing `performOutreach` call:
  ```js
  // before:
  result = await performOutreach(page, url, { ...tpl, data }, { profileId }, hint);
  // after:
  try {
    result = await withWatchdog(
      performOutreach(page, url, { ...tpl, data }, { profileId }, hint),
      LEAD_TIMEOUT_MS,
      profileId,
    );
  } catch (err) {
    if (err.kind === 'watchdog') {
      log(`  ⏱ ${pName}: lead timed out after ${LEAD_TIMEOUT_MS / 1000}s — ${url}`);
      result = { action: 'skipped', error: 'lead_timeout_watchdog' };
    } else {
      throw err;
    }
  }
  ```
- Add `'lead_timeout_watchdog'` to `TRANSIENT_SIGNALS` (line 901) so the existing 3-retry/backoff logic kicks in for watchdog timeouts

**Risk note:** When the watchdog fires, the underlying `performOutreach` promise is still running. It may eventually settle (success or error), but its result is discarded. This means an in-flight Puppeteer call could in theory land a connection request after the timeout — looking like a duplicate to LinkedIn's server, but harmless on our side (state.json `processed` map only writes when we observe success). If duplicate-side-effects become a concern, future work would need explicit cancellation tokens.

**Acceptance:**
- Set `LEAD_TIMEOUT_MS=2000` in env, run a campaign — most leads will time out and the log shows `lead_timeout_watchdog` lines
- Reset to default, confirm normal behavior

### A2 — Session-expired detection

**Problem:** If LinkedIn boots the operator mid-campaign (cookies expired, IP flagged, account locked), the campaign loop keeps trying. Each lead fails identically until the 5-skip parking finally kicks in. Operators waste 5+ leads on a dead session.

**Change:**

In `src/campaign.js`:
- Extend `checkProfileHealth(page, profileName)` (line 284) with a session-validity probe BEFORE the existing checks:
  ```js
  // Phase 2.8.20 (A2): session-expired detection — if /feed redirects to /login,
  // the cookies are gone. Park immediately rather than burning 5 retries.
  try {
    const cur = page.url();
    if (cur && (cur.includes('/login') || cur.includes('/uas/login') || cur.includes('/checkpoint'))) {
      return { page: null, ok: false, sessionExpired: true };
    }
  } catch (_) { /* fall through to normal checks */ }
  ```
- The single primary call site to verify is `ensureProfileLoggedIn(launched, profileId, pName)` (`src/campaign.js:350`). Plan should grep for `checkProfileHealth` and `ensureProfileLoggedIn` to find all call sites; for each, when the returned object has `sessionExpired: true`, push to `parkedProfiles` (B1's mechanism) with `reason: 'session_expired'` AND set a profile-local "skip rest of run" flag so the outer loop drops this profile from the round-robin until the campaign ends
- Add a constant `SESSION_CHECK_FREQUENCY = Number(process.env.SESSION_CHECK_FREQUENCY) || 1` — meaning "check every Nth batch" (default 1 = every batch); set higher for performance if needed

**Risk note:** The probe is a property read (`page.url()`) — no network call, no rate-limit pressure. False positives are unlikely because we only key on three specific URL substrings.

**Acceptance:**
- Manually log out of LinkedIn in a local-browser profile mid-campaign
- The next batch detects expiry within one health-check interval
- `parkedProfiles` shows the profile with `reason: 'session_expired'`
- The right pane (B1) surfaces "1 parked · session expired"

---

## Wave 3 — Maintenance

### C2 — Disk-space pre-check

**Problem:** Colleagues' overloaded laptops fill up. GoLogin profile downloads, `data/local-profile/`, screenshots, and accumulating logs all consume disk. A full disk produces silent failures (writes return `ENOSPC` and the campaign limps on with corrupt state).

**Change:**

New file `src/disk-check.js`:
```js
import { statfs } from 'node:fs/promises';
import { dataPath } from './paths.js';

const DEFAULT_THRESHOLD_BYTES = 1 * 1024 * 1024 * 1024; // 1 GB

export async function checkDiskFree(thresholdBytes = DEFAULT_THRESHOLD_BYTES) {
  try {
    const stats = await statfs(dataPath('.'));
    const freeBytes = stats.bavail * stats.bsize;
    return { freeBytes, thresholdBytes, ok: freeBytes >= thresholdBytes, error: null };
  } catch (err) {
    // Treat statfs failure as "ok" — don't block the operator on detection failure
    return { freeBytes: null, thresholdBytes, ok: true, error: err.message };
  }
}
```

In `src/gologin-launcher.js`:
- Before the body of `launchProfile` (line 56), call `checkDiskFree`. If `!ok`, throw a clear error with the free-bytes value.
- Local launcher (`src/local-launcher.js`) gets the same check at `launchLocalBrowser`.

In `server.js`:
- New endpoint `GET /api/disk-status` returns the result of `checkDiskFree`
- The existing `/api/campaign/status` payload also includes `disk: { freeBytes, ok }` (sampled lazily — we can piggyback on the existing 5s ambient sampler if cheap)

In `public/index.html` + `public/js/app.js` + `public/css/style.css`:
- Add a single full-width banner element `#disk-warning-banner` that sits directly below `#header-stats` (above any sections). Shown only when `disk.ok === false`. Format: `Disk: <free-formatted> free — clear space before launching` using `--red` color, no icon, hairline border. Hidden via `hidden` attribute by default.
- Update from `disk` field in the `/api/campaign/status` payload (already polled), so no new client-side polling needed.

**Acceptance:**
- Set threshold via env var (e.g. `DISK_FREE_THRESHOLD_BYTES=999999999999` for 1TB) — banner appears
- Reset; banner disappears
- `launchProfile` throws when threshold not met

### D1 — `state.json` pruning

**Problem:** `data/state.json` `processed` map adds one entry per lead, forever. With 50K leads in BigQuery (per memory: `Ortus BigQuery contact database`), this could grow to multi-MB and slow `loadState`/`saveState` on every campaign start.

**Change:**

In `src/campaign.js`:
- Add `STATE_RETENTION_DAYS = Number(process.env.STATE_RETENTION_DAYS) || 60` near top constants
- Modify `loadState()` (line 92):
  ```js
  async function loadState() {
    let s;
    try { s = JSON.parse(await readFile(STATE_FILE, 'utf8')); }
    catch { return { processed: {}, dailyCounts: {} }; }

    // Phase 2.8.20 (D1): prune entries older than retention window.
    // Semantics: a lead untouched for N days is "forgotten" — fair game to retry.
    const cutoff = Date.now() - STATE_RETENTION_DAYS * 86400000;
    let pruned = 0;
    for (const [url, entry] of Object.entries(s.processed || {})) {
      const ts = entry?.date ? Date.parse(entry.date) : NaN;
      if (Number.isFinite(ts) && ts < cutoff) {
        delete s.processed[url];
        pruned++;
      }
    }
    if (pruned > 0) {
      console.log(`[state] pruned ${pruned} entries older than ${STATE_RETENTION_DAYS}d`);
    }
    return s;
  }
  ```
- No change to `saveState` — pruning happens once at load time, persisted by the next `saveState` call

**Risk note:** Pruning is irreversible — the pruned entry is dropped from disk on next save. The 60-day default means a lead you connected with 61 days ago could be re-attempted on a fresh sheet upload. Configurable via env. Operators who run rare campaigns (e.g., monthly) and want longer memory should set `STATE_RETENTION_DAYS=180` or similar.

**Acceptance:**
- Backfill `data/state.json` with synthetic entries having `date` 70 days old
- Restart the server; the next `loadState` logs `[state] pruned N entries` and the file shrinks on next save
- Default value (60) is documented in the spec; env override path is clear

---

## Files touched (cumulative across all 3 waves)

| File | Waves | Change type |
|---|---|---|
| `src/campaign.js` | W1 (B1, B2), W2 (A1, A2), W3 (D1) | Add state fields, helper functions, watchdog wrapper, session probe, retention prune in loadState |
| `src/gologin-launcher.js` | W3 (C2) | Pre-launch disk check |
| `src/local-launcher.js` | W3 (C2) | Pre-launch disk check |
| `src/disk-check.js` | W3 (C2) | NEW file |
| `server.js` | W1 (B2, C1), W3 (C2) | New endpoints, fatal handlers, status payload addition |
| `public/index.html` | W1 (B1), W3 (C2) | Right-pane parked row, disk banner |
| `public/js/app.js` | W1 (B1, B2), W3 (C2) | Render parked, fetch persisted errors, render disk banner |
| `public/css/style.css` | W1 (B1), W3 (C2) | Parked row + disk banner styles |

NEW files: `src/disk-check.js`, `data/errors.log.json` (created at runtime), `data/fatal-errors.log` (created at runtime).
NO change to: `src/linkedin/*`, `src/auth.js`, `src/sheets*.js`, `src/gologin-launcher.js`'s outreach paths.

## Acceptance per wave

**Wave 1 passes when:**
- Right-pane Parked row shows when an account is parked (red, with name + reason); hidden when none
- `data/errors.log.json` accumulates across runs and refreshes; UI errors panel shows them after reload
- Triggered uncaughtException writes to `data/fatal-errors.log` and graceful shutdown closes browsers cleanly

**Wave 2 passes when:**
- A campaign with `LEAD_TIMEOUT_MS=2000` shows `lead_timeout_watchdog` log lines and retries via existing transient-error path
- Logging out of LinkedIn mid-campaign on a local-browser profile produces a `parkedProfiles` entry with `reason: 'session_expired'` within one health-check cycle

**Wave 3 passes when:**
- `/api/disk-status` returns the right shape; banner appears when threshold breached; `launchProfile` throws when disk full
- `loadState()` prunes entries older than 60 days and logs the pruned count

## Sequencing & versioning

Single spec, three waves, sequential plan-execute:

1. Write plan → execute Wave 1 → checkpoint (user verifies in browser) → continue
2. Execute Wave 2 → checkpoint
3. Execute Wave 3 → checkpoint
4. FINAL: bump `package.json` to **2.8.20**, run `npm test`, walk acceptance criteria

If any wave reveals issues that warrant rework, we revert that wave's commits and revise before continuing.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Watchdog drops a Puppeteer call mid-flight (A1) — could create duplicate side-effect on LinkedIn | Spec acknowledges; future work would add cancellation tokens. State.json `processed` map only writes on observed success, so our local state stays consistent. |
| Session-probe URL substring matching (A2) produces false positives | Three explicit substrings (`/login`, `/uas/login`, `/checkpoint`) — well-known LinkedIn auth-flow URLs. False positives possible if LinkedIn introduces a new pattern; mitigated by the probe only running at health-check time, not per-action. |
| `errors.log.json` write contention if multiple campaigns run concurrently (B2) | Campaigns are serialized server-side (`if (campaign.running) throw`) so only one writer at a time. |
| State pruning is irreversible (D1) | Default 60 days is conservative; env-overridable; clear log line on each prune. |
| Disk-check `statfs` not on all Node versions (C2) | Node ≥18.15 supports it. Project requires Node ≥22 (per `package.json` engines). Try/catch falls through to `ok: true` if call fails. |
| New right-pane Parked row adds visual clutter when nothing's parked | Row hidden via `hidden` attribute when `parkedProfiles` is empty. |

## Dependencies

None. All work uses existing patterns and modules. No new npm packages, no new external services.
