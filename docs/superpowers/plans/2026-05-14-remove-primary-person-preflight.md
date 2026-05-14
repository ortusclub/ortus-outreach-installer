# Remove Primary-Person Preflight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the compose+typeahead "connect test" that runs before every `connect_and_introduce` campaign, end-to-end (server, UI, modal, dev button, standalone endpoint, source files, test). Campaigns launch directly into the batch loop.

**Architecture:** This is a pure removal. Each task deletes one cohesive surface (a function, a route, a UI block, a file) and verifies the app still boots. Tasks are ordered so the app remains runnable after every commit — UI call sites are dismantled before the server endpoint they call, the campaign.js preflight block goes before the source files it imports, etc. No new behavior is introduced; the existing per-lead `INTRO_RECIPIENT_NOT_FOUND` error path at end-of-run remains the only signal that a sender lacks 1st-degree with the primary person.

**Tech Stack:** Node.js / Electron / Express / vanilla JS frontend.

**Spec:** `docs/superpowers/specs/2026-05-14-remove-primary-person-preflight-design.md`

**Preserved (do not touch):**
- `preflightCheckStatus` parameter in `startCampaign` and the bulk-check block at `src/campaign.js:~1502` (different feature — bulk connection-status sweep, no compose).
- `preflight-check-toggle-mo` and `preflight-check-toggle-ib` checkboxes in `public/index.html`.
- Primary Person config block in the launch wizard (`#primary-person-name`, `#primary-person-url` inputs) — `auto-intro.js` uses these for DM body.
- CSS classes `.preflight-eyebrow` and `.preflight-actions` — **reused by the Intro DM preview modal** (`public/index.html:1211, 1221`).

---

## File Structure

**Files modified:**
- `public/js/app.js` — remove modal flow from `submitStartCampaign`, delete preflight helpers + module state + dev button function
- `public/index.html` — remove nav button, remove `#preflight-modal` block, remove modal-specific CSS
- `server.js` — simplify `/api/campaign/start` to fire-and-forget, delete `launchCampaignWithPreflight`, delete `/api/preflight-only`
- `src/campaign.js` — remove preflight block, import, and `onPreflightComplete` parameter + all its invocations

**Files deleted:**
- `src/preflight-primary.js`
- `src/preflight-runner.js`
- `src/linkedin/verify-primary-person.js`
- `tests/preflight-primary.test.js`

---

### Task 1: Simplify `submitStartCampaign` in app.js

Removes the modal-open and the `preflight_failed` 409 branch so the launch flow becomes a plain campaign POST. After this task, the launch wizard still opens the modal on click (next task removes that), but the success path no longer depends on the modal closing — campaign starts as soon as server returns 200. Module-level state `_preflightStartBody` / `_preflightCancelled` becomes orphaned and is removed in Task 2.

**Files:**
- Modify: `public/js/app.js` lines ~2518–2592 (the `submitStartCampaign` function)

- [ ] **Step 1: Replace the `submitStartCampaign` function**

Find the function starting with `async function submitStartCampaign(body) {` (around line 2518) and replace its full body with this:

```js
async function submitStartCampaign(body) {
  try {
    const res = await fetch('/api/campaign/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const txt = await res.text();
      alert(`Could not start campaign:\n\n${txt}`);
      return;
    }

    const data = await res.json();
    if (data.error) { alert(`Error: ${data.error}`); return; }
    if (!data.ok) { alert(data.message || 'Could not start campaign.'); return; }

    // Whether the campaign starts now or gets queued, the draft has been
    // consumed. Drop it from the Drafts list and clear the active id.
    try {
      const draftId = localStorage.getItem('currentDraftId') || '';
      if (draftId) {
        await fetch('/api/drafts/' + encodeURIComponent(draftId), { method: 'DELETE' }).catch(() => {});
        localStorage.removeItem('currentDraftId');
      }
    } catch {}

    // Server queued the campaign because another one is already running.
    if (data.queued) {
      alert(data.message || 'Added to queue.');
      if (typeof saveLastUsedPreset === 'function') saveLastUsedPreset();
      goDashboard();
      return;
    }
    setCampaignButtons(true);
    if (typeof saveLastUsedPreset === 'function') saveLastUsedPreset();
    startPolling();
  } catch (e) {
    alert(`Network error starting campaign:\n\n${e.message}`);
  }
}
```

