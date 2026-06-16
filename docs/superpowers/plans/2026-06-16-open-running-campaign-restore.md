# Open Running Campaign — Full Restore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pressing "Open" on the dashboard's live/monitoring campaign lands on a wizard that looks identical to the fully-configured, about-to-Start state — accounts selected, sheet preview rendered, columns mapped, templates + toggles populated — with the launch panel hidden, and only the live-activity log differing.

**Architecture:** Two root causes. (1) The full campaign config (`_lastRunSettings`) is in-memory only and set solely by `startCampaign`, so it's `null` after a restart / monitoring-resume → `/api/campaign/active-settings` returns `{ok:false}` → the front-end never restores. Fix: persist the snapshot to disk (atomic write) on start and fall back to it in `getLastRunSettings()`. (2) `applyPresetConfig` sets the sheet-URL field but never calls `previewSheet()`, which is the only thing that renders the sheet HTML *and builds the column-mapping dropdowns*. Fix: trigger `previewSheet()` on restore, then re-apply the saved column mapping. Plus: hide the launch panel when entering via Open (a read-only view of the live campaign).

**Tech Stack:** Node ≥22 ESM, `node --test`, Express 4, vanilla JS frontend (no bundler).

**Spec decisions (locked):**
- Read-only depth: **Start hidden only** — populate everything, hide the launch panel (Start / Queue / Schedule / Save-as-draft); do not disable individual fields.
- Part-3 preview fix applies to the **shared `applyPresetConfig` path** — Edit/Resume and preset-load benefit too.

**Repo conventions (READ FIRST):**
- Off-limits — **never** modify `src/linkedin/outreach.js` or `src/linkedin/actions.js`.
- Do **not** change the campaign engine loop or what Start/`startCampaign` does — this work is additive (a persisted snapshot + restore wiring + a view-only flag).
- Atomic JSON writes: write `<file>.tmp` then `rename` (see `appendErrorLog`, campaign.js:920-924).
- `node --test` must stay green (728+ tests today).
- Commits use **explicit file paths** (`git add <paths>`), never `git add -A` — the working tree carries unrelated in-flight work (preflight handshake etc.) that must not be swept in.
- After the final runtime commit: bump `package.json` version and relaunch `dev:app`.

---

## File Structure

| File | Responsibility | New? |
|---|---|---|
| `src/last-run-store.js` | Pure read/write of the persisted last-run snapshot (atomic write; missing/corrupt → null). No campaign import. | **new** |
| `tests/last-run-store.test.js` | Unit tests for the store (round-trip, missing → null, corrupt → null). | **new** |
| `src/campaign.js` | Wire the store: persist after the `_lastRunSettings` snapshot in `startCampaign`; disk fallback in `getLastRunSettings()`; clear on full stop. | modify |
| `public/js/app.js` | `applyPresetConfig`: trigger `previewSheet()` then restore column mapping. `dashOpenActive`: pass `senderColumn`/`allLeadsConnected`, set the view-only flag. View-only flag + `applyViewingActiveLock()` + clear on other wizard entries + apply on route. | modify |
| `public/index.html` | Add `id="launch-actions"` to the launch-panel container. | modify |
| `package.json` / `package-lock.json` | Version → `2.108.0`. | modify |

---

## Task 1: Pure last-run snapshot store

**Files:**
- Create: `src/last-run-store.js`
- Test: `tests/last-run-store.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/last-run-store.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { readLastRun, writeLastRun } from '../src/last-run-store.js';

function tmpFile(name) {
  const dir = mkdtempSync(join(os.tmpdir(), 'lastrun-'));
  return join(dir, name);
}

test('writeLastRun then readLastRun round-trips the object', () => {
  const p = tmpFile('snap.json');
  const snap = { mode: 'connect_and_introduce', profileIds: ['a', 'b'], sheetUrl: 'https://x', templates: { connectionNote: 'hi' } };
  writeLastRun(p, snap);
  assert.ok(existsSync(p));
  assert.deepEqual(readLastRun(p), snap);
});

test('readLastRun returns null for a missing file', () => {
  assert.equal(readLastRun(tmpFile('does-not-exist.json')), null);
});

test('readLastRun returns null for corrupt JSON (never throws)', () => {
  const p = tmpFile('corrupt.json');
  writeFileSync(p, '{ not valid json', 'utf8');
  assert.equal(readLastRun(p), null);
});

test('writeLastRun overwrites a previous snapshot', () => {
  const p = tmpFile('snap.json');
  writeLastRun(p, { a: 1 });
  writeLastRun(p, { b: 2 });
  assert.deepEqual(readLastRun(p), { b: 2 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/last-run-store.test.js`
