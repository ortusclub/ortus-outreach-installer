# Operator Quick-Wins — Batch 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship three low-risk operator improvements as one branch: a connection-note nudge (#4), a toggle to disable periodic auto-checks (#1), and legible auto-update failures (#15).

**Architecture:** Each feature gets a small **pure helper** (frontend helpers as `public/js/*.mjs`, backend as `src/*.js`) that is TDD-tested with `node --test`, plus DOM/endpoint wiring verified manually (no UI test harness). No off-limits files (`src/linkedin/outreach.js`, `src/linkedin/actions.js`) are touched.

**Tech Stack:** Node ≥22 ESM, Express 4, vanilla JS modules (`app.js` is `<script type="module">`, imports `/js/*.mjs`), `node --test` + `node:assert/strict`. Bugatti design system (monochrome, hairlines, vars `--ink`/`--gray`/`--mono`, global `.hidden { display:none }`).

**Spec:** `docs/superpowers/specs/2026-06-18-operator-quickwins-batch1-design.md`

---

## File Structure

| File | New? | Responsibility |
|---|---|---|
| `public/js/note-hint.mjs` | new | Pure `shouldShowNoteHint(text)` predicate (#4) |
| `public/js/update-error.mjs` | new | Pure `summarizeUpdateError({...})` message builder (#15) |
| `src/monitoring-auto-checks.js` | new | Pure `shouldAutoFireCheck({...})` gate decision (#1) |
| `tests/note-hint.test.js` | new | #4 helper tests |
| `tests/update-error-summary.test.js` | new | #15 helper tests |
| `tests/monitoring-auto-checks.test.js` | new | #1 helper tests |
| `public/index.html` | mod | note-hint element (#4); update-detail element (#15) |
| `public/js/app.js` | mod | wire all three into the UI |
| `public/css/style.css` | mod | `.note-hint`, `.mon-auto-toggle`/`.mon-auto-hint`, `.update-detail`/`.update-log-pre` |
| `src/campaign.js` | mod | gate `tickMonitoringNow`; export `setMonitoringAutoChecks` (#1) |
| `src/monitoring-persistence.js` | mod | persist `autoChecksEnabled` (#1) |
| `server.js` | mod | `/api/monitoring/auto-checks`, state field (#1); `/api/update-log` (#15) |
| `package.json` | mod | version bumps per task |

---

## Task 0: Branch setup

**Files:** none (git only)

- [ ] **Step 1: Create the feature branch off the current trunk**

The current working branch is `eod-2102-integration` (the de-facto trunk; `origin/main` is behind). Branch from it:

```bash
cd /Users/antoniovarlese/ortus-gologin-clone
git checkout -b operator-quickwins-1
git branch --show-current   # expect: operator-quickwins-1
```

- [ ] **Step 2: Confirm tests are green before starting**

```bash
npm test 2>&1 | tail -5
```
Expected: all tests pass (baseline ~804 tests).

---

## Task 1: #4 — Connection-note nudge

**Files:**
- Create: `public/js/note-hint.mjs`
- Create: `tests/note-hint.test.js`
- Modify: `public/index.html:1271` (add hint element after the counter)
- Modify: `public/js/app.js:25-28` (import) and `public/js/app.js:1374-1381` (`updateTplNoteCount`)
- Modify: `public/css/style.css` (add `.note-hint`)

- [ ] **Step 1: Write the failing test**

Create `tests/note-hint.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldShowNoteHint } from '../public/js/note-hint.mjs';

test('shouldShowNoteHint is false for empty / whitespace / non-string', () => {
  assert.equal(shouldShowNoteHint(''), false);
  assert.equal(shouldShowNoteHint('   '), false);
  assert.equal(shouldShowNoteHint('\n\t'), false);
  assert.equal(shouldShowNoteHint(undefined), false);
  assert.equal(shouldShowNoteHint(null), false);
});

test('shouldShowNoteHint is true when the note has visible text', () => {
  assert.equal(shouldShowNoteHint('Hi there'), true);
  assert.equal(shouldShowNoteHint('  hi  '), true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
node --test tests/note-hint.test.js
```
Expected: FAIL — cannot find module `../public/js/note-hint.mjs`.

- [ ] **Step 3: Create the pure helper**

Create `public/js/note-hint.mjs`:

```js
/**
 * Pure predicate: should the "you probably don't need a note" hint be shown?
 * True only when the connection-note textarea holds non-whitespace text.
 * Lives in public/js so both app.js (browser) and node --test can import it.
 */
export function shouldShowNoteHint(noteText) {
  return typeof noteText === 'string' && noteText.trim().length > 0;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
node --test tests/note-hint.test.js
```
Expected: PASS (2 tests).

- [ ] **Step 5: Add the hint element to the HTML**

In `public/index.html`, the connect-note block is at lines 1268-1273. Insert the hint element immediately after the counter `div` (line 1271):

```html
      <div id="tpl-note-count" style="font-size:0.7rem; color:var(--gray); margin-top:4px; text-align:right; font-family:var(--mono);">0 / 300</div>
      <div id="tpl-note-hint" class="note-hint hidden">A blank note usually lifts acceptance and keeps intro threads clean — add one only if it clearly helps this audience.</div>
```

- [ ] **Step 6: Import the helper in app.js**

In `public/js/app.js`, the import block is at lines 25-28. Add after line 28:

```js
import { shouldShowNoteHint } from '/js/note-hint.mjs';
```

- [ ] **Step 7: Wire the helper into `updateTplNoteCount`**

Replace the body of `updateTplNoteCount` (currently lines 1374-1381):

```js
function updateTplNoteCount() {
  const ta = document.getElementById('tpl-note');
  const out = document.getElementById('tpl-note-count');
  if (!ta || !out) return;
  const n = (ta.value || '').length;
  out.textContent = `${n} / 300`;
  out.style.color = n >= 280 ? '#dc2626' : 'var(--gray)';
  const hint = document.getElementById('tpl-note-hint');
  if (hint) hint.classList.toggle('hidden', !shouldShowNoteHint(ta.value || ''));
}
```

(The function is already called on `oninput`, `DOMContentLoaded`, and init, so the hint updates on every change with no extra wiring.)

- [ ] **Step 8: Add the CSS**

In `public/css/style.css`, add near the other template styles (the global `.hidden { display:none }` at line 2004 already handles hide/show):

```css
.note-hint {
  font-size: 0.72rem;
  color: var(--gray);
  margin-top: 6px;
  line-height: 1.4;
}
```

- [ ] **Step 9: Bump version + commit**

```bash
# set package.json "version" to 2.111.2
git add public/js/note-hint.mjs tests/note-hint.test.js public/index.html public/js/app.js public/css/style.css package.json
git commit -m "feat(#4): nudge against unnecessary connection notes

Show a muted hint under the Connection Note box only when it has text.
Pure shouldShowNoteHint() helper, unit-tested.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 10: Manual verification** (orchestrator relaunches `dev:app`)

Open the wizard → Connection Note section. Type text → hint appears. Clear the box → hint disappears. Counter still updates and goes red at 280+.

---

## Task 2: #1 — Auto-checks toggle (backend)

**Files:**
- Create: `src/monitoring-auto-checks.js`
- Create: `tests/monitoring-auto-checks.test.js`
- Modify: `src/monitoring-persistence.js:35` (add field to allowlist)
- Modify: `src/campaign.js` (import ~line 49; gate `tickMonitoringNow` lines 4987-4989; add `setMonitoringAutoChecks` near line 5121)
- Modify: `server.js:1304` (state field) and after `:1288` (new endpoint)

- [ ] **Step 1: Write the failing test**

Create `tests/monitoring-auto-checks.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldAutoFireCheck } from '../src/monitoring-auto-checks.js';

const T0 = Date.parse('2026-06-18T12:00:00Z');
const past = new Date(T0 - 1000).toISOString();
const future = new Date(T0 + 60_000).toISOString();

test('fires when enabled (or unset) and nextCheckAt is due', () => {
  assert.equal(shouldAutoFireCheck({ autoChecksEnabled: true, nextCheckAt: past, now: T0 }), true);
  assert.equal(shouldAutoFireCheck({ autoChecksEnabled: undefined, nextCheckAt: past, now: T0 }), true);
});

test('does not fire when not yet due', () => {
  assert.equal(shouldAutoFireCheck({ autoChecksEnabled: true, nextCheckAt: future, now: T0 }), false);
});

test('does not fire when disabled, even if overdue', () => {
  assert.equal(shouldAutoFireCheck({ autoChecksEnabled: false, nextCheckAt: past, now: T0 }), false);
});

test('does not fire with missing / invalid nextCheckAt', () => {
  assert.equal(shouldAutoFireCheck({ autoChecksEnabled: true, nextCheckAt: null, now: T0 }), false);
  assert.equal(shouldAutoFireCheck({ autoChecksEnabled: true, nextCheckAt: 'nonsense', now: T0 }), false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
node --test tests/monitoring-auto-checks.test.js
```
Expected: FAIL — cannot find module `../src/monitoring-auto-checks.js`.

- [ ] **Step 3: Create the pure helper**

Create `src/monitoring-auto-checks.js`:

```js
/**
 * Pure decision: should the monitoring watcher fire an auto-check right now?
 *
 * - autoChecksEnabled === false  → never auto-fire (operator turned it off and
 *   uses the manual "Check now" button instead). Absent/undefined counts as
 *   enabled so existing campaigns and pre-existing state files keep firing.
 * - otherwise fire only when nextCheckAt is set and is now due.
 *
 * Does NOT cover the 7-day window expiry — that stays in tickMonitoringNow.
 */
export function shouldAutoFireCheck({ autoChecksEnabled, nextCheckAt, now }) {
  if (autoChecksEnabled === false) return false;
  if (!nextCheckAt) return false;
  const due = new Date(nextCheckAt).getTime();
  if (Number.isNaN(due)) return false;
  return now >= due;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
node --test tests/monitoring-auto-checks.test.js
```
Expected: PASS (4 tests).

- [ ] **Step 5: Persist the flag**

In `src/monitoring-persistence.js`, add `'autoChecksEnabled'` to the `MONITORING_FIELDS` array. Insert after `'checkIntervalMinutes',` (line 35):

```js
  'checkIntervalMinutes',
  // v2.112: operator toggle for the periodic auto-check. Absent in older
  // state files → undefined → treated as enabled (default-on).
  'autoChecksEnabled',
];
```

(No migration needed: `extractMonitoringSlice` copies only defined fields, and `resumeMonitoringFromDisk` does `Object.assign(campaign, slice)` — so the flag round-trips automatically.)

- [ ] **Step 6: Import the helper in campaign.js**

In `src/campaign.js`, add to the import block (near line 49, with the other `./` imports):

```js
import { shouldAutoFireCheck } from './monitoring-auto-checks.js';
```

- [ ] **Step 7: Gate `tickMonitoringNow` with the helper**

In `src/campaign.js`, replace the Duty-2 overdue guard (currently lines 4987-4989):

```js
    // Duty 2: fire bulk-check + auto-intros when nextCheckAt is overdue
    if (!campaign.nextCheckAt) return;
    if (Date.now() < new Date(campaign.nextCheckAt).getTime()) return;
```

with:

```js
    // Duty 2: fire bulk-check + auto-intros when nextCheckAt is overdue —
    // unless the operator turned automatic checks off (they then run them
    // manually via the Check now button). 7-day expiry above is unaffected.
    if (!shouldAutoFireCheck({
      autoChecksEnabled: campaign.autoChecksEnabled,
      nextCheckAt: campaign.nextCheckAt,
      now: Date.now(),
    })) return;
```

- [ ] **Step 8: Add the `setMonitoringAutoChecks` setter**

In `src/campaign.js`, add immediately before `export function getCampaignState()` (line 5121):

```js
/**
 * Operator toggle for the periodic monitoring auto-check. enabled=false stops
 * the watcher from auto-firing (manual "Check now" still works); enabled=true
 * resumes it. Persisted so it survives an app restart.
 */
export async function setMonitoringAutoChecks(enabled) {
  campaign.autoChecksEnabled = !!enabled;
  try { await writeMonitoringState(campaign); } catch { /* persistence is best-effort */ }
  return campaign.autoChecksEnabled;
}

```

- [ ] **Step 9: Expose the flag in `/api/monitoring/state`**

In `server.js`, in the `GET /api/monitoring/state` response object (lines 1304-1316), add after the `name: c.name,` line (1315):

```js
      name: c.name,
      autoChecksEnabled: c.autoChecksEnabled !== false,
```

- [ ] **Step 10: Add the `POST /api/monitoring/auto-checks` endpoint**

In `server.js`, add immediately after the `/api/monitoring/check-now` handler (after line 1288):

```js
app.post('/api/monitoring/auto-checks', async (req, res) => {
  try {
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled (boolean) required' });
    }
    const { getCampaignState, setMonitoringAutoChecks } = await import('./src/campaign.js');
    const state = getCampaignState();
    if (state.state !== 'monitoring') {
      return res.status(400).json({ error: 'Campaign is not in monitoring state' });
    }
    const value = await setMonitoringAutoChecks(enabled);
    res.json({ ok: true, autoChecksEnabled: value });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 11: Run the full suite (no regressions)**

```bash
npm test 2>&1 | tail -5
```
Expected: all pass (now including the 4 new auto-checks tests).

- [ ] **Step 12: Bump version + commit**

```bash
# set package.json "version" to 2.111.3
git add src/monitoring-auto-checks.js tests/monitoring-auto-checks.test.js src/monitoring-persistence.js src/campaign.js server.js package.json
git commit -m "feat(#1): backend gate + persistence + endpoint for disabling auto-checks

shouldAutoFireCheck() gates tickMonitoringNow; autoChecksEnabled persists in
the monitoring slice; POST /api/monitoring/auto-checks toggles it. Manual
Check now path untouched. Default-on (opt-out).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: #1 — Auto-checks toggle (frontend)

**Files:**
- Modify: `public/js/app.js` (`renderMonitoringCard` mon-actions ~line 9576; add `setMonitoringAutoChecks` client fn near line 9622)
- Modify: `public/css/style.css` (add `.mon-auto-toggle`, `.mon-auto-hint`)

- [ ] **Step 1: Render the toggle in the monitoring card**

In `public/js/app.js`, in `renderMonitoringCard(state)`, the `.mon-actions` block is at lines 9576-9579. Replace it (and add a hint line after) with:

```js
        <div class="mon-actions">
          <button class="mon-btn" id="mon-check-now-btn" onclick="monitoringCheckNow()">⚡ Check now</button>
          <button class="mon-btn danger" onclick="monitoringStop()">✕ Stop monitoring</button>
          <label class="mon-auto-toggle" title="When off, the timer won't run checks or fire intros/follow-ups automatically — use ⚡ Check now.">
            <input type="checkbox" id="mon-auto-checks" ${state.autoChecksEnabled !== false ? 'checked' : ''} onchange="setMonitoringAutoChecks(this.checked)">
            Automatic checks
          </label>
        </div>
        <div class="mon-auto-hint" id="mon-auto-hint" style="${state.autoChecksEnabled === false ? '' : 'display:none'}">Auto-checks are off — use ⚡ Check now to run a check (and fire any due intros/follow-ups).</div>
```

- [ ] **Step 2: Add the client `setMonitoringAutoChecks` function**

In `public/js/app.js`, add immediately after the `window.monitoringCheckNow = monitoringCheckNow;` line (line 9622):

```js
async function setMonitoringAutoChecks(enabled) {
  const hint = document.getElementById('mon-auto-hint');
  if (hint) hint.style.display = enabled ? 'none' : '';
  try {
    const r = await fetch('/api/monitoring/auto-checks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  } catch (err) {
    alert('Could not change automatic checks: ' + err.message);
    const cb = document.getElementById('mon-auto-checks');
    if (cb) cb.checked = !enabled;            // revert to reflect the failed change
    if (hint) hint.style.display = !enabled ? 'none' : '';
  }
}
window.setMonitoringAutoChecks = setMonitoringAutoChecks;
```

- [ ] **Step 3: Add the CSS**

In `public/css/style.css`, add after the `.mon-btn` rules (near line 5662):

```css
.mon-auto-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 0.78rem;
  color: var(--ink);
  cursor: pointer;
}
.mon-auto-hint {
  font-size: 0.72rem;
  color: var(--gray);
  margin-top: 6px;
}
```

- [ ] **Step 4: Bump version + commit**

```bash
# set package.json "version" to 2.111.4
git add public/js/app.js public/css/style.css package.json
git commit -m "feat(#1): monitoring-card toggle for automatic checks

Renders an Automatic checks switch next to Check now; reflects + persists
state via /api/monitoring/auto-checks; reverts on failure.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 5: Manual verification** (orchestrator relaunches `dev:app`)

With a campaign in monitoring state, open the monitoring card details:
1. The "Automatic checks" toggle shows, checked by default.
2. Turn it OFF → the hint appears; at the next 60s boundary the live log shows **no** "auto-check starting" line; the auto-intros/follow-ups do not fire.
3. "⚡ Check now" still runs a check while the toggle is off.
4. Reload the dashboard → the toggle still reads OFF (from `/api/monitoring/state`).
5. Restart the app → toggle still OFF (persisted in the monitoring slice).
6. Turn it ON → "auto-check starting" resumes at the next due boundary.

---

## Task 4: #15 — Update-error legibility (helper + server)

**Files:**
- Create: `public/js/update-error.mjs`
- Create: `tests/update-error-summary.test.js`
- Modify: `server.js:16` (add `stat` import) and after the `/api/update-install` block (~line 445, add `/api/update-log`)

- [ ] **Step 1: Write the failing test**

Create `tests/update-error-summary.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeUpdateError } from '../public/js/update-error.mjs';

test('download error takes priority and includes the cause', () => {
  const s = summarizeUpdateError({ downloadError: 'download failed: HTTP 404' });
  assert.match(s, /download failed/i);
  assert.match(s, /404/);
});

test('install error is reported when there is no download error', () => {
  assert.match(summarizeUpdateError({ installError: 'mount failed' }), /install failed/i);
});

test('fallback (manual drag) produces a non-error guidance line', () => {
  assert.match(summarizeUpdateError({ fallback: true }), /drag/i);
});

test('no signals → empty string', () => {
  assert.equal(summarizeUpdateError({}), '');
  assert.equal(summarizeUpdateError(), '');
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
node --test tests/update-error-summary.test.js
```
Expected: FAIL — cannot find module `../public/js/update-error.mjs`.

- [ ] **Step 3: Create the pure helper**

Create `public/js/update-error.mjs`:

```js
/**
 * Pure: turn the raw download/install failure signals into one short, specific
 * operator-facing line. Empty string when nothing failed. Lives in public/js
 * so both app.js (browser) and node --test can import it.
 *
 * @param {object} [o]
 * @param {string} [o.downloadError] - _downloadState.error from the server
 * @param {string} [o.installError]  - error from /api/update-install
 * @param {boolean} [o.fallback]     - install opened the DMG for a manual drag
 */
export function summarizeUpdateError({ downloadError, installError, fallback } = {}) {
  if (downloadError) return `Update download failed: ${downloadError}`;
  if (installError) return `Update install failed: ${installError}`;
  if (fallback) return 'Couldn’t auto-install — opened the installer so you can drag it to Applications.';
  return '';
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
node --test tests/update-error-summary.test.js
```
Expected: PASS (4 tests).

- [ ] **Step 5: Add `stat` to the fs/promises import**

In `server.js` line 16, add `stat`:

```js
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
```

- [ ] **Step 6: Add the `GET /api/update-log` endpoint**

In `server.js`, add after the `/api/update-install` handler closes (the handler ends around line 445, after the quit logic). Place it before the next unrelated route:

```js
// v2.112: expose the detached install-helper log so a failed update is
// diagnosable. The helper runs AFTER the app quits during a bundle swap, so
// its log is read on the NEXT launch. Read-only; no secrets in this log.
app.get('/api/update-log', async (_req, res) => {
  const logPath = join(tmpdir(), 'ortus-update.log');
  try {
    if (!existsSync(logPath)) {
      return res.json({ exists: false, downloadError: _downloadState.error || null });
    }
    const [text, st] = await Promise.all([readFile(logPath, 'utf8'), stat(logPath)]);
    res.json({ exists: true, text, mtimeMs: st.mtimeMs, downloadError: _downloadState.error || null });
  } catch (err) {
    res.json({ exists: false, error: err.message });
  }
});
```

(`join` and `tmpdir` are already imported and used by the install handler; `_downloadState` is the module-level state at line 307.)

- [ ] **Step 7: Run the full suite**

```bash
npm test 2>&1 | tail -5
```
Expected: all pass.

- [ ] **Step 8: Verify the endpoint responds**

```bash
node -e "import('./server.js').catch(e=>{console.error(e);process.exit(1)})" >/dev/null 2>&1 || true
# Smoke (manual, while dev:app runs): curl -s localhost:PORT/api/update-log → {"exists":false,...}
```
Expected: returns `{ "exists": false, ... }` cleanly when no log exists (no 500).

- [ ] **Step 9: Bump version + commit**

```bash
# set package.json "version" to 2.111.5
git add public/js/update-error.mjs tests/update-error-summary.test.js server.js package.json
git commit -m "feat(#15): pure update-error summary + GET /api/update-log

summarizeUpdateError() turns raw failure signals into one specific line;
/api/update-log exposes the detached install-helper log for diagnosis.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: #15 — Update-error legibility (frontend wiring)

**Files:**
- Modify: `public/index.html:29` (add `#update-detail` element)
- Modify: `public/js/app.js` (import ~line 25; `onUpdateClick` error branches lines 7812-7821; add `_showUpdateDetail`/`showUpdateLog`/`_checkLastUpdateAttempt`; DOMContentLoaded ~line 7843)
- Modify: `public/css/style.css` (add `.update-detail`, `.update-detail-btn`, `.update-log-pre`)

- [ ] **Step 1: Add the detail element to the HTML**

In `public/index.html`, the update-status block is lines 26-29. Add the detail element right after the closing `</div>` of `#update-status` (after line 29):

```html
        <div id="update-status" class="update-status hidden">
          <div class="update-bar"><div id="update-bar-fill" class="update-bar-fill"></div></div>
          <div id="update-status-text" class="update-status-text"></div>
        </div>
        <div id="update-detail" class="update-detail hidden"></div>
```

- [ ] **Step 2: Import the helper in app.js**

In `public/js/app.js`, add after the `summarize`-area imports (after line 28, alongside the note-hint import added in Task 1):

```js
import { summarizeUpdateError } from '/js/update-error.mjs';
```

- [ ] **Step 3: Add the detail/log/banner helpers**

In `public/js/app.js`, add immediately after `_hideUpdateStatus()` (which ends at line 7758):

```js
function _showUpdateDetail(msg) {
  const wrap = document.getElementById('update-status');
  const text = document.getElementById('update-status-text');
  const detail = document.getElementById('update-detail');
  if (wrap) wrap.classList.remove('hidden');
  if (text) text.textContent = msg;
  if (detail) {
    detail.classList.remove('hidden');
    detail.innerHTML = '<button type="button" class="update-detail-btn" onclick="showUpdateLog()">Details ▾</button><pre id="update-log-pre" class="update-log-pre hidden"></pre>';
  }
}
async function showUpdateLog() {
  const pre = document.getElementById('update-log-pre');
  if (!pre) return;
  if (!pre.classList.contains('hidden')) { pre.classList.add('hidden'); return; }
  try {
    const r = await (await fetch('/api/update-log')).json();
    pre.textContent = (r && r.exists && r.text)
      ? r.text
      : 'No install log on this machine yet — the failure was during download (see the message above), or the install helper has not run here.';
  } catch (e) {
    pre.textContent = 'Could not read the update log: ' + e.message;
  }
  pre.classList.remove('hidden');
}
window.showUpdateLog = showUpdateLog;
async function _checkLastUpdateAttempt() {
  try {
    const r = await (await fetch('/api/update-log')).json();
    if (!r || !r.exists || !r.text) return;
    const failed = /failed|no \.app|mount failed|copy failed|swap failed/i.test(r.text);
    const recent = r.mtimeMs ? (Date.now() - r.mtimeMs) < 24 * 3600 * 1000 : true;
    if (failed && recent) {
      _showUpdateDetail('The last update attempt didn’t complete. Open Details for the log, or retry from the update button.');
    }
  } catch { /* */ }
}
```

- [ ] **Step 4: Surface the specific error in `onUpdateClick`**

In `public/js/app.js`, replace the install + failure branches inside `onUpdateClick` (currently lines 7799-7821). The new version threads the real error through `summarizeUpdateError`:

```js
        pill.innerHTML = '<span class="update-pill-arrow">⟳</span> Installing…';
        if (text) text.textContent = 'Installing the update…';
        let inst = {};
        try { inst = await (await fetch('/api/update-install', { method: 'POST' })).json(); }
        catch (e) { inst = { error: e.message }; }
        if (inst.relaunching) {
          pill.innerHTML = '<span class="update-pill-arrow">✓</span> Updating — the app will reopen…';
          if (text) text.textContent = 'The app will close and reopen on the new version.';
        } else {
          // Fallback: DMG opened for a manual drag, or install error.
          const msg = summarizeUpdateError({ installError: inst.error, fallback: inst.fallback });
          pill.innerHTML = '<span class="update-pill-arrow">✓</span> Installer opened — drag to Applications';
          if (text) text.textContent = msg || 'Download complete.';
          if (inst.error) _showUpdateDetail(msg);
        }
      } else {
        const msg = summarizeUpdateError({ downloadError: res.error });
        pill.innerHTML = '<span class="update-pill-arrow">!</span> Failed — retry';
        pill.disabled = false;
        _showUpdateDetail(msg || 'Update failed.');
      }
    } catch (err) {
      pill.innerHTML = '<span class="update-pill-arrow">!</span> Failed — retry';
      pill.disabled = false;
      _showUpdateDetail(summarizeUpdateError({ downloadError: err.message }) || ('Update failed: ' + err.message));
    }
    return;
  }
```

(Note: the old failure branches called `_hideUpdateStatus()`; they now call `_showUpdateDetail(...)` so the operator sees the cause instead of a blank.)

- [ ] **Step 5: Run the post-failure check on load**

In `public/js/app.js`, the updater `DOMContentLoaded` handler is at lines 7843-7848. Add the `_checkLastUpdateAttempt()` call inside it:

```js
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => checkForUpdate(false), 800);
  setTimeout(() => _checkLastUpdateAttempt(), 1200);
  // Auto re-check every 30 min so an already-open app notices a new release
  // without needing a restart.
  setInterval(() => checkForUpdate(false), UPDATE_POLL_MS);
});
```

- [ ] **Step 6: Add the CSS**

In `public/css/style.css`, add near the existing `.update-status` rules:

```css
.update-detail { margin-top: 6px; }
.update-detail-btn {
  font-size: 0.72rem;
  background: none;
  border: none;
  color: var(--gray);
  cursor: pointer;
  padding: 0;
  text-decoration: underline;
}
.update-log-pre {
  max-height: 160px;
  overflow: auto;
  font-family: var(--mono);
  font-size: 0.68rem;
  white-space: pre-wrap;
  color: var(--ink);
  background: rgba(127,127,127,0.12);
  padding: 6px;
  margin-top: 4px;
}
```

- [ ] **Step 7: Bump version + commit**

```bash
# set package.json "version" to 2.111.6
git add public/index.html public/js/app.js public/css/style.css package.json
git commit -m "feat(#15): surface the real update failure + Details log view

Stop swallowing the download/install error — show the specific cause via
summarizeUpdateError, add a Details view backed by /api/update-log, and a
one-time post-failure banner on load.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 8: Manual verification** (orchestrator relaunches `dev:app`)

1. **Healthy path unaffected:** with no newer release, the pill shows "Check for updates"/"Up to date ✓"; no detail/banner appears.
2. **Download-failure message:** temporarily point the check at a bad asset (e.g. in a dev build set `UPDATE_REPO` to a nonexistent repo in `src/updater.js`, or block GitHub), force "behind", click → pill shows "Failed — retry" **and** `#update-status-text` shows e.g. "Update download failed: download failed: HTTP 404". Revert the temporary change afterward.
3. **Details view:** click "Details ▾" → fetches `/api/update-log`; with no log present it shows the friendly "No install log…" message (not a 500).
4. **Banner:** create a fake `/tmp/ortus-update.log` containing the word "failed" with a recent mtime, reload → the post-failure banner appears. Remove the file afterward.

---

## Task 6: Finish

**Files:** none (verification + branch wrap)

- [ ] **Step 1: Full test suite green**

```bash
npm test 2>&1 | tail -8
```
Expected: all pass, including `note-hint`, `monitoring-auto-checks`, `update-error-summary` (10 new tests total).

- [ ] **Step 2: Confirm no off-limits files were touched**

```bash
git diff --name-only eod-2102-integration..operator-quickwins-1 | grep -E 'src/linkedin/(outreach|actions)\.js' && echo "VIOLATION" || echo "clean — off-limits files untouched"
```
Expected: `clean — off-limits files untouched`.

- [ ] **Step 3: Final version sanity**

`package.json` version should be `2.111.6` (ahead of the published `2.111.1`, so the in-app updater offers it to the team).

- [ ] **Step 4: Finish the branch**

Announce: "I'm using the finishing-a-development-branch skill to complete this work." Then follow superpowers:finishing-a-development-branch (verify tests, present merge/PR/release options to the user, execute the choice). Releasing to the team is a separate, user-approved step (`npm run release:mac` needs the `ortusclub` gh account).

---

## Self-Review

**Spec coverage:**
- #4 note nudge → Task 1 (soft hint, shown only when note has text). ✓
- #1 disable periodic auto-checks + keep manual button → Tasks 2-3 (gate + persist + endpoint + toggle UI; `check-now` untouched). ✓
- #15 make failures legible (surface error + persist/expose log, not a blind fix) → Tasks 4-5. ✓
- Pure helpers TDD'd: `shouldShowNoteHint`, `shouldAutoFireCheck`, `summarizeUpdateError`. ✓
- No off-limits files; `bulkCheckConnections` only gated, never edited. ✓ (verified in Task 6 Step 2)
- #3 correctly absent (deferred to reliability batch). ✓

**Placeholder scan:** every code step shows complete code; no TBD/“handle errors”/“similar to”. ✓

**Type/name consistency:** `autoChecksEnabled` (campaign field + persisted key + state field + checkbox id `mon-auto-checks`); `setMonitoringAutoChecks` (server import name = campaign export name = client fn name — note the client fn and the server export share the name across layers, which is intentional and unambiguous since they live in different files); helper signatures match their call sites (`shouldAutoFireCheck({autoChecksEnabled,nextCheckAt,now})`, `summarizeUpdateError({downloadError,installError,fallback})`, `shouldShowNoteHint(text)`). ✓