- [ ] **Step 2: Verify the app still loads**

Run: `npm run electron:dev` (or check the already-running instance at the log path)
Expected: app launches, dashboard loads, no console errors. Don't try a campaign yet — the launch button still references the modal, that gets cleaned up in Task 2.

- [ ] **Step 3: Commit**

```bash
git add public/js/app.js
git commit -m "refactor(launch): drop preflight modal from submitStartCampaign"
```

---

### Task 2: Delete preflight modal helpers and module state in app.js

Removes everything the launch flow used to drive the modal: the module-level state vars, the open/close helpers, the failure-rendering function, and the did-you-mean retry path.

**Files:**
- Modify: `public/js/app.js` — multiple regions (see step 1)

- [ ] **Step 1: Delete the following symbols and their `window.*` exports**

Search for each and delete the full function/declaration. After this step, the module should contain zero hits for any of these names.

| Symbol | Approx. line | Type |
|---|---|---|
| `_preflightStartBody` | 2678 | `let` declaration |
| `_preflightCancelled` | 2679 | `let` declaration |
| `openPreflightModal` | 2681 | function + `window.openPreflightModal` export |
| `showPreflightFailure` | 2694 | function + `window.showPreflightFailure` export |
| `closePreflightModal` | 2760 | function + `window.closePreflightModal` export |
| `closePreflightModalAndScrollToPrimary` | 2774 | function + `window.*` export |
| `applyDidYouMeanAndRetry` | 2784 | function + `window.*` export |
| `_preflightEscapeHtml` | 2804 | function |

Delete the contiguous block from the start of `let _preflightStartBody = null;` through the end of `_preflightEscapeHtml`. If anything between those points is unrelated (e.g., a different function), keep it — but inspect: based on the grep all of 2678→2810 is preflight-related.

- [ ] **Step 2: Verify no orphan references remain**

Run: `grep -n "_preflightStartBody\|_preflightCancelled\|openPreflightModal\|closePreflightModal\|showPreflightFailure\|applyDidYouMeanAndRetry\|_preflightEscapeHtml" public/js/app.js`
Expected: only hits inside `devVerifyPrimaryNow` (still present — removed in Task 3). If anything else, that call site is unexpected — investigate before continuing.

- [ ] **Step 3: Verify app boots**

The dev server hot-reloads or you can restart it. Open the dashboard.
Expected: no console errors. Don't click Launch yet (Task 3 cleans the dev button; Task 5 cleans the server endpoint).

- [ ] **Step 4: Commit**

```bash
git add public/js/app.js
git commit -m "refactor(ui): remove preflight modal helpers and state"
```

---

### Task 3: Delete `devVerifyPrimaryNow` in app.js

Removes the manual "Verify primary person" dev tool. This must come after Task 2 because `devVerifyPrimaryNow` calls `openPreflightModal` / `closePreflightModal` / `showPreflightFailure` — by now those are gone and the function is the only remaining reference. After this task there should be zero `preflight`-named symbols left in `app.js`.

**Files:**
- Modify: `public/js/app.js` lines ~7320–7380

- [ ] **Step 1: Delete the function block**

Find the comment header:

```js
// ---------------------------------------------------------------------------
// Dev tools — Verify primary person now (no campaign launch)
// ---------------------------------------------------------------------------
async function devVerifyPrimaryNow() {
```

Delete from the comment header through `window.devVerifyPrimaryNow = devVerifyPrimaryNow;` (inclusive). The next thing should be the `// Dev tools — Preview intro DM` block.

- [ ] **Step 2: Verify no preflight refs remain in app.js**

Run: `grep -cn "preflight\|Preflight" public/js/app.js`
Expected: only hits referencing `preflight-check-toggle-mo` / `preflight-check-toggle-ib` (the bulk-check feature). If any other hit, investigate.

- [ ] **Step 3: Commit**

```bash
git add public/js/app.js
git commit -m "refactor(ui): remove devVerifyPrimaryNow dev tool"
```

---

### Task 4: Remove preflight modal HTML + nav button + CSS from index.html

**Files:**
- Modify: `public/index.html` (line 36 nav button, lines ~1108–end-of-modal block, inline `<style>` rules)

- [ ] **Step 1: Remove the nav button**

Delete line 36:

```html
<button type="button" class="nav-item" onclick="devVerifyPrimaryNow()">Verify primary person</button>
```

- [ ] **Step 2: Remove the preflight modal block**

Find the comment header:

```html
<!-- Pre-flight verification modal (CC+IC primary person) -->
<div id="preflight-modal" class="modal-backdrop hidden" data-state="verifying" ...>
```

Delete from the comment through the closing `</div>` of `#preflight-modal` (multiple nested divs — match the opening backdrop div). The full modal currently spans line ~1108 through where the next adjacent element begins (likely the Intro DM preview modal).

- [ ] **Step 3: Remove modal-specific CSS rules**

Search the `<style>` blocks in `public/index.html` for these selectors and delete the matching rules. **Do NOT delete** `.preflight-eyebrow` or `.preflight-actions` — those are reused by the Intro DM preview modal.

Selectors to delete:
- `.preflight-modal-card`
- `.preflight-state`
- `.preflight-state-verifying`
- `.preflight-state-failure`
- `.preflight-progress`
- `.preflight-progress-fill`
- `.preflight-sub`
- `.preflight-results` and any `.preflight-results-*`

Run a final search to confirm no orphans: `grep -n "preflight-modal\|preflight-state\|preflight-progress\|preflight-sub\|preflight-results" public/index.html`
Expected: no matches.

- [ ] **Step 4: Smoke-test the UI**

Reload Electron. Open the launch wizard, scroll through it. The left nav should not show "Verify primary person." The Intro DM preview modal (different feature) should still look right when triggered.

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "ui: remove preflight modal and nav entry"
```

---

### Task 5: Simplify server.js — drop preflight wiring and `/api/preflight-only`

Three edits in one task because they're tightly coupled: the `/api/campaign/start` route waits for a preflight outcome that no longer exists, `launchCampaignWithPreflight` is a wrapper specifically for that callback, and `/api/preflight-only` shares the same source modules.

**Files:**
- Modify: `server.js` (route at ~579–685, `launchCampaignWithPreflight` at ~528–562, `/api/preflight-only` at ~2310–2353)

- [ ] **Step 1: Replace the preflight-awaiting block in `/api/campaign/start`**

Locate the block that starts with the comment `// Await only the preflight outcome` (around line 661) and runs through the closing `res.json({ ok: true, message: 'Campaign started' });` (around line 679). Replace the entire block — including the comment, the `new Promise(...)` await, and the `if (!preflightOutcome.allPassed)` branch — with:

```js
    // Fire-and-forget — the campaign continues in background. The HTTP
    // response returns immediately; the dashboard polls /api/status for
    // progress.
    preventSleep('campaign');
    startCampaign({ ...config, createdBy: owner })
      .then(() => {
        const status = getCampaignStatus();
        notifyEmail(owner, {
          title: 'Campaign finished',
          body: `Your campaign finished: ${status.processedToday || 0} actions, ${(status.errors || []).length} error(s).`,
          link: '/',
        }).catch(() => {});
      })
      .catch((err) => {
        console.error('Campaign error:', err.message);
        allowSleep('campaign');
      });
    res.json({ ok: true, message: 'Campaign started' });
```

Verify before/after that the surrounding `try { ... } catch { ... }` boundaries remain intact.

- [ ] **Step 2: Delete `launchCampaignWithPreflight`**

Locate the function starting with this comment block (around line 526):

```js
// Fire-and-forget campaign launch that signals the preflight outcome via
// onPreflightResult before the campaign continues running in background.
// Used by POST /api/campaign/start to support 409 PREFLIGHT_FAILED responses
// while still keeping the long campaign-run async.
function launchCampaignWithPreflight(config, owner, onPreflightResult) {
```

Delete from the comment block through the function's closing `}`. The next item after it should be either another route handler or another helper — leave a single blank line between them.

The body of `launchCampaignWithPreflight` includes the `.then(notifyEmail).catch(...)` pattern; that pattern is now inlined into the route in Step 1, so deletion is safe.

- [ ] **Step 3: Delete `/api/preflight-only`**

Locate the comment header (around line 2310):

```js
// ---------------------------------------------------------------------------
// Dev-tool: run the CC+IC preflight check without launching a campaign.
// Operator opens profiles, runs verifyPrimaryPerson on each, closes them.
// ---------------------------------------------------------------------------
app.post('/api/preflight-only', async (req, res) => {
```

