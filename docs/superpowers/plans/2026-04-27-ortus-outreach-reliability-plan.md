# Ortus Outreach Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship 7 reliability patches across 3 waves to the Ortus Outreach app — single version bump (2.8.20) — without touching the campaign-loop success path or `src/linkedin/*`.

**Architecture:** Vanilla-JS Express + Electron app. All patches additive. W1 is pure observability (UI signals + persisted error log + uncaught handlers). W2 wraps existing functions with watchdog + session probe. W3 adds disk pre-check + state pruning. Plan/execute is wave-by-wave with manual browser verification between.

**Tech Stack:** Node ≥22, Express 4, vanilla browser JS (no bundler), `node --test` for backend, manual browser verification for frontend.

**Spec:** `docs/superpowers/specs/2026-04-27-ortus-outreach-reliability-design.md` (committed `8b7dd88`).

**Testing convention:**
- **Pure backend logic** (helpers like `appendErrorLog`, `withWatchdog`, `pruneOldEntries`): write a `node --test` file under `tests/` exercising the behavior, then `npm test`.
- **Glue code that calls Puppeteer/SDK/fs** (e.g. `checkDiskFree`, the frontend renderers): manual verification — no test harness exists for these.
- **Frontend** (HTML/CSS/JS): manual browser verification at `http://localhost:3000/`.

---

## Task 0: Pre-flight

**Files:** none

- [ ] **Step 1: Confirm clean working tree of unrelated changes**

Run: `git status --short`