Expected: FAIL — `Cannot find module '../src/last-run-store.js'`.

- [ ] **Step 3: Write the module**

```js
// src/last-run-store.js
/**
 * Durable store for the campaign's last-run settings snapshot. The campaign
 * engine keeps the snapshot in memory (lost on process restart / monitoring
 * resume); this persists a copy so "Open" can rehydrate the wizard after the
 * starting process is gone. Pure I/O — no campaign import. Best-effort: every
 * read failure (missing / corrupt) returns null rather than throwing, so a bad
 * file never breaks the dashboard.
 */
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';

/** Read + parse the snapshot. Missing or corrupt file → null. */
export function readLastRun(filePath) {
  try {
    if (!filePath || !existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/** Atomically persist the snapshot (tmp file + rename). */
export function writeLastRun(filePath, snapshot) {
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(snapshot, null, 2), 'utf8');
  renameSync(tmp, filePath);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/last-run-store.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/last-run-store.js tests/last-run-store.test.js
git commit -m "feat(open): pure store for persisting the last-run settings snapshot"
```

---

## Task 2: Persist the snapshot + disk fallback in campaign.js

**Files:**
- Modify: `src/campaign.js`
  - import the store + a path constant
  - persist right after the `_lastRunSettings` assignment (line ~1650)
  - disk fallback in `getLastRunSettings()` (line ~4693)
  - clear on full stop in `stopCampaign({ full })` (line ~4517)

No new unit test (covered by Task 1 + manual verification); correctness is the existing suite staying green + the manual check in Task 6.

- [ ] **Step 1: Add the import + path constant**

In the import block at the top of `src/campaign.js`, after the existing `import { dataPath } from './paths.js';` (line 54), add:

```js
import { readLastRun, writeLastRun } from './last-run-store.js';
```

Next to the other path constants (after `const HISTORY_PATH = dataPath('history.json');`, line 69), add:

```js
const LAST_RUN_FILE = dataPath('last-run-settings.json');
```

- [ ] **Step 2: Persist the snapshot after it's captured**

Find the `_lastRunSettings = { ... };` assignment (campaign.js ~1650). Immediately after its closing `};`, add:

```js
  // Persist the snapshot so "Open" can rehydrate the wizard after the starting
  // process is gone (server restart / monitoring resume re-loads from disk but
  // never re-runs startCampaign, so the in-memory copy is the only one). Best-
  // effort, synchronous atomic write — a disk failure must not block the run.
  try { writeLastRun(LAST_RUN_FILE, _lastRunSettings); } catch { /* non-fatal */ }
```

- [ ] **Step 3: Add the disk fallback to `getLastRunSettings()`**

Replace the existing function (campaign.js ~4693):

```js
export function getLastRunSettings() {
  return _lastRunSettings ? { ..._lastRunSettings } : null;
}
```

with:

```js
export function getLastRunSettings() {
  if (_lastRunSettings) return { ..._lastRunSettings };
  // In-memory snapshot is gone (server restarted / campaign resumed from disk
  // for monitoring). Fall back to the persisted copy so "Open" still restores.
  const fromDisk = readLastRun(LAST_RUN_FILE);
  return fromDisk ? { ...fromDisk } : null;
}
```

- [ ] **Step 4: Clear the persisted snapshot on a full stop**

Read `stopCampaign` (campaign.js ~4517). It sets `campaign._stoppedManually = true;` for a full stop. After that line, inside the `if (full)` path (or wherever `full === true` is handled — read the function first), clear the file so an idle dashboard can't resurrect stale config:

```js
  if (full) {
    try { writeLastRun(LAST_RUN_FILE, null); } catch { /* non-fatal */ }
  }
```

> Implementer note: confirm the exact shape of `stopCampaign({ full })` by reading 4517-4535 first. The clear must happen ONLY on a full stop — NOT when a campaign transitions into monitoring (the snapshot must survive into monitoring, which is the whole point). Writing `null` is fine: `readLastRun` parses `"null"` → `null` → `getLastRunSettings` returns null.

- [ ] **Step 5: Syntax check + full suite**

Run: `node --check src/campaign.js && node --test 2>&1 | tail -6`
Expected: syntax OK; full suite green (Task 1 tests included, no regressions).

- [ ] **Step 6: Commit**

```bash
git add src/campaign.js
git commit -m "fix(open): persist last-run snapshot so active-settings survives restart/monitoring"
```

---

## Task 3: Restore the sheet preview + column mapping in applyPresetConfig

**Files:**
- Modify: `public/js/app.js` — `applyPresetConfig` (the column-restore block, lines ~7298-7315)

No automated test (async DOM) — verified manually in Task 6. This fixes Open, Edit/Resume, and preset-load (shared path).

- [ ] **Step 1: Replace the column-restore block**

Find this block in `applyPresetConfig` (app.js ~7298-7315):

```js
  if (config.linkedinColumn) setV('linkedin-col-select', config.linkedinColumn);
  // v2.58.x — restore IC-only sheet-mapping picks. Dropdown + checkbox only
  // exist after a sheet preview renders them, so we defer the restore via
  // requestAnimationFrame to give the wizard a chance to populate columns.
  if (config.senderColumn || config.allLeadsConnected) {
    requestAnimationFrame(() => {
      try {
        if (config.senderColumn) {
          const sel = document.getElementById('ic-sender-col-select');
          if (sel) sel.value = config.senderColumn;
        }
        if (config.allLeadsConnected) {
          const tog = document.getElementById('ic-all-connected-toggle');
          if (tog) tog.checked = true;
        }
      } catch (_) {}
    });
  }
```

Replace it with:

```js
  // Render the sheet preview, THEN restore the column mapping. previewSheet()
  // is the only thing that fetches the sheet HTML and builds the column-select
  // dropdowns (#linkedin-col-select / #ic-sender-col-select) — without it the
  // table is blank and the saved column picks land on elements that don't exist
  // yet (the old requestAnimationFrame defer raced the dropdowns and lost). The
  // sheet-url field was set by setV above, so previewSheet reads the right URL.
  if (config.sheetUrl && typeof previewSheet === 'function') {
    Promise.resolve(previewSheet()).then(() => {
      if (config.linkedinColumn) {
        const sel = document.getElementById('linkedin-col-select');
        if (sel) sel.value = config.linkedinColumn;
      }
      if (config.senderColumn) {
        const sel = document.getElementById('ic-sender-col-select');
        if (sel) sel.value = config.senderColumn;
      }
      if (config.allLeadsConnected) {
        const tog = document.getElementById('ic-all-connected-toggle');
        if (tog) tog.checked = true;
      }
      if (typeof updateCampaignSummary === 'function') updateCampaignSummary();
    }).catch(() => { /* preview failed (bad URL / offline) — fields stay as set */ });
  }
```

- [ ] **Step 2: Syntax check**

Run: `node --check public/js/app.js`
Expected: syntax OK.

- [ ] **Step 3: Manual verification deferred to Task 6. Commit**

```bash
git add public/js/app.js
git commit -m "fix(open): render sheet preview on restore so HTML + column mapping repopulate"
```

---

## Task 4: dashOpenActive — pass IC mapping fields + set the view-only flag

**Files:**
- Modify: `public/js/app.js` — `dashOpenActive` (lines ~12963-13021)

No automated test (UI) — verified in Task 6.

- [ ] **Step 1: Set the view-only flag at the top of the handler**

In `dashOpenActive` (app.js ~12963), immediately inside the function (before the `viewRunningCampaign` call), add:

```js
  // Entering via Open = a read-only VIEW of the live campaign. The launch panel
  // is hidden (see applyViewingActiveLock). Flag is cleared by every other
  // wizard entry (+ New, Edit, preset-load) so staging a NEW campaign while one
  // runs still shows Start/Queue.
  window.__viewingActiveCampaign = true;
```

- [ ] **Step 2: Include the IC sheet-mapping fields in the rebuilt config**

Find the `config = { ... }` object inside the `try` (app.js ~12988-13002). It currently omits `senderColumn` and `allLeadsConnected` (both present in the server snapshot). Add them — locate the line `profileIds: Array.isArray(s.profileIds) ? s.profileIds : [],` and add directly after it:

```js
        senderColumn: s.senderColumn || '',
        allLeadsConnected: !!s.allLeadsConnected,
```

- [ ] **Step 3: Apply the lock after the restore runs**

Inside the `setTimeout(() => { ... }, 200)` at the end of `dashOpenActive`, after the `applyPresetConfig(config)` / name-input block and before the `scrollIntoView` logic, add:

```js
    if (typeof applyViewingActiveLock === 'function') applyViewingActiveLock();
```

(`applyViewingActiveLock` is defined in Task 5.)

- [ ] **Step 4: Syntax check + commit**

Run: `node --check public/js/app.js`
Expected: syntax OK.

```bash
git add public/js/app.js
git commit -m "fix(open): restore IC column mapping + flag the live-campaign view"
```

---

## Task 5: Hide the launch panel in the live-campaign view

**Files:**
- Modify: `public/index.html` — add an id to the launch-panel container (line ~1457)
- Modify: `public/js/app.js` — the flag helper + clear it on other wizard entries + apply on route

No automated test (UI) — verified in Task 6.

- [ ] **Step 1: Give the launch panel an id**

In `public/index.html` (line ~1457), change:

```html
          <div class="launch-actions launch-actions--four">
```

to:

```html
          <div class="launch-actions launch-actions--four" id="launch-actions">
```

- [ ] **Step 2: Add the flag helper in app.js**

Near the other wizard helpers (place it directly above `function applyRoute() {` at app.js ~8910), add:

```js
// When the operator opens the LIVE/monitoring campaign (dashboard "Open"), the
// wizard is a read-only view of what's running — hide the launch panel so they
// can't relaunch / queue / duplicate / save-as-draft the active campaign. Any
// other entry (+ New, Edit, preset) clears the flag, so staging a new campaign
// while one runs still shows the launch panel.
window.__viewingActiveCampaign = window.__viewingActiveCampaign || false;
function applyViewingActiveLock() {
  const panel = document.getElementById('launch-actions');
  if (panel) panel.style.display = window.__viewingActiveCampaign ? 'none' : '';
}
window.applyViewingActiveLock = applyViewingActiveLock;
```

- [ ] **Step 3: Apply the lock on every wizard render**

In `applyRoute()` (app.js ~8910), inside the `else {` branch (the `isWizard` true branch), after `startWizardPolling();` (the last statement in that branch, ~line 8945), add:

```js
    if (typeof applyViewingActiveLock === 'function') applyViewingActiveLock();
```

- [ ] **Step 4: Clear the flag on the non-Open wizard entries**

Add `window.__viewingActiveCampaign = false;` as the FIRST line of each of these functions so they always show the launch panel:

In `startNewCampaign` (app.js ~10895 — the function containing `selectedProfileIds = [];` at 10916), add at the very top of the function body:

```js
  window.__viewingActiveCampaign = false;
```

In `editPastCampaign` (app.js ~10615), add at the top of the function body (before the `try {`):

```js
  window.__viewingActiveCampaign = false;
```

In `editDraft` (app.js ~9141), add at the top of the function body:

```js
  window.__viewingActiveCampaign = false;
```

In `loadPresetByName` (app.js ~7496), add at the top of the function body (before the `if (!name) return;`):

```js
  window.__viewingActiveCampaign = false;
```

> Implementer note: read each function's opening lines first and insert the assignment as the first executable statement. These are belt-and-suspenders — `dashOpenActive` is the only setter of `true`; everything else resets to `false`.