Delete from the comment header through the closing `});` of `app.post('/api/preflight-only', ...)` (around line 2353).

- [ ] **Step 4: Verify server boots**

Restart the Electron app. The dashboard should load. From the terminal log: no `Cannot find module` errors, no reference errors.

- [ ] **Step 5: Verify the endpoint is gone**

With the server running:
```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:<port>/api/preflight-only -H "Content-Type: application/json" -d '{}'
```
(Replace `<port>` with the dashboard port from the boot log.)
Expected: `404`.

- [ ] **Step 6: Commit**

```bash
git add server.js
git commit -m "server: drop preflight wiring; campaign start is fire-and-forget"
```

---

### Task 6: Remove preflight block + param from campaign.js

After this task, `campaign.js` no longer imports or references the preflight system.

**Files:**
- Modify: `src/campaign.js` (line 34 import, line 964 signature, lines 1739–1826 preflight block + non-CC+IC signal)

- [ ] **Step 1: Delete the import**

Line 34:

```js
import { runPreflight } from './preflight-primary.js';
```

Delete the whole line.

- [ ] **Step 2: Remove `onPreflightComplete` from the `startCampaign` signature**

Line 964. Change:

```js
export async function startCampaign({ profileIds, sheetUrl, templates, dailyLimit = 50, mode = 'connect_only', messageOpenProfiles = false, delayMin = 15, delayMax = 45, linkedinColumn = '', senderFirstNames = {}, concurrency = 1, name = '', acceptanceTrackingDays = 0, preflightCheckStatus = false, createdBy = null, onPreflightComplete = null }) {
```

To:

```js
export async function startCampaign({ profileIds, sheetUrl, templates, dailyLimit = 50, mode = 'connect_only', messageOpenProfiles = false, delayMin = 15, delayMax = 45, linkedinColumn = '', senderFirstNames = {}, concurrency = 1, name = '', acceptanceTrackingDays = 0, preflightCheckStatus = false, createdBy = null }) {
```

(Only `onPreflightComplete = null` is removed. Keep everything else — `preflightCheckStatus` is the bulk-check feature.)

- [ ] **Step 3: Delete the preflight block**

Locate the block starting at line ~1739 with this comment fence:

```js
    // ─────────────────────────────────────────────────────────────────────
    // Pre-flight: verify primary person is reachable from every sender
    // account before any connection requests go out. CC+IC only.
    //
    // Spec: docs/superpowers/specs/2026-05-14-cc-ic-primary-person-preflight-design.md
    // ─────────────────────────────────────────────────────────────────────
    if (mode === 'connect_and_introduce') {
```

Delete from that comment fence through the closing `}` of the `if (mode === 'connect_and_introduce')` block (around line 1820) AND the following block:

```js
    // For non-connect_and_introduce modes there is no preflight to run.
    // Signal pass immediately so the HTTP route's Promise resolves without
    // waiting 90s for the defensive timeout.
    if (mode !== 'connect_and_introduce' && typeof onPreflightComplete === 'function') {
      try { onPreflightComplete({ allPassed: true, results: [], skipped: true }); } catch {}
    }
    // ─────────────────────────────────────────────────────────────────────
```

(This block also goes — no callback exists anymore.)

The next line should be `function pickNextProfile() {` (or similar — the batch loop body). Leave a single blank line.

- [ ] **Step 4: Verify no orphan refs**

Run: `grep -n "onPreflightComplete\|runPreflight\|preflight-primary\|preflight-runner\|verify-primary-person\|Pre-flight: verifying primary" src/campaign.js`
Expected: no matches.

Run: `grep -n "preflightCheckStatus" src/campaign.js`
Expected: still present (the bulk-check feature — must be preserved).

- [ ] **Step 5: Boot test**

Restart Electron. Confirm the app boots without import errors.

- [ ] **Step 6: Commit**

```bash
git add src/campaign.js
git commit -m "campaign: remove primary-person preflight from runner"
```

---

### Task 7: Delete the preflight source files and test

Now safe to delete — no remaining imports.

**Files:**
- Delete: `src/preflight-primary.js`
- Delete: `src/preflight-runner.js`
- Delete: `src/linkedin/verify-primary-person.js`
- Delete: `tests/preflight-primary.test.js`

- [ ] **Step 1: Remove files**