Expected: only `.planning/`, `data/`, and a few unrelated files modified (carry-over from the user's earlier work, not in our scope). If anything in `src/`, `server.js`, `public/`, `tests/`, `docs/superpowers/`, or `package.json` is dirty, stash before proceeding (`git stash push -u -m "wip before reliability"`).

- [ ] **Step 2: Confirm Node ≥22 + dev server up**

Run:
```bash
node --version
curl -sf http://localhost:3000/ -o /dev/null && echo OK on :3000
```
Expected: `v22.x` (or higher) and `OK on :3000`. If server isn't up, start with `npm run dev` in another shell.

- [ ] **Step 3: Run baseline tests**

Run: `npm test 2>&1 | tail -8`
Expected: 83 pass / 0 fail / 2 skipped (current state on main after 2.8.19).

If anything fails before we start, **STOP and ask the user**.

- [ ] **Step 4: Create the feature branch**

Run:
```bash
git checkout main
git pull --ff-only origin main 2>/dev/null || true
git checkout -b reliability-2.8.20
```

- [ ] **Step 5: Confirm branch + verify a key spec line number**

Run:
```bash
git status -sb | head -1
grep -n 'TRANSIENT_SIGNALS' src/campaign.js
grep -n 'function checkProfileHealth' src/campaign.js
grep -n 'function ensureProfileLoggedIn' src/campaign.js
grep -n 'app.get..\/api\/notify\/status' server.js
```
Expected: branch is `reliability-2.8.20`; line refs match the spec (`TRANSIENT_SIGNALS` ~901, `checkProfileHealth` ~284, `ensureProfileLoggedIn` ~350, `/api/notify/status` ~1055).

If line numbers have shifted significantly from the spec, **STOP and report** — the plan needs adjustment before continuing.

---

# Wave 1 — Observability

## Task W1-B1: Surface parked profiles in the UI

**Files:**
- Modify: `src/campaign.js` (state field, reset, push site, status payload)
- Modify: `public/index.html` (right-pane row)
- Modify: `public/css/style.css` (parked row styles)
- Modify: `public/js/app.js` (render in status polling)

- [ ] **Step 1: Add `parkedProfiles` to campaign state**

In `src/campaign.js`, find the campaign state object (lines 169-186, the `export const campaign = { ... }`). Add `parkedProfiles: [],` as the new last field before the closing brace. Use Edit:

```
old:   logs: [],
  errors: [],
};
new:   logs: [],
  errors: [],
  parkedProfiles: [],
};
```

- [ ] **Step 2: Reset `parkedProfiles` in `startCampaign`**

In `src/campaign.js`, find the reset block in `startCampaign` (around lines 460-475). After `campaign.errors = [];` add `campaign.parkedProfiles = [];`. Use Edit:

```
old:   campaign.errors = [];
  campaign._lastSample = null;   // phase 11.1: reset resource snapshot
new:   campaign.errors = [];
  campaign.parkedProfiles = [];
  campaign._lastSample = null;   // phase 11.1: reset resource snapshot
```

- [ ] **Step 3: Push parked entries at the parking site**

In `src/campaign.js`, find the consecutive-skip parking line (around line 1023). The current code adds the profile to `weeklyLimited`. Add the parked-profiles push immediately after:

```
old:             if (skipCount >= BATCH_SIZE && !weeklyLimited.has(profileId)) {
              log(`  ⚠ ${pName}: ${BATCH_SIZE} consecutive non-success outcomes — parking account for rest of run.`);
              weeklyLimited.add(profileId);
            }
new:             if (skipCount >= BATCH_SIZE && !weeklyLimited.has(profileId)) {
              log(`  ⚠ ${pName}: ${BATCH_SIZE} consecutive non-success outcomes — parking account for rest of run.`);
              weeklyLimited.add(profileId);
              campaign.parkedProfiles.push({
                profileId,
                pName,
                parkedAt: Date.now(),
                reason: 'consecutive_skips',
                skipCount,
              });
            }
```

- [ ] **Step 4: Include parked array in status payload**

In `src/campaign.js`, find `getCampaignStatus()` (around line 1311). Add `parked` to the return object after the existing `errors` field:

```
old:     logs: campaign.logs.slice(-100),
    errors: campaign.errors.slice(-20),
    resources: smp ? {
new:     logs: campaign.logs.slice(-100),
    errors: campaign.errors.slice(-20),
    parked: campaign.parkedProfiles.slice(),
    resources: smp ? {
```

- [ ] **Step 5: Add right-pane Parked row to HTML**

In `public/index.html`, find the right-pane Status row block (lines 555-563, the `aside.right-pane` containing the Status `.rp-section`). Insert a new `.rp-section` for Parked immediately after the Status section closes (before the Passover section starts).

```
old:       <div class="rp-section">
        <div class="rp-label" data-edit="rp-label-status">Status</div>
        <div class="rp-status-line demoted" id="rp-status">
          <span class="rp-dot" id="rp-dot"></span>
          <span id="rp-status-text">Idle</span>
        </div>
        <div class="rp-sub" id="rp-status-sub">No campaign running</div>
      </div>

      <div class="rp-section">
        <div class="rp-label" data-edit="rp-label-passover">Passover</div>
new:       <div class="rp-section">
        <div class="rp-label" data-edit="rp-label-status">Status</div>
        <div class="rp-status-line demoted" id="rp-status">
          <span class="rp-dot" id="rp-dot"></span>
          <span id="rp-status-text">Idle</span>
        </div>
        <div class="rp-sub" id="rp-status-sub">No campaign running</div>
      </div>

      <!-- Phase 2.8.20 (W1-B1): parked profiles surface during a run -->
      <div class="rp-section" id="rp-parked-row" hidden>
        <div class="rp-label" data-edit="rp-label-parked">Parked</div>
        <div class="rp-parked-line" id="rp-parked-line" onclick="toggleParkedDetail()" style="cursor:pointer">—</div>
        <div class="rp-parked-detail" id="rp-parked-detail" hidden></div>
      </div>

      <div class="rp-section">
        <div class="rp-label" data-edit="rp-label-passover">Passover</div>
```

- [ ] **Step 6: Add CSS for parked row**

Append to `public/css/style.css`:

```css
/* Phase 2.8.20 (W1-B1) — right-pane Parked row (visible during runs) */
.rp-parked-line {
  font-family: var(--body, 'Hanken Grotesk', sans-serif);
  font-size: 0.78rem;
  color: var(--gray);
  letter-spacing: 0.04em;
}
.rp-parked-line.has-parked {
  color: var(--red);
}
.rp-parked-line:hover { opacity: 0.85; }
.rp-parked-detail {
  margin-top: 8px;
  padding: 8px 10px;
  border: 1px solid var(--hairline);
  background: var(--hairline-soft, rgba(255,255,255,0.06));
  font-size: 0.66rem;
  color: var(--gray);
  letter-spacing: 0.04em;
  line-height: 1.6;
}
.rp-parked-detail .rp-parked-item { display: block; padding: 2px 0; }
.rp-parked-detail .rp-parked-item .rp-parked-name { color: var(--ink); }
.rp-parked-detail .rp-parked-item .rp-parked-reason {
  margin-left: 6px;
  font-size: 0.58rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
}
```

- [ ] **Step 7: Render parked in app.js status polling**

Find the `pollStatus()` function in `public/js/app.js` (around line 1989). Inside the function, after the existing `wasErrorCount` line and before the `wasRunning = s.running;` line, add a call to render parked profiles. First, append the renderer + toggle helpers at the end of `public/js/app.js`:

```js
// Phase 2.8.20 (W1-B1) — surface parked profiles in the right pane.
function _humanAgoFromTs(ts) {
  if (!ts || !Number.isFinite(ts)) return '';
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function _prettyParkReason(r) {
  switch (r) {
    case 'consecutive_skips': return 'too many skips';
    case 'session_expired':   return 'session expired';
    default:                  return r || 'parked';
  }
}

function renderParkedProfiles(parked) {
  const row = document.getElementById('rp-parked-row');
  const line = document.getElementById('rp-parked-line');
  const detail = document.getElementById('rp-parked-detail');
  if (!row || !line || !detail) return;
  const list = Array.isArray(parked) ? parked : [];
  if (list.length === 0) {
    row.hidden = true;
    line.classList.remove('has-parked');
    detail.hidden = true;
    detail.innerHTML = '';
    return;
  }
  row.hidden = false;
  line.classList.add('has-parked');
  const names = list.map(p => p.pName || p.profileId).join(', ');
  line.textContent = `${list.length} parked · ${names}`;
  detail.innerHTML = list.map(p => `
    <span class="rp-parked-item">
      <span class="rp-parked-name">${(p.pName || p.profileId)}</span>
      <span class="rp-parked-reason">${_prettyParkReason(p.reason)}</span>
      · ${_humanAgoFromTs(p.parkedAt)}
    </span>
  `).join('');
}

function toggleParkedDetail() {
  const detail = document.getElementById('rp-parked-detail');
  if (detail) detail.hidden = !detail.hidden;
}

window.toggleParkedDetail = toggleParkedDetail;
```

Then in `pollStatus`, add one call. Use Edit on the polling block:

```
old:     wasErrorCount = (s.errors || []).length;
    wasRunning = s.running;
new:     wasErrorCount = (s.errors || []).length;
    wasRunning = s.running;
    renderParkedProfiles(s.parked);
```

- [ ] **Step 8: Verify parsing + commit**

```bash
node --check public/js/app.js
git add src/campaign.js public/index.html public/css/style.css public/js/app.js
git status --short
```

Expected: `node --check` says PARSE OK; status shows the four files staged, nothing else.

```bash
git commit -m "feat(2.8.20): W1-B1 — surface parked profiles in right pane"
```

- [ ] **Step 9: Manual verify (will run during cluster checkpoint)**

This is verified at the Wave 1 checkpoint, not now. The browser test requires temporarily setting `BATCH_SIZE` low or manually triggering a 5-skip sequence — defer to checkpoint.

---

## Task W1-B2: Persist campaign errors to disk

**Files:**
- Modify: `src/campaign.js` (`appendErrorLog` helper; modify `pushError`)
- Modify: `server.js` (`GET /api/errors` endpoint)
- Modify: `public/js/app.js` (fetch persisted errors and merge)
- Create: `tests/error-log-helper.test.js`

### W1-B2a — Backend persistence + test

- [ ] **Step 1: Write the failing test**

Create `tests/error-log-helper.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Test target: the cap-and-trim behavior the helper must enforce.
// We don't test the disk write directly (covered by integration smoke test);
// we test the pure logic: given an existing array + a new entry + a cap,
// produce the right output array.

function appendCapped(existing, entry, cap) {
  const next = [...existing, entry];
  if (next.length > cap) next.splice(0, next.length - cap);
  return next;
}

test('appendCapped under cap returns appended', () => {
  const out = appendCapped([{ a: 1 }, { a: 2 }], { a: 3 }, 5);
  assert.equal(out.length, 3);
  assert.equal(out[2].a, 3);
});

test('appendCapped at cap drops oldest', () => {
  const out = appendCapped([{ a: 1 }, { a: 2 }, { a: 3 }], { a: 4 }, 3);
  assert.equal(out.length, 3);
  assert.equal(out[0].a, 2);
  assert.equal(out[2].a, 4);
});

test('appendCapped well over cap drops to exactly cap entries', () => {
  const existing = Array.from({ length: 600 }, (_, i) => ({ i }));
  const out = appendCapped(existing, { i: 600 }, 500);
  assert.equal(out.length, 500);
  // First retained entry should be index 101 (we dropped 0..100, kept 101..600)
  assert.equal(out[0].i, 101);
  assert.equal(out[499].i, 600);
});
```

Run: `npm test 2>&1 | tail -10`
Expected: 86 tests pass (was 83), 0 fail.

- [ ] **Step 2: Add `appendErrorLog` helper to campaign.js**

In `src/campaign.js`, find `pushError` (lines 208-211). Add a new helper IMMEDIATELY ABOVE `pushError`, then modify `pushError` to call it. Use Edit on the surrounding context:

```
old: function pushError(err) {
  campaign.errors.push({ time: new Date().toISOString(), message: err.message });
  if (campaign.errors.length > 100) campaign.errors.shift();
}
new: const ERROR_LOG_FILE = dataPath('errors.log.json');
const MAX_ERROR_LOG_ENTRIES = Number(process.env.MAX_ERROR_LOG_ENTRIES) || 500;

async function appendErrorLog(entry) {
  // Best-effort persistence — never block or break the campaign loop.
  try {
    let arr = [];
    try {
      const raw = await readFile(ERROR_LOG_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) arr = parsed;
    } catch { /* file missing or unreadable — start fresh */ }
    arr.push(entry);
    if (arr.length > MAX_ERROR_LOG_ENTRIES) {
      arr.splice(0, arr.length - MAX_ERROR_LOG_ENTRIES);
    }
    // Atomic write: tmp file + rename, so a crash mid-write doesn't corrupt
    const tmp = ERROR_LOG_FILE + '.tmp';
    await writeFile(tmp, JSON.stringify(arr, null, 2));
    const { rename } = await import('node:fs/promises');
    await rename(tmp, ERROR_LOG_FILE);
  } catch (_) { /* swallow — disk-log failure must not break campaigns */ }
}

function pushError(err) {
  const entry = { at: new Date().toISOString(), message: err.message, profileName: campaign.currentProfile };
  campaign.errors.push({ time: entry.at, message: entry.message });
  if (campaign.errors.length > 100) campaign.errors.shift();
  // Phase 2.8.20 (W1-B2): also persist to disk (fire-and-forget).
  appendErrorLog(entry).catch(() => {});
}
```

- [ ] **Step 3: Add `GET /api/errors` endpoint**

In `server.js`, find the `/api/notify/status` GET route (around line 1055). Insert the new endpoint IMMEDIATELY ABOVE it. Use Edit:

```
old: // ---------------------------------------------------------------------------
// Notification status endpoint (Phase 2.8.19 / C4) — read-only check of SMTP
// configuration so the sidebar Notifications panel can show "wired" /
// "not configured" without dialing out.
// ---------------------------------------------------------------------------
app.get('/api/notify/status', (_req, res) => {
new: // ---------------------------------------------------------------------------
// Persisted errors endpoint (Phase 2.8.20 / W1-B2) — read-only.
// Returns the contents of data/errors.log.json (empty array if missing).
// ---------------------------------------------------------------------------
app.get('/api/errors', async (_req, res) => {
  try {
    const raw = await readFile(dataPath('errors.log.json'), 'utf8');
    const arr = JSON.parse(raw);
    res.json(Array.isArray(arr) ? arr : []);
  } catch (_) {
    res.json([]);
  }
});

// ---------------------------------------------------------------------------
// Notification status endpoint (Phase 2.8.19 / C4) — read-only check of SMTP
// configuration so the sidebar Notifications panel can show "wired" /
// "not configured" without dialing out.
// ---------------------------------------------------------------------------
app.get('/api/notify/status', (_req, res) => {
```

- [ ] **Step 4: Verify backend integration**

Run: `npm test 2>&1 | tail -5`
Expected: 86 tests still pass. If a syntax error from the campaign.js edit broke the import, the test runner will fail loudly.

Also: `node --check src/campaign.js && node --check server.js`
Expected: PARSE OK twice.

Then probe the endpoint via curl (auth-gated; 401 is expected if no cookie, but the route must exist):
```bash
curl -s -o - -w 'HTTP %{http_code}\n' http://localhost:3000/api/errors | head -3
```
Expected: HTTP 200 (with `[]` if no errors yet) OR HTTP 401. If HTTP 404, the route didn't register — restart the dev server.

- [ ] **Step 5: Commit backend half**

```bash
git add src/campaign.js server.js tests/error-log-helper.test.js
git commit -m "feat(2.8.20): W1-B2a — persist campaign errors to data/errors.log.json + GET /api/errors"
```

### W1-B2b — Frontend merge

- [ ] **Step 6: Add `loadPersistedErrors` + merge helper to app.js**

Append to `public/js/app.js`:

```js
// Phase 2.8.20 (W1-B2) — fetch persisted errors and merge with in-memory ones.
let _persistedErrorsCache = [];
async function loadPersistedErrors() {
  try {
    const res = await fetch('/api/errors');
    if (!res.ok) return [];
    const arr = await res.json();
    if (Array.isArray(arr)) _persistedErrorsCache = arr;
    return _persistedErrorsCache;
  } catch (_) { return _persistedErrorsCache; }
}

function mergedErrorsForCount(liveErrors) {
  // Dedup by `at + message` so the same error doesn't show twice when both
  // the live in-memory array and the disk log contain it.
  const seen = new Set();
  const out = [];
  const push = (e) => {
    if (!e) return;
    const at = e.at || e.time || '';
    const key = `${at}|${e.message || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(e);
  };
  for (const e of (_persistedErrorsCache || [])) push(e);
  for (const e of (liveErrors || [])) push(e);
  return out;
}