- [ ] **Step 5: Syntax check**

Run: `node --check public/js/app.js`
Expected: syntax OK.

- [ ] **Step 6: Commit**

```bash
git add public/index.html public/js/app.js
git commit -m "feat(open): hide the launch panel when viewing the live campaign"
```

---

## Task 6: Version bump, relaunch, manual verification

**Files:**
- Modify: `package.json`, `package-lock.json` → `2.108.0`.

- [ ] **Step 1: Bump version**

```bash
node -e 'const fs=require("fs");for(const f of ["package.json","package-lock.json"]){const j=JSON.parse(fs.readFileSync(f,"utf8"));if(j.version)j.version="2.108.0";if(j.packages&&j.packages[""]&&j.packages[""].version)j.packages[""].version="2.108.0";fs.writeFileSync(f,JSON.stringify(j,null,2)+"\n");}console.log("version ->",JSON.parse(fs.readFileSync("package.json","utf8")).version);'
```

- [ ] **Step 2: Full suite + relaunch**

```bash
node --test 2>&1 | tail -8
pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "Electron.*ortus" 2>/dev/null
npm run dev:app > /tmp/dev-app.log 2>&1 &
until grep -q "Dashboard:" /tmp/dev-app.log 2>/dev/null; do :; done
grep -E "Ortus Outreach v|Dashboard:" /tmp/dev-app.log | tail -2
```

Expected: full suite green; boots `v2.108.0`.

- [ ] **Step 3: Manual verification (operator)**

With the existing monitoring campaign live (or start a fresh campaign, then relaunch the dev app to force the in-memory snapshot to be gone):

1. **Persistence:** after a relaunch, the live campaign still shows on the dashboard with "Open". Confirm `data/last-run-settings.json` exists and has `profileIds` / `sheetUrl` / `templates`.
2. **Open restores everything:** press Open → the wizard shows the **GoLogin accounts selected** (picker SELECTED count > 0), the **sheet preview table rendered**, the **column mapping** populated (LinkedIn URL column, and IC sender column if CC+IC), and all **template fields + toggles** filled — identical to the about-to-Start state.
3. **Launch panel hidden:** in that Open'd view, the Start / Queue / Schedule / Save-as-draft panel is **hidden**.
4. **New campaign unaffected:** click "+ New campaign" → launch panel is **visible** again; fields are cleared.
5. **Edit/preset still work:** Edit a past campaign (or load a preset) → sheet preview renders + columns restore (shared-path fix), launch panel **visible**.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: bump to 2.108.0 — Open restores the full live-campaign view"
```

---

## Self-review notes (author)

- **Spec coverage:** sheet HTML + columns missing → Task 3 (previewSheet trigger) + Task 2 (snapshot available); accounts SELECTED 0 → Task 2 (config now returned → applyPresetConfig runs → existing `selectedProfileIds` restore fires); "a bit of template" / IC mapping → Task 3 + Task 4 Step 2 (senderColumn/allLeadsConnected); Start locked/hidden → Task 5; fix-everywhere decision → Task 3 lives in shared `applyPresetConfig`. ✓
- **Off-limits:** `outreach.js`/`actions.js` untouched; engine loop untouched (persistence + restore wiring only). ✓
- **Type/name consistency:** `readLastRun`/`writeLastRun` used identically in Tasks 1-2; `LAST_RUN_FILE` defined once (Task 2 Step 1); `applyViewingActiveLock` defined in Task 5 Step 2, called in Task 4 Step 3 + Task 5 Step 3; `window.__viewingActiveCampaign` set true only in `dashOpenActive` (Task 4 Step 1), reset false in Task 5 Step 4. ✓
- **Known soft spots flagged for the implementer:** exact `stopCampaign({ full })` shape (Task 2 Step 4 — read 4517-4535 first); exact opening lines of `startNewCampaign`/`editPastCampaign`/`editDraft`/`loadPresetByName` for the flag-reset insertion (Task 5 Step 4).
- **Commit hygiene:** every `git add` lists explicit paths — the dirty working tree (preflight handshake + other WIP) must not be swept into these commits.