```bash
cd ~/ortus-gologin-clone
rm src/preflight-primary.js src/preflight-runner.js src/linkedin/verify-primary-person.js tests/preflight-primary.test.js
```

- [ ] **Step 2: Run the test suite**

```bash
npm test
```
Expected: all tests pass. (Removed test file is no longer enumerated; nothing else references the deleted modules.)

- [ ] **Step 3: Boot test**

Restart Electron. App loads cleanly.

- [ ] **Step 4: Commit**

```bash
git add -A src/preflight-primary.js src/preflight-runner.js src/linkedin/verify-primary-person.js tests/preflight-primary.test.js
git commit -m "remove dead primary-person preflight modules and test"
```

(`git add -A` on individually-named deleted paths stages the deletion. If git balks because the paths no longer exist, use `git rm` in place of the `rm` in Step 1.)

---

### Task 8: Final verification

End-to-end confirmation that nothing preflight-related survives and the campaign launch flow works.

- [ ] **Step 1: Global grep for stragglers**

```bash
cd ~/ortus-gologin-clone
grep -rn "runPreflight\|verifyPrimaryPerson\|preflight-primary\|preflight-runner\|verify-primary-person\|devVerifyPrimaryNow\|openPreflightModal\|closePreflightModal\|showPreflightFailure\|onPreflightComplete\|launchCampaignWithPreflight\|preflight-only\|preflight_failed\|applyDidYouMeanAndRetry\|_preflightStartBody\|_preflightCancelled\|_preflightEscapeHtml\|preflight-modal\|preflight-state\|preflight-progress\|preflight-sub\|preflight-results" src/ electron/ public/ server.js tests/
```
Expected: zero matches. (If anything appears, it's an oversight — fix in place before declaring done. Note the search **excludes** `preflightCheckStatus` and `preflight-check-toggle-*` — those are the preserved bulk-check feature.)

- [ ] **Step 2: Confirm preserved feature still has its hooks**

```bash
grep -n "preflightCheckStatus\|preflight-check-toggle" src/campaign.js server.js public/js/app.js public/index.html
```
Expected: multiple matches across all four files. (If any are zero, something was over-deleted — investigate.)

- [ ] **Step 3: Run tests**

```bash
npm test
```
Expected: all green.

- [ ] **Step 4: Manual UI test — connect_and_introduce launch**

1. Restart Electron (`npm run electron:dev`).
2. Open the launch wizard; pick `Connect + Introduce Back` mode.
3. Select one profile. Fill in primary person name + URL. Configure a tiny sheet (1 lead).
4. Click Launch.

Expected behavior:
- **No** "Verifying primary person" modal appears.
- Campaign logs go directly: `=== Campaign starting ===` → `Fetching sheet…` → `✓ Starting batch loop (BATCH_SIZE=5)…` → `→ [<profile>] <url>` — **no** `📋 Pre-flight: verifying primary person` line, **no** `[preflight:...]` lines, **no** `✓ Pre-flight verified primary person` line.
- Dashboard transitions to the running state.
- (Stop the campaign immediately after observing the above — no need to actually send connections.)

- [ ] **Step 5: Manual UI test — preserved bulk-check still works**

1. Open the launch wizard; pick `Message Only` or `Introduce Back` mode.
2. Confirm the "Pre-flight Check Status" toggle (`#preflight-check-toggle-mo` / `-ib`) is still visible and toggleable.
3. (Optional) Launch with the toggle on — confirm log line `📡 [<profile>] Pre-flight Check Status sweep…` still appears.

- [ ] **Step 6: Confirm `/api/preflight-only` is 404**

With Electron running, find the port in the boot log, then:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:<port>/api/preflight-only -H "Content-Type: application/json" -d '{}'
```
Expected: `404`.

- [ ] **Step 7: Final commit (if any cleanup happened in this task)**

If Steps 1–6 surfaced no fixes, no commit needed.
If any straggler was deleted, commit it:

```bash
git commit -am "cleanup: remove remaining preflight stragglers"
```

---

## Done when

- All 8 tasks complete with commits.
- `grep` from Task 8 Step 1 returns zero matches.
- `npm test` green.
- Manual launch test from Task 8 Step 4 shows no preflight modal and no preflight log lines.
- Manual bulk-check test from Task 8 Step 5 still works.