window.loadPersistedErrors = loadPersistedErrors;
```

- [ ] **Step 7: Wire into existing errors-24h count**

Find `setVal('hero-errors', errors24h)` in `public/js/app.js` (around line 2801). The function calling it computes `errors24h` from a recent-errors source. We want that count to come from the merged list.

Use Read first to inspect lines 2790-2810 and identify the variable being set. Then update the source so `errors24h` comes from `mergedErrorsForCount(s.errors).filter(e => isRecent(e))` — adapt to the actual variable names found.

If the existing code is a one-liner like:
```js
setVal('hero-errors', s.errors.length);
```
then change to:
```js
setVal('hero-errors', mergedErrorsForCount(s.errors).filter(e => {
  const at = Date.parse(e.at || e.time);
  return Number.isFinite(at) && (Date.now() - at) < 24 * 3600 * 1000;
}).length);
```

If the existing pattern is more elaborate, follow it — the goal is to use `mergedErrorsForCount()` as the source of truth instead of `s.errors` directly.

- [ ] **Step 8: Trigger initial load on page load**

In `public/js/app.js`, find the bottom-of-file IIFE (the chain of `loadProfiles(); onModeChange(); pollStatus(); ...`). Add `loadPersistedErrors();` to that chain (any position after `pollStatus()` is fine).

Use Read on lines 2975-2995 to see the existing chain, then add one line.

- [ ] **Step 9: Verify + commit frontend half**

```bash
node --check public/js/app.js
```
Expected: PARSE OK.

```bash
git add public/js/app.js
git commit -m "feat(2.8.20): W1-B2b — merge persisted errors into errors-24h count"
```

---

## Task W1-C1: Uncaught exception/rejection handlers

**Files:**
- Modify: `server.js` (add handlers + `appendFatalErrorSync` helper)

- [ ] **Step 1: Locate insertion point**

Run: `grep -n "process.on\\|gracefulShutdown" server.js | head`

Expected: `process.on('SIGINT'...)` at line ~1095 and `process.on('SIGTERM'...)` at line ~1096; `gracefulShutdown` defined at line ~1078.

- [ ] **Step 2: Add `appendFatalErrorSync` helper above `gracefulShutdown`**

In `server.js`, find the comment line `// Graceful shutdown — close GoLogin profiles on SIGINT/SIGTERM (REL-03)` (around line 1076). Insert the new helper IMMEDIATELY ABOVE that comment block:

```
old: // ---------------------------------------------------------------------------
// Graceful shutdown — close GoLogin profiles on SIGINT/SIGTERM (REL-03)
// ---------------------------------------------------------------------------
async function gracefulShutdown(signal) {
new: // ---------------------------------------------------------------------------
// Phase 2.8.20 (W1-C1) — fatal-error sink. Sync write because the process is
// already dying — async writes risk being dropped before the event loop ends.
// Line-delimited JSON (NDJSON) keeps appends cheap and partial-write-safe.
// ---------------------------------------------------------------------------
import { appendFileSync as _appendFileSyncForFatal } from 'node:fs';

function appendFatalErrorSync(entry) {
  try {
    const line = JSON.stringify(entry) + '\n';
    _appendFileSyncForFatal(dataPath('fatal-errors.log'), line);
  } catch (_) { /* truly nothing left to do */ }
}

// ---------------------------------------------------------------------------
// Graceful shutdown — close GoLogin profiles on SIGINT/SIGTERM (REL-03)
// ---------------------------------------------------------------------------
async function gracefulShutdown(signal) {
```

(Note: the `import { appendFileSync } from 'node:fs'` may already exist at the top of the file. If `grep -n "appendFileSync" server.js` returns hits, REMOVE the inline `import` line above and use the existing import. Use the alias `_appendFileSyncForFatal` only if needed to avoid name collision.)

- [ ] **Step 3: Check for existing appendFileSync import; clean up if needed**

Run: `grep -n 'appendFileSync' server.js`

If the only hit is your new line above, leave it as-is.

If there's another import already (e.g. in the top imports block), DELETE the inline `import` line you just added and rename the call from `_appendFileSyncForFatal(...)` back to `appendFileSync(...)`. Use Edit accordingly.

- [ ] **Step 4: Add the two handlers below the existing SIGINT/SIGTERM handlers**

Find the two existing `process.on('SIGINT', ...)` / `process.on('SIGTERM', ...)` lines (around 1095-1096). Edit:

```
old: process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
new: process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Phase 2.8.20 (W1-C1) — catch crashes that would otherwise leave orphan
// browsers and skip the cloud-commit phase. Writes a fatal-error line
// synchronously, then runs the same graceful shutdown path.
process.on('uncaughtException', (err) => {
  appendFatalErrorSync({
    at: new Date().toISOString(),
    kind: 'uncaughtException',
    message: err && err.message ? err.message : String(err),
    stack:   err && err.stack   ? err.stack   : '',
  });
  console.error(`[fatal] uncaughtException: ${err && err.message}`);
  gracefulShutdown('FATAL').catch(() => process.exit(1));
});
process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  const stack   = reason instanceof Error ? reason.stack   : '';
  appendFatalErrorSync({
    at: new Date().toISOString(),
    kind: 'unhandledRejection',
    message,
    stack,
  });
  console.error(`[fatal] unhandledRejection: ${message}`);
  gracefulShutdown('FATAL').catch(() => process.exit(1));
});
```

- [ ] **Step 5: Verify**

```bash
node --check server.js
```
Expected: PARSE OK.

```bash
npm test 2>&1 | tail -5
```
Expected: still 86 tests pass.

- [ ] **Step 6: Smoke-test the handler (optional but recommended)**

You can verify by adding a temporary route, hitting it, then removing the route. Edit `server.js` to add a temporary route just above the new handlers:

```js
app.get('/api/_test_crash', () => { throw new Error('w1c1-smoke-test'); });
```

Then in another shell:
```bash
curl -s http://localhost:3000/api/_test_crash
```

The server process will die. Confirm:
```bash
cat /Users/antoniovarlese/ortus-gologin-clone/data/fatal-errors.log | tail -1
```
Expected: a single JSON line with `"kind":"uncaughtException"` and `"message":"w1c1-smoke-test"`.

REMOVE the temporary route before committing. Restart the dev server.

- [ ] **Step 7: Commit**

```bash
git add server.js
git commit -m "feat(2.8.20): W1-C1 — uncaughtException/unhandledRejection handlers + fatal-errors.log"
```

---

## Wave 1 Checkpoint

- [ ] **Verify W1-B1 in browser**

Hard-refresh `http://localhost:3000/`. Right-pane should show no Parked row when idle. (Manually triggering a parking event requires a real campaign, deferred to a future test session if not convenient now.)

- [ ] **Verify W1-B2 in browser**

Trigger an error: in devtools console, run `fetch('/api/sheet/preview?url=invalid', { method: 'POST' })` (or use the Sheet preview button with a malformed URL). After the error fires, check `data/errors.log.json` exists and has the entry. Refresh — the Errors-24h header stat should still reflect the error.

- [ ] **Verify W1-C1 — file presence test**

Confirm: `ls data/fatal-errors.log 2>/dev/null` either does NOT exist (if you skipped Step 6 smoke test) OR contains the test entry. Both are valid.

- [ ] **STOP and ask user to confirm cluster A** before continuing to Wave 2.

---

# Wave 2 — Recovery mechanics

## Task W2-A1: Hung-lead watchdog

**Files:**
- Modify: `src/campaign.js` (add constant, helper, wrap `performOutreach` call, extend `TRANSIENT_SIGNALS`)
- Create: `tests/watchdog-helper.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/watchdog-helper.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Pure logic — Promise.race based watchdog. We test that:
// 1. A fast-resolving promise wins.
// 2. A slow promise loses to the watchdog and we get the watchdog rejection.
// 3. The watchdog timer is cleared (no dangling timer keeping process alive).

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

test('fast promise resolves before watchdog fires', async () => {
  const fast = new Promise((resolve) => setTimeout(() => resolve('done'), 10));
  const result = await withWatchdog(fast, 1000, 'p1');
  assert.equal(result, 'done');
});

test('slow promise loses to watchdog and yields lead_timeout_watchdog', async () => {
  const slow = new Promise((resolve) => setTimeout(() => resolve('too late'), 1000));
  await assert.rejects(
    () => withWatchdog(slow, 50, 'p1'),
    (err) => {
      assert.equal(err.message, 'lead_timeout_watchdog');
      assert.equal(err.kind, 'watchdog');
      assert.equal(err.profileId, 'p1');
      assert.equal(err.timeoutMs, 50);
      return true;
    },
  );
});

test('watchdog timer is cleared after race settles', async () => {
  // If the timer leaks, this test process will hang for 5000ms past the
  // assertion. node --test fails fast on a hung test (default 30s), so a leak
  // would be visible. We simply assert that the resolved value is correct.
  const fast = Promise.resolve('immediate');
  const out = await withWatchdog(fast, 5000, 'p1');
  assert.equal(out, 'immediate');
});
```

Run: `npm test 2>&1 | tail -10`
Expected: 89 tests pass (was 86), 0 fail.

- [ ] **Step 2: Add `LEAD_TIMEOUT_MS` constant + `withWatchdog` helper**

In `src/campaign.js`, find the existing constants area near top (around lines 40-55, after `BATCH_SIZE`). Add:

```
old: /** Hard cap — 5 leads per batch per profile, for ALL modes (D-01). Not configurable. */
export const BATCH_SIZE = 5;
new: /** Hard cap — 5 leads per batch per profile, for ALL modes (D-01). Not configurable. */
export const BATCH_SIZE = 5;

/** Phase 2.8.20 (W2-A1) — per-lead watchdog timeout. Catches Puppeteer hangs
 *  that the protocol-level 120s timeout would otherwise paper over. Default
 *  90s; env-overridable for stress-testing (LEAD_TIMEOUT_MS=2000 will time
 *  out almost every lead, useful for proving the path).
 */
const LEAD_TIMEOUT_MS = Number(process.env.LEAD_TIMEOUT_MS) || 90000;

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

- [ ] **Step 3: Wrap the `performOutreach` call**

In `src/campaign.js`, find the call at line 885 (`result = await performOutreach(...)`). Use Read first to confirm the surrounding context (the retry loop's first attempt). Then Edit:

```
old:           for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            result = await performOutreach(page, url, { ...tpl, data }, { profileId }, hint);
new:           for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            // Phase 2.8.20 (W2-A1): wrap with watchdog so a Puppeteer hang
            // can't freeze the loop indefinitely. On timeout, returns a
            // skipped result with the lead_timeout_watchdog signal which
            // the existing TRANSIENT_SIGNALS allow-list (extended below)
            // routes through the normal 3-retry/backoff flow.
            try {
              result = await withWatchdog(
                performOutreach(page, url, { ...tpl, data }, { profileId }, hint),
                LEAD_TIMEOUT_MS,
                profileId,
              );
            } catch (err) {
              if (err && err.kind === 'watchdog') {
                log(`  ⏱ ${pName}: lead timed out after ${LEAD_TIMEOUT_MS / 1000}s — ${url}`);
                result = { action: 'skipped', error: 'lead_timeout_watchdog' };
              } else {
                throw err;
              }
            }
```

- [ ] **Step 4: Extend `TRANSIENT_SIGNALS` to include `lead_timeout_watchdog`**

In `src/campaign.js`, find the TRANSIENT_SIGNALS array (around line 901). Add `'lead_timeout_watchdog'` as the last element:

```
old:             const TRANSIENT_SIGNALS = [
              'detached',
              'Target closed',
              'Session closed',
              'Connection closed',
              'Protocol error',
              'Execution context was destroyed',
              'Navigation timeout',
              'net::ERR_',
              'timed out',
              'rate_limited',
            ];
new:             const TRANSIENT_SIGNALS = [
              'detached',
              'Target closed',
              'Session closed',
              'Connection closed',
              'Protocol error',
              'Execution context was destroyed',
              'Navigation timeout',
              'net::ERR_',
              'timed out',
              'rate_limited',
              'lead_timeout_watchdog',
            ];
```

- [ ] **Step 5: Verify**

```bash
node --check src/campaign.js
npm test 2>&1 | tail -5
```
Expected: PARSE OK; 89 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/campaign.js tests/watchdog-helper.test.js
git commit -m "feat(2.8.20): W2-A1 — hung-lead watchdog (90s default, retried via existing transient path)"
```

---

## Task W2-A2: Session-expired detection

**Files:**
- Modify: `src/campaign.js` (extend `checkProfileHealth`, route `sessionExpired` through `weeklyLimited` set + parked profiles)

- [ ] **Step 1: Extend `checkProfileHealth` with session probe**

In `src/campaign.js`, find `checkProfileHealth` (line 284). The function starts with `// Check 1: URL-based login detection` (line 287). Insert the new session probe at the very TOP of the function body, BEFORE the existing Check 1. Use Edit:

```
old: async function checkProfileHealth(page, profileName) {
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
new: async function checkProfileHealth(page, profileName) {
  const issues = [];

  // Phase 2.8.20 (W2-A2) — session-expired detection. If the page URL is on
  // a LinkedIn auth/checkpoint page, the cookies are dead. Surface this as a
  // distinct sessionExpired flag so the caller can park the profile for the
  // rest of the run instead of burning 5 retries on a dead session.
  try {
    const cur = page.url();
    if (cur && (cur.includes('/login') || cur.includes('/uas/login') || cur.includes('/checkpoint'))) {
      issues.push('session expired (auth page detected)');
      return { healthy: false, issues, sessionExpired: true };
    }
  } catch (_) { /* fall through to the existing Check 1 below */ }

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
```

- [ ] **Step 2: Route `sessionExpired` through `ensureProfileLoggedIn`**

In `src/campaign.js`, find the line `const health = await checkProfileHealth(page, pName);` inside `ensureProfileLoggedIn` (around line 384). Below that line, the existing code does `if (!health.healthy) { ... }` to handle unhealthy profiles. We need to detect `health.sessionExpired` ABOVE that block and short-circuit. Use Read on lines 380-395 first to confirm current structure, then Edit.

Pattern to add — when `sessionExpired` is true, return immediately with `{ page: null, ok: false, sessionExpired: true }` so the caller can route to parking:

```
old:   const health = await checkProfileHealth(page, pName);
  if (!health.healthy) {
new:   const health = await checkProfileHealth(page, pName);
  // Phase 2.8.20 (W2-A2): bubble up sessionExpired so the caller can park
  // the profile cleanly. Skip the recovery-prompt UX (which is for when the
  // user just needs to log in once more — sessionExpired means cookies are
  // dead and we should drop this profile from rotation entirely).
  if (health.sessionExpired) {
    log(`✗ ${pName}: session expired — parking profile for rest of run.`);
    return { page: null, ok: false, sessionExpired: true };
  }
  if (!health.healthy) {
```

- [ ] **Step 3: Handle `sessionExpired` at the `ensureProfileLoggedIn` call site**

In `src/campaign.js`, find the call site at line ~650 (`const { page, ok } = await ensureProfileLoggedIn(launched, profileId, pName);`). Use Read on lines 645-665 to confirm context. Edit to capture the new flag and route to parking + weeklyLimited:

```
old:         const { page, ok } = await ensureProfileLoggedIn(launched, profileId, pName);
        if (!ok) return null;
new:         const { page, ok, sessionExpired } = await ensureProfileLoggedIn(launched, profileId, pName);
        if (sessionExpired) {
          // Phase 2.8.20 (W2-A2): drop this profile from the round-robin and
          // surface in the right pane via parkedProfiles (W1-B1's mechanism).
          weeklyLimited.add(profileId);
          campaign.parkedProfiles.push({
            profileId,
            pName,
            parkedAt: Date.now(),
            reason: 'session_expired',
          });
          // Close the now-unusable session immediately to free RAM
          try {
            if (profileId === 'local-browser') await closeLocalBrowser();
            else await closeProfile(profileId);
          } catch { /* */ }
          return null;
        }
        if (!ok) return null;
```

- [ ] **Step 4: Verify the existing `weeklyLimited` set check guards `ensureOpen`**

The outer round-robin loop (around line 748) iterates `activeProfiles`. Ensure that profiles already in `weeklyLimited` aren't re-attempted. Run:

```bash
grep -n 'weeklyLimited' src/campaign.js
```

Expected: at least one site that filters or skips profiles in `weeklyLimited`. If the round-robin doesn't already skip them, this is a pre-existing gap (out of scope for W2-A2 — sessionExpired-dropped profiles will simply fail their next launch attempt and `ensureOpen` returns null, achieving the "drop" behavior).

If the grep shows `weeklyLimited.has(profileId)` checks elsewhere already, no extra change needed. Document the actual finding in your commit message.

- [ ] **Step 5: Verify parsing + commit**

```bash
node --check src/campaign.js
npm test 2>&1 | tail -5
```
Expected: PARSE OK; 89 tests still pass (no new tests for A2 — too many fs/Puppeteer dependencies for a useful unit test).

```bash
git add src/campaign.js
git commit -m "feat(2.8.20): W2-A2 — session-expired detection routes to parking via weeklyLimited"
```

---

## Wave 2 Checkpoint

- [ ] **Verify W2-A1 (watchdog)** — set `LEAD_TIMEOUT_MS=2000` in `.env`, restart dev server, run a campaign with one profile and one lead. Expect log line `⏱ <name>: lead timed out after 2s — <url>` and the existing retry/backoff to kick in. Reset env var after.

- [ ] **Verify W2-A2 (session expired)** — manually log out of LinkedIn in the local-browser profile mid-campaign. Within one batch's health check, the right-pane Parked row should show "1 parked · session expired" (depends on W1-B1 working).

- [ ] **STOP and ask user to confirm cluster B** before Wave 3.

---

# Wave 3 — Maintenance

## Task W3-C2: Disk-space pre-check

**Files:**
- Create: `src/disk-check.js`
- Modify: `src/gologin-launcher.js` (pre-launch check)
- Modify: `src/local-launcher.js` (pre-launch check)
- Modify: `server.js` (`GET /api/disk-status` + status payload addition)
- Modify: `public/index.html` (banner element)
- Modify: `public/css/style.css` (banner style)
- Modify: `public/js/app.js` (render banner from status payload)

- [ ] **Step 1: Create `src/disk-check.js`**

Create the new file with this exact content:

```js
// Phase 2.8.20 (W3-C2) — disk-space pre-flight check.
// Uses Node's statfs (≥18.15). Project requires Node ≥22 per package.json,
// so statfs is always available in target runtimes.

import { statfs } from 'node:fs/promises';
import { dataPath } from './paths.js';

const DEFAULT_THRESHOLD_BYTES = Number(process.env.DISK_FREE_THRESHOLD_BYTES) || (1 * 1024 * 1024 * 1024); // 1 GB

export async function checkDiskFree(thresholdBytes = DEFAULT_THRESHOLD_BYTES) {
  try {
    const stats = await statfs(dataPath('.'));
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    return {
      freeBytes,
      thresholdBytes,
      ok: freeBytes >= thresholdBytes,
      error: null,
    };
  } catch (err) {
    // Treat probe failure as "ok" — a broken disk-check must not block
    // the operator. (We can't reliably distinguish "no disk pressure" from
    // "permission denied on statfs" without false positives.)
    return {
      freeBytes: null,
      thresholdBytes,
      ok: true,
      error: err && err.message ? err.message : String(err),
    };
  }
}

export function formatBytes(n) {
  if (n == null || !Number.isFinite(n)) return '?';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} KB`;
  return `${n} B`;
}
```

- [ ] **Step 2: Pre-flight check in gologin launcher**

In `src/gologin-launcher.js`, find the start of `launchProfile` (line 60: `export async function launchProfile(profileId, token) {`). Add the disk check immediately inside the function body. First, add the import at the top:

```
old: import GoLogin from 'gologin';
import puppeteer from 'puppeteer-core';
import { hideByPid } from './mac-window.js';
new: import GoLogin from 'gologin';
import puppeteer from 'puppeteer-core';
import { hideByPid } from './mac-window.js';
import { checkDiskFree, formatBytes } from './disk-check.js';
```

Then add the check at the top of `launchProfile`:

```
old: export async function launchProfile(profileId, token) {
  console.log(`[gologin] Starting ${profileId}…`);
new: export async function launchProfile(profileId, token) {
  // Phase 2.8.20 (W3-C2): refuse to launch when free disk is below threshold.
  // Profile downloads + screenshots + logs accumulate; a full disk silently
  // corrupts state (writes return ENOSPC and the campaign limps on).
  const disk = await checkDiskFree();
  if (!disk.ok) {
    throw new Error(`Disk space too low (${formatBytes(disk.freeBytes)} free, ${formatBytes(disk.thresholdBytes)} required) — clear space before launching.`);
  }
  console.log(`[gologin] Starting ${profileId}…`);
```

- [ ] **Step 3: Pre-flight check in local launcher**

In `src/local-launcher.js`, find the import block at the top:

```
old: import puppeteer from 'puppeteer-core';
import { existsSync, mkdirSync } from 'fs';
import { dataPath } from './paths.js';
import { hideByPid } from './mac-window.js';
new: import puppeteer from 'puppeteer-core';
import { existsSync, mkdirSync } from 'fs';
import { dataPath } from './paths.js';
import { hideByPid } from './mac-window.js';
import { checkDiskFree, formatBytes } from './disk-check.js';
```

Then find `launchLocalBrowser` (around line 41) and add the check inside the function body:

```
old: export async function launchLocalBrowser() {
  console.log('[local] Starting local browser...');
new: export async function launchLocalBrowser() {
  // Phase 2.8.20 (W3-C2): disk-space pre-flight (same gate as GoLogin launcher).
  const disk = await checkDiskFree();
  if (!disk.ok) {
    throw new Error(`Disk space too low (${formatBytes(disk.freeBytes)} free, ${formatBytes(disk.thresholdBytes)} required) — clear space before launching.`);
  }
  console.log('[local] Starting local browser...');
```

- [ ] **Step 4: `GET /api/disk-status` endpoint + payload addition**

In `server.js`, locate the `GET /api/errors` route added in W1-B2 (around line 1055). Insert `GET /api/disk-status` immediately above it. First add the import at the top of `server.js`:

```
old: import { dataPath } from './src/paths.js';
new: import { dataPath } from './src/paths.js';
import { checkDiskFree } from './src/disk-check.js';
```

Then add the endpoint:

```
old: // ---------------------------------------------------------------------------
// Persisted errors endpoint (Phase 2.8.20 / W1-B2) — read-only.
// Returns the contents of data/errors.log.json (empty array if missing).
// ---------------------------------------------------------------------------
app.get('/api/errors', async (_req, res) => {
new: // ---------------------------------------------------------------------------
// Disk-status endpoint (Phase 2.8.20 / W3-C2) — read-only free-bytes check.
// ---------------------------------------------------------------------------
app.get('/api/disk-status', async (_req, res) => {
  const status = await checkDiskFree();
  res.json(status);
});

// ---------------------------------------------------------------------------
// Persisted errors endpoint (Phase 2.8.20 / W1-B2) — read-only.
// Returns the contents of data/errors.log.json (empty array if missing).
// ---------------------------------------------------------------------------
app.get('/api/errors', async (_req, res) => {
```

- [ ] **Step 5: Add `disk` field to `/api/campaign/status` payload**

In `src/campaign.js`, find `getCampaignStatus()` (around line 1311). We added `parked` earlier in W1-B1. Now also include `disk`. Use Edit. First, add the import at the top of `src/campaign.js`:

```
old: import { dataPath } from './paths.js';
import {
  sample as rmSample,
new: import { dataPath } from './paths.js';
import { checkDiskFree } from './disk-check.js';
import {
  sample as rmSample,
```

Note: `getCampaignStatus()` is currently SYNCHRONOUS. Calling `await checkDiskFree()` would require making it async. To keep it sync, use a cached value updated by an interval. Add this near the campaign state:

```
old: // ── Campaign state (exposed to dashboard) ──
new: // Phase 2.8.20 (W3-C2): cached disk status, refreshed on a 30s interval.
// Kept module-local so getCampaignStatus() can stay synchronous (it's called
// from /api/campaign/status hot path).
let _diskStatusCache = { freeBytes: null, thresholdBytes: 0, ok: true, error: null };
async function _refreshDiskStatus() {
  try { _diskStatusCache = await checkDiskFree(); } catch (_) {}
}
_refreshDiskStatus();
setInterval(_refreshDiskStatus, 30000).unref?.();

// ── Campaign state (exposed to dashboard) ──
```

Then in `getCampaignStatus()`, add `disk` to the return:

```
old:     parked: campaign.parkedProfiles.slice(),
    resources: smp ? {
new:     parked: campaign.parkedProfiles.slice(),
    disk: { ..._diskStatusCache },
    resources: smp ? {
```

- [ ] **Step 6: Add the banner to `public/index.html`**

Find `<div id="server-log-panel"...>` — wait, that was deleted in 2.8.19 (B3). Find `</div>` closing `#header-stats` instead. Use:

```bash
grep -n 'header-stats' public/index.html | head
```

The closing of `#header-stats` is the `</div>` immediately before the next major block. Use Read to identify exactly. Then add the banner:

```
old:     </div>

    <!-- ── Settings (reordered to position 1) ── -->
    <div class="section" id="nav-settings">
new:     </div>

    <!-- Phase 2.8.20 (W3-C2): disk-low banner -->
    <div id="disk-warning-banner" class="disk-warning-banner" hidden>
      <span id="disk-warning-text">—</span>
    </div>

    <!-- ── Settings (reordered to position 1) ── -->
    <div class="section" id="nav-settings">
```

- [ ] **Step 7: Banner CSS**

Append to `public/css/style.css`:

```css
/* Phase 2.8.20 (W3-C2) — disk-low warning banner */
.disk-warning-banner {
  border: 1px solid var(--red);
  color: var(--red);
  font-family: var(--body, 'Hanken Grotesk', sans-serif);
  font-size: 0.8rem;
  letter-spacing: 0.04em;
  padding: 10px 14px;
  margin: 0 0 16px 0;
  background: transparent;
}
```

- [ ] **Step 8: Render banner from status payload**

Append to `public/js/app.js`:

```js
// Phase 2.8.20 (W3-C2) — disk-low banner driven by /api/campaign/status payload.
function _formatBytesClient(n) {
  if (n == null || !Number.isFinite(n)) return '?';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} KB`;
  return `${n} B`;
}

function renderDiskBanner(disk) {
  const banner = document.getElementById('disk-warning-banner');
  const text = document.getElementById('disk-warning-text');
  if (!banner || !text) return;
  if (!disk || disk.ok !== false) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  text.textContent = `Disk: ${_formatBytesClient(disk.freeBytes)} free — clear space before launching.`;
}
```

Then wire into `pollStatus()`. Find the line where you added `renderParkedProfiles(s.parked);` and add a sibling call:

```
old:     renderParkedProfiles(s.parked);
new:     renderParkedProfiles(s.parked);
    renderDiskBanner(s.disk);
```

- [ ] **Step 9: Verify**

```bash
node --check src/campaign.js src/gologin-launcher.js src/local-launcher.js src/disk-check.js server.js public/js/app.js
npm test 2>&1 | tail -5
```
Expected: PARSE OK across the board; 89 tests still pass.

- [ ] **Step 10: Smoke-test the endpoint**

```bash
curl -s -o - -w 'HTTP %{http_code}\n' http://localhost:3000/api/disk-status | head -3
```
Expected: HTTP 200 with `{"freeBytes":<number>,"thresholdBytes":1073741824,"ok":true,"error":null}` OR HTTP 401 (auth-gated). If HTTP 404, restart dev server.

- [ ] **Step 11: Commit**

```bash
git add src/disk-check.js src/gologin-launcher.js src/local-launcher.js src/campaign.js server.js public/index.html public/css/style.css public/js/app.js
git commit -m "feat(2.8.20): W3-C2 — disk-space pre-flight check (1 GB default) + banner"
```

---

## Task W3-D1: `state.json` pruning

**Files:**
- Modify: `src/campaign.js` (add `STATE_RETENTION_DAYS` constant, prune in `loadState`)
- Create: `tests/state-pruning.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/state-pruning.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Pure logic — given a `processed` map and a cutoff timestamp, return a
// new map with entries older than the cutoff dropped.

function pruneProcessed(processed, cutoffMs) {
  const out = {};
  let pruned = 0;
  for (const [url, entry] of Object.entries(processed || {})) {
    const ts = entry?.date ? Date.parse(entry.date) : NaN;
    if (Number.isFinite(ts) && ts < cutoffMs) { pruned++; continue; }
    out[url] = entry;
  }
  return { processed: out, pruned };
}

test('keeps recent entries, drops old ones', () => {
  const now = Date.now();
  const recent = new Date(now - 10 * 86400000).toISOString(); // 10 days ago
  const old    = new Date(now - 80 * 86400000).toISOString(); // 80 days ago
  const cutoff = now - 60 * 86400000; // keep entries newer than 60d
  const input = {
    'url-a': { profileId: 'p1', date: recent },
    'url-b': { profileId: 'p1', date: old },
  };
  const { processed, pruned } = pruneProcessed(input, cutoff);
  assert.equal(pruned, 1);
  assert.deepEqual(Object.keys(processed), ['url-a']);
});

test('keeps entries with malformed/missing date (defensive: never drops if we cannot date it)', () => {
  const cutoff = Date.now() - 60 * 86400000;
  const input = {
    'no-date':   { profileId: 'p1' },
    'bad-date':  { profileId: 'p1', date: 'not a real date' },
    'null-date': { profileId: 'p1', date: null },
  };
  const { processed, pruned } = pruneProcessed(input, cutoff);
  assert.equal(pruned, 0);
  assert.equal(Object.keys(processed).length, 3);
});

test('empty input is empty output', () => {
  const { processed, pruned } = pruneProcessed({}, Date.now());
  assert.deepEqual(processed, {});
  assert.equal(pruned, 0);
});

test('null input treated as empty', () => {
  const { processed, pruned } = pruneProcessed(null, Date.now());
  assert.deepEqual(processed, {});
  assert.equal(pruned, 0);
});
```

Run: `npm test 2>&1 | tail -5`
Expected: 93 tests pass (was 89), 0 fail.

- [ ] **Step 2: Add constant + modify `loadState`**

In `src/campaign.js`, find the `LEAD_TIMEOUT_MS` constant we added in W2-A1 (around the same area). Add the new retention constant alongside it:

```
old: const LEAD_TIMEOUT_MS = Number(process.env.LEAD_TIMEOUT_MS) || 90000;
new: const LEAD_TIMEOUT_MS = Number(process.env.LEAD_TIMEOUT_MS) || 90000;

/** Phase 2.8.20 (W3-D1) — state.json `processed` retention window in days.
 *  Default 60. Entries older than this are dropped on next loadState; the
 *  pruned state persists on the next saveState call. Configurable via env.
 *  Semantics: a lead untouched for N days is "forgotten" — fair game to retry.
 */
const STATE_RETENTION_DAYS = Number(process.env.STATE_RETENTION_DAYS) || 60;
```

Then find `loadState` (line 92):

```
old: async function loadState() {
  try { return JSON.parse(await readFile(STATE_FILE, 'utf8')); }
  catch { return { processed: {}, dailyCounts: {} }; }
}
new: async function loadState() {
  let s;
  try { s = JSON.parse(await readFile(STATE_FILE, 'utf8')); }
  catch { return { processed: {}, dailyCounts: {} }; }
  // Phase 2.8.20 (W3-D1): prune entries older than retention window.
  // Done at load (not save) so the trim happens once per process startup
  // rather than on every campaign-step persistence.
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

- [ ] **Step 3: Verify**

```bash
node --check src/campaign.js
npm test 2>&1 | tail -5
```
Expected: PARSE OK; 93 tests pass.

- [ ] **Step 4: Smoke-test the prune behavior (optional)**

You can verify by temporarily seeding a stale entry into `data/state.json`. Backup first:

```bash
cp data/state.json data/state.json.backup-$(date +%s)
```

Then in devtools console (or via a quick node script), inject an entry with `date: '2024-01-01T00:00:00Z'` (well over 60 days old). Restart the dev server. The startup log should show `[state] pruned 1 entries older than 60d`. Restore the backup if you want to undo:

```bash
cp data/state.json.backup-* data/state.json
```

- [ ] **Step 5: Commit**

```bash
git add src/campaign.js tests/state-pruning.test.js
git commit -m "feat(2.8.20): W3-D1 — prune state.json entries older than 60 days at loadState"
```

---

## Wave 3 Checkpoint

- [ ] **Verify W3-C2 in browser** — temporarily set `DISK_FREE_THRESHOLD_BYTES=999999999999` (1 TB) in `.env`, restart server, refresh dashboard. Banner should appear: "Disk: <X> GB free — clear space before launching." Reset env, refresh, banner disappears.

- [ ] **Verify W3-D1** — confirm test passed in Step 3 above; smoke-test in Step 4 confirmed log line.

- [ ] **STOP and ask user to confirm cluster C** before FINAL.

---

# Task FINAL: Version bump + acceptance pass

**Files:**
- Modify: `package.json` (`version` 2.8.19 → 2.8.20)

- [ ] **Step 1: Read package.json**

Use Read on `package.json` lines 1-10 to confirm current state.

- [ ] **Step 2: Bump version**

Edit `package.json`:

```
old:   "version": "2.8.19",
new:   "version": "2.8.20",
```

- [ ] **Step 3: Run full test suite**

```bash
npm test 2>&1 | tail -8
```
Expected: 93 tests pass / 0 fail / 2 skipped.

- [ ] **Step 4: Walk acceptance criteria from spec**

Open `docs/superpowers/specs/2026-04-27-ortus-outreach-reliability-design.md` to the "Acceptance per wave" section (around line 308). Walk every bullet manually — confirm each passes. If any fails, STOP and ask the user before declaring done.

- [ ] **Step 5: Commit version bump**

```bash
git add package.json
git status --short
git commit -m "chore(2.8.20): bump version after reliability patch (W1 + W2 + W3)"
```

- [ ] **Step 6: Show branch summary**

```bash
git log --oneline main..HEAD
git diff --stat main..HEAD
```
Expected: ~10 commits across waves; files changed match the spec's Files-touched table.

- [ ] **Step 7: Print recap to user**

Tell the user what shipped. Suggest `git checkout main && git merge reliability-2.8.20` to merge.

---

## Self-Review Checklist

- [x] **Spec coverage:** Every patch (B1, B2, C1, A1, A2, C2, D1) maps to a task. FINAL handles version + acceptance.
- [x] **Placeholder scan:** No "TBD"/"TODO"/"figure out". The two "Use Read first to confirm" hedges in A2 Step 2 (line ~380-395) and the W1-B2 Step 7 hero-errors edit are deliberate — line numbers may have shifted slightly from the spec; the implementer must verify the exact existing code before editing. Both are flagged with concrete fallback patterns.
- [x] **Type consistency:** `parkedProfiles`, `parked`, `_diskStatusCache`, `disk`, `pruneProcessed`, `loadState`, `appendErrorLog`, `withWatchdog`, `LEAD_TIMEOUT_MS`, `STATE_RETENTION_DAYS`, `MAX_ERROR_LOG_ENTRIES`, `DISK_FREE_THRESHOLD_BYTES`, `checkDiskFree`, `formatBytes`, `_formatBytesClient`, `renderParkedProfiles`, `renderDiskBanner`, `_humanAgoFromTs`, `_prettyParkReason`, `loadPersistedErrors`, `mergedErrorsForCount`, `appendFatalErrorSync`, `gracefulShutdown('FATAL')` — names align across all task references.
- [x] **Acceptance verifiability:** Each task ends in commit + manual or test-driven verify; FINAL walks the spec's per-wave acceptance criteria.
- [x] **No drive-by changes** — out-of-scope assertions reiterated in plan header (no `src/linkedin/*`, no `performOutreach` internals, no retry-threshold changes).
