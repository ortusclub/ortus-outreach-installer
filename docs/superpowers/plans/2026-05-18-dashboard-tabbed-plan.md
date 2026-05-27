# Dashboard Tabbed Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the stacked-sections dashboard at `public/index.html:160-225` with a 7-tab layout (Active / Monitoring / Queued / Schedules / Drafts / Past / All), with always-visible bulk-select + delete and a dedicated Monitoring tab.

**Architecture:** Wrap the existing per-section list containers (`#active-campaign-list`, `#queued-campaign-list`, `#schedules-campaign-list`, `#drafts-campaign-list`, `#past-campaign-list`) inside new `.dash-panel` blocks under a tab bar. The existing render functions (`refreshActiveCampaign`, `refreshDashboardDrafts`, `refreshDashboardQueue`, `refreshDashboardSchedules`, `refreshPastCampaigns`) keep writing to the same container IDs they always have — we only add two data attributes (`data-campaign-id`, `data-state`) to each `.campaign-row` so the new orchestration layer can decorate them with checkboxes, hide them by state, and bulk-delete them. Two new orchestration functions handle the Monitoring tab (filter from past) and the All tab (merged view with status pill).

**Tech Stack:** Vanilla HTML/CSS/JS (no React, no bundler). Node ≥22 for tests. `node:test` framework. Bugatti command-deck design tokens already in `public/css/style.css`.

**Spec:** `docs/superpowers/specs/2026-05-18-dashboard-tabbed-design.md` — every UX decision in this plan is grounded there.

**Constraints (operator-stated):**
- Existing campaign data is preserved — no migration, no wipe.
- Off-limits backend files (`src/linkedin/outreach.js`, `src/linkedin/actions.js`, `src/campaign.js`) have zero diff. This is a frontend-only change.
- The 5 existing render functions are NOT rewritten. We only add two data attributes per row.
- Status string values in the Google Sheet are unchanged.
- "Don't delete existing code logic" — anything we remove from `app.js` is verified-obsolete via grep first.

---

## File structure

| File | Action | Responsibility |
|---|---|---|
| `public/index.html` | **Modify** lines 160-225 | Replace `.dashboard-section` blocks with `.dash-tabs` + `.dash-toolbar` + `.dash-bulkstrip` + `.dash-panels` wrapper. Each panel wraps an existing list container. |
| `public/css/style.css` | **Append** new `.dash-*` classes at end of file | Tab bar, toolbar, panels, bulk strip, row decorator, dialog. No existing class modified. |
| `public/js/app.js` | **Modify** existing render functions (2-attribute additions only) + **Append** dashboard orchestration module | Dashboard tab controller, selection state, search filter, bulk delete dialog, keyboard shortcuts, localStorage persistence. |
| `src/dashboard-state.js` | **Create** (new) | Pure helpers: `pickDefaultTab`, `computeCrossTabQualifier`, selection set helpers. Importable by tests. |
| `tests/dashboard-state.test.js` | **Create** (new) | Unit tests for the pure helpers. |

**Files explicitly NOT touched:** `src/linkedin/outreach.js`, `src/linkedin/actions.js`, `src/campaign.js`, `server.js`, `electron/main.js`, anything in `data/`, anything in Apps Script.

---

## Task 1: Pure helpers + tests

**Files:**
- Create: `src/dashboard-state.js`
- Create: `tests/dashboard-state.test.js`

- [ ] **Step 1: Write the failing tests**

File: `tests/dashboard-state.test.js`

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickDefaultTab,
  computeCrossTabQualifier,
  addToSelection,
  removeFromSelection,
  toggleInSelection,
} from '../src/dashboard-state.js';

test('pickDefaultTab: returns "monitoring" when monitoring has entries', () => {
  const counts = { active: 0, monitoring: 3, queued: 0, schedules: 0, drafts: 0, past: 5, all: 8 };
  assert.equal(pickDefaultTab(counts), 'monitoring');
});

test('pickDefaultTab: returns "active" when monitoring empty but active populated', () => {
  const counts = { active: 1, monitoring: 0, queued: 0, schedules: 0, drafts: 0, past: 5, all: 6 };
  assert.equal(pickDefaultTab(counts), 'active');
});

test('pickDefaultTab: returns "all" when both monitoring and active empty', () => {
  const counts = { active: 0, monitoring: 0, queued: 2, schedules: 0, drafts: 1, past: 5, all: 8 };
  assert.equal(pickDefaultTab(counts), 'all');
});

test('pickDefaultTab: respects persisted tab when provided and that tab has rows', () => {
  const counts = { active: 0, monitoring: 3, queued: 0, schedules: 0, drafts: 0, past: 5, all: 8 };
  assert.equal(pickDefaultTab(counts, 'past'), 'past');
});

test('pickDefaultTab: falls back from persisted-but-empty tab to monitoring default', () => {
  const counts = { active: 0, monitoring: 3, queued: 0, schedules: 0, drafts: 0, past: 0, all: 3 };
  assert.equal(pickDefaultTab(counts, 'past'), 'monitoring');
});

test('computeCrossTabQualifier: returns empty when all selected ids are in active tab', () => {
  const selection = new Set(['m1', 'm2']);
  const idsByTab = { active: ['a1'], monitoring: ['m1', 'm2', 'm3'], past: ['p1'] };
  const result = computeCrossTabQualifier(selection, 'monitoring', idsByTab);
  assert.equal(result, '');
});

test('computeCrossTabQualifier: reports count when selection spans tabs', () => {
  const selection = new Set(['m1', 'p1', 'p2']);
  const idsByTab = { active: ['a1'], monitoring: ['m1', 'm2'], past: ['p1', 'p2'] };
  const result = computeCrossTabQualifier(selection, 'monitoring', idsByTab);
  assert.equal(result, '· 2 IN OTHER TABS');
});

test('computeCrossTabQualifier: works when active tab has zero selected', () => {
  const selection = new Set(['p1', 'p2']);
  const idsByTab = { active: ['a1'], monitoring: ['m1'], past: ['p1', 'p2'] };
  const result = computeCrossTabQualifier(selection, 'monitoring', idsByTab);
  assert.equal(result, '· 2 IN OTHER TABS');
});

test('addToSelection: adds an id (returns new Set, leaves input unchanged)', () => {
  const input = new Set(['a']);
  const out = addToSelection(input, 'b');
  assert.deepEqual([...out], ['a', 'b']);
  assert.deepEqual([...input], ['a']);
});

test('removeFromSelection: removes an id', () => {
  const input = new Set(['a', 'b']);
  const out = removeFromSelection(input, 'a');
  assert.deepEqual([...out], ['b']);
});

test('toggleInSelection: adds when absent, removes when present', () => {
  let s = new Set();
  s = toggleInSelection(s, 'x');
  assert.deepEqual([...s], ['x']);
  s = toggleInSelection(s, 'x');
  assert.deepEqual([...s], []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/dashboard-state.test.js`
Expected: 11 failures — error "Cannot find module" for `src/dashboard-state.js`.

- [ ] **Step 3: Create `src/dashboard-state.js`**

File: `src/dashboard-state.js`

```javascript
/**
 * Pure helpers for the dashboard tab controller. No DOM, no fetch, no
 * state — everything is a pure function so unit tests cover the routing
 * + selection logic without spinning up a browser.
 */

/**
 * Pick which tab to show on dashboard load.
 *
 * Order:
 *   1. If a persisted tab is provided AND that tab has rows → use it.
 *   2. Else if monitoring has rows → 'monitoring' (the operator's most
 *      time-sensitive context — campaigns still actively working).
 *   3. Else if active has rows → 'active' (next-most-time-sensitive).
 *   4. Else → 'all' (last-resort fallback so the page is never empty).
 *
 * @param {object} counts - { active, monitoring, queued, schedules, drafts, past, all }
 * @param {string} [persisted] - tab name from localStorage, may be empty/null
 * @returns {string} tab name
 */
export function pickDefaultTab(counts = {}, persisted = '') {
  const safe = {
    active: counts.active || 0,
    monitoring: counts.monitoring || 0,
    queued: counts.queued || 0,
    schedules: counts.schedules || 0,
    drafts: counts.drafts || 0,
    past: counts.past || 0,
    all: counts.all || 0,
  };
  if (persisted && Object.prototype.hasOwnProperty.call(safe, persisted) && safe[persisted] > 0) {
    return persisted;
  }
  if (safe.monitoring > 0) return 'monitoring';
  if (safe.active > 0) return 'active';
  return 'all';
}

/**
 * Compute the "· N IN OTHER TABS" qualifier for the bulk-action strip.
 * Returns '' when all selected ids belong to the active tab.
 *
 * @param {Set<string>} selection - selected campaign ids
 * @param {string} activeTab - currently-active tab name
 * @param {Record<string,string[]>} idsByTab - per-tab id lists
 * @returns {string} qualifier text or ''
 */
export function computeCrossTabQualifier(selection, activeTab, idsByTab = {}) {
  if (!selection || selection.size === 0) return '';
  const activeIds = new Set(idsByTab[activeTab] || []);
  let inOther = 0;
  for (const id of selection) {
    if (!activeIds.has(id)) inOther++;
  }
  if (inOther === 0) return '';
  return `· ${inOther} IN OTHER TABS`;
}

/**
 * Return a new Set with `id` added. Input set is not mutated.
 */
export function addToSelection(selection, id) {
  const out = new Set(selection);
  out.add(id);
  return out;
}

/**
 * Return a new Set with `id` removed. Input set is not mutated.
 */
export function removeFromSelection(selection, id) {
  const out = new Set(selection);
  out.delete(id);
  return out;
}

/**
 * Return a new Set with `id` toggled. Input set is not mutated.
 */
export function toggleInSelection(selection, id) {
  return selection.has(id)
    ? removeFromSelection(selection, id)
    : addToSelection(selection, id);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/dashboard-state.test.js`
Expected: 11 tests passing.

- [ ] **Step 5: Run full suite**

Run: `npm test`
Expected: previous count + 11 new tests passing, 2 skipped.

- [ ] **Step 6: Commit**

```bash
git add src/dashboard-state.js tests/dashboard-state.test.js
git commit -m "feat(dashboard): pure helpers for tab routing + selection (pickDefaultTab, computeCrossTabQualifier, selection ops)"
```

---

## Task 2: HTML structure — wrap existing list containers in tab panels

**Files:**
- Modify: `public/index.html` (lines 160-225)

This task replaces the five `.dashboard-section` blocks with the new tab bar + toolbar + bulk strip + panels structure. **The existing list container IDs (`#active-campaign-list`, etc.) are PRESERVED** — they just live inside `.dash-panel` wrappers now. This is critical: the existing render functions writing to those IDs continue to work unchanged.

- [ ] **Step 1: Read the current lines 160-225 of `public/index.html`**

This is the block currently being replaced. Skim it once so you know what's leaving and what's staying.

- [ ] **Step 2: Replace lines 160-225 with the new structure**

Find the block in `public/index.html` that starts with `<section class="dashboard-section">` (containing the Active list) and ends just before `<div class="dashboard-actions">`. Replace the entire block with:

```html
      <!-- ── Tab bar — 7 categories ── -->
      <div class="dash-tabs" id="dash-tabs" role="tablist">
        <button type="button" class="dash-tab" data-tab="active" role="tab" aria-selected="false">Active <span class="dash-tab-ct" data-ct="active">0</span></button>
        <button type="button" class="dash-tab" data-tab="monitoring" role="tab" aria-selected="false">Monitoring <span class="dash-tab-ct" data-ct="monitoring">0</span><span class="dash-tab-new" data-new="monitoring" hidden>0 new</span></button>
        <button type="button" class="dash-tab" data-tab="queued" role="tab" aria-selected="false">Queued <span class="dash-tab-ct" data-ct="queued">0</span></button>
        <button type="button" class="dash-tab" data-tab="schedules" role="tab" aria-selected="false">Schedules <span class="dash-tab-ct" data-ct="schedules">0</span></button>
        <button type="button" class="dash-tab" data-tab="drafts" role="tab" aria-selected="false">Drafts <span class="dash-tab-ct" data-ct="drafts">0</span></button>
        <button type="button" class="dash-tab" data-tab="past" role="tab" aria-selected="false">Past <span class="dash-tab-ct" data-ct="past">0</span></button>
        <button type="button" class="dash-tab" data-tab="all" role="tab" aria-selected="false">All <span class="dash-tab-ct" data-ct="all">0</span></button>
      </div>

      <!-- ── Toolbar — select all + search ── -->
      <div class="dash-toolbar">
        <span class="dash-selall" id="dash-selall" role="button" tabindex="0">
          <span class="dash-check" id="dash-selall-check" aria-hidden="true"></span>
          <span class="dash-selall-label">SELECT ALL</span>
        </span>
        <input class="dash-search" id="dash-search" type="text" placeholder="Search this list…" autocomplete="off" />
      </div>

      <!-- ── Bulk action strip — appears when selection >= 1 ── -->
      <div class="dash-bulkstrip" id="dash-bulkstrip" hidden aria-live="polite">
        <div class="dash-bulkstrip-l">
          <span class="dash-bulk-n" id="dash-bulk-n">0</span>SELECTED
          <span class="dash-bulk-qual" id="dash-bulk-qual"></span>
        </div>
        <div class="dash-bulkstrip-r">
          <button type="button" class="btn btn-secondary" onclick="dashClearSelection()">CLEAR</button>
          <button type="button" class="btn btn-secondary" id="dash-bulk-pause" onclick="dashBulkPauseWatch()" hidden>PAUSE WATCH</button>
          <button type="button" class="btn btn-stop" onclick="dashBulkDelete()">DELETE</button>
        </div>
      </div>

      <!-- ── Panels — only one visible at a time. Existing list containers
           are PRESERVED inside their respective panel so existing render
           functions (refreshActiveCampaign, refreshDashboardQueue, etc.)
           continue to write into the same DOM ids they always have. ── -->
      <div class="dash-panels">
        <div class="dash-panel" data-panel="active" id="dash-panel-active" role="tabpanel" hidden>
          <div class="campaign-list" id="active-campaign-list">
            <p class="empty-state">No active campaigns.</p>
          </div>
        </div>

        <div class="dash-panel" data-panel="monitoring" id="dash-panel-monitoring" role="tabpanel" hidden>
          <div class="campaign-list" id="monitoring-campaign-list">
            <p class="empty-state">No campaigns are being monitored.</p>
          </div>
        </div>

        <div class="dash-panel" data-panel="queued" id="dash-panel-queued" role="tabpanel" hidden>
          <div class="campaign-list" id="queued-campaign-list">
            <p class="empty-state">No queued campaigns.</p>
          </div>
        </div>

        <div class="dash-panel" data-panel="schedules" id="dash-panel-schedules" role="tabpanel" hidden>
          <div class="campaign-list" id="schedules-campaign-list">
            <p class="empty-state">No schedules yet.</p>
          </div>
        </div>

        <div class="dash-panel" data-panel="drafts" id="dash-panel-drafts" role="tabpanel" hidden>
          <div class="campaign-list" id="drafts-campaign-list">
            <p class="empty-state">No drafts yet.</p>
          </div>
        </div>

        <div class="dash-panel" data-panel="past" id="dash-panel-past" role="tabpanel" hidden>
          <div class="campaign-list" id="past-campaign-list">
            <p class="empty-state">No past campaigns yet.</p>
          </div>
        </div>

        <div class="dash-panel" data-panel="all" id="dash-panel-all" role="tabpanel" hidden>
          <div class="campaign-list" id="all-campaign-list">
            <p class="empty-state">No campaigns yet.</p>
          </div>
        </div>
      </div>
```

- [ ] **Step 3: Verify the existing IDs are preserved**

Run:
```bash
grep -n "active-campaign-list\|queued-campaign-list\|schedules-campaign-list\|drafts-campaign-list\|past-campaign-list" public/index.html
```

Expected: each ID appears exactly once. The new file should look identical to before in terms of these IDs — they're just wrapped in `.dash-panel` now.

- [ ] **Step 4: Open dev:app and verify the page still loads**

Run: `pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "Electron.*ortus" 2>/dev/null; npm run dev:app > /tmp/dev-app.log 2>&1 &`

Wait 4 seconds, then open the dev:app window. Cmd+R the dashboard. Expected: the page loads without JS errors. The new tab bar is visible at the top. Panels are all hidden because the orchestration JS isn't wired yet — but the page must not error out.

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "feat(dashboard): swap stacked sections for tabs + toolbar + bulk strip + panels"
```

---

## Task 3: CSS — new `.dash-*` classes

**Files:**
- Modify: `public/css/style.css` (append at end)

All new classes are prefixed `dash-` to avoid collision. Tokens (`--ink`, `--gold`, `--hairline`, `--display`, etc.) are reused from the existing Bugatti command-deck system at the top of `style.css`.

- [ ] **Step 1: Append new CSS at the end of `public/css/style.css`**

Add these styles at the very end of the file:

```css

/* ──────────────────────────────────────────────────────────────────────
   Dashboard tabbed layout — v2.51
   Spec: docs/superpowers/specs/2026-05-18-dashboard-tabbed-design.md
   ─────────────────────────────────────────────────────────────────── */

.dash-tabs {
  display: flex;
  border-bottom: 1px solid var(--hairline);
  gap: 0;
  margin-top: 0;
  overflow-x: auto;
}
.dash-tab {
  padding: 16px 22px;
  font-family: var(--display);
  font-weight: 400;
  font-size: 0.98rem;
  letter-spacing: 0.06em;
  color: var(--gray);
  cursor: pointer;
  border: none;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  background: transparent;
  display: inline-flex;
  align-items: baseline;
  gap: 8px;
  white-space: nowrap;
  transition: color 0.12s ease;
}
.dash-tab:hover { color: var(--ink); }
.dash-tab.on { color: var(--ink); border-bottom-color: var(--gold); }
.dash-tab-ct {
  font-family: var(--body);
  font-size: 0.6rem;
  letter-spacing: 0.18em;
  color: var(--gray);
  padding: 2px 8px;
  border: 1px solid var(--hairline);
  border-radius: 9999px;
}
.dash-tab.on .dash-tab-ct { border-color: var(--gold); color: var(--gold); }
.dash-tab-new {
  background: var(--gold);
  color: #000;
  border-radius: 9999px;
  padding: 1px 6px;
  font-size: 0.54rem;
  font-weight: 700;
  letter-spacing: 0.04em;
}

.dash-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 0 14px;
  border-bottom: 1px solid var(--hairline-soft, rgba(255,255,255,0.06));
}
.dash-selall {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--gray);
  font-size: 0.7rem;
  letter-spacing: 0.06em;
  cursor: pointer;
  user-select: none;
}
.dash-selall:hover { color: var(--ink); }
.dash-check {
  width: 14px;
  height: 14px;
  border: 1px solid var(--hairline);
  border-radius: 2px;
  position: relative;
  display: inline-block;
  transition: all 0.12s ease;
}
.dash-check.on { border-color: var(--gold); background: var(--gold); }
.dash-check.on::after {
  content: "✓";
  position: absolute;
  color: #000;
  font-size: 11px;
  left: 1px;
  top: -3px;
  font-weight: 700;
}
.dash-check.some { border-color: var(--gold); background: rgba(247,190,104,0.4); }
.dash-check.some::after {
  content: "–";
  position: absolute;
  color: #000;
  font-size: 11px;
  left: 3px;
  top: -3px;
  font-weight: 700;
}
.dash-search {
  background: transparent;
  border: 1px solid var(--hairline);
  color: var(--ink);
  padding: 6px 12px;
  font-family: var(--body);
  font-size: 0.72rem;
  border-radius: 9999px;
  width: 240px;
  outline: none;
  transition: border-color 0.12s ease;
}
.dash-search:focus { border-color: var(--ink); }
.dash-search::placeholder { color: var(--gray); }

.dash-bulkstrip {
  background: rgba(247,190,104,0.05);
  border: 1px solid var(--gold);
  padding: 10px 16px;
  margin: 14px 0;
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 0.72rem;
  animation: dash-slidedown 0.2s ease;
}
@keyframes dash-slidedown {
  from { opacity: 0; transform: translateY(-6px); }
  to   { opacity: 1; transform: translateY(0); }
}
.dash-bulk-n {
  color: var(--gold);
  font-family: var(--display);
  font-size: 1.05rem;
  margin-right: 10px;
  letter-spacing: 0.05em;
}
.dash-bulk-qual {
  color: var(--gray);
  margin-left: 6px;
  font-size: 0.66rem;
  letter-spacing: 0.14em;
}
.dash-bulkstrip-r { display: flex; gap: 8px; }

.dash-panels { margin-top: 8px; }
.dash-panel { display: none; }
.dash-panel.on { display: block; }

/* Row-level decoration injected by orchestration JS.
   Existing .campaign-row markup is untouched; we prepend a .dash-row-check
   span and toggle .dash-row-sel on the row itself. */
.campaign-row.dash-row-sel {
  background: rgba(247,190,104,0.05);
  border-color: rgba(247,190,104,0.25);
}
.dash-row-check {
  width: 14px;
  height: 14px;
  border: 1px solid var(--hairline);
  border-radius: 2px;
  cursor: pointer;
  position: relative;
  display: inline-block;
  vertical-align: middle;
  margin-right: 12px;
  flex-shrink: 0;
  transition: all 0.12s ease;
}
.dash-row-check.on { border-color: var(--gold); background: var(--gold); }
.dash-row-check.on::after {
  content: "✓";
  position: absolute;
  color: #000;
  font-size: 11px;
  left: 1px;
  top: -3px;
  font-weight: 700;
}

/* Status pill — used only on rows rendered in the All tab */
.dash-row-pill {
  display: inline-block;
  font-family: var(--display);
  font-size: 0.78rem;
  letter-spacing: 0.08em;
  padding: 2px 10px;
  border: 1px solid var(--hairline);
  border-radius: 9999px;
  color: var(--gray);
  margin-right: 10px;
}
.dash-row-pill.active     { color: var(--green); border-color: var(--green); }
.dash-row-pill.monitoring { color: var(--gold);  border-color: var(--gold); }
.dash-row-pill.queued     { color: var(--ink); }
.dash-row-pill.draft      { color: var(--gray); opacity: 0.75; }
.dash-row-pill.past       { color: var(--gray); opacity: 0.55; }
.dash-row-pill.stopped    { color: var(--red);   border-color: var(--red); }

/* Confirmation dialog for bulk delete */
.dash-dialog-bg {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
  animation: dash-fadein 0.15s ease;
}
@keyframes dash-fadein { from { opacity: 0; } to { opacity: 1; } }
.dash-dialog {
  background: #0a0a0a;
  border: 1px solid var(--red, #f85149);
  padding: 28px 32px;
  max-width: 480px;
  width: 90%;
}
.dash-dialog h2 {
  font-family: var(--display);
  font-weight: 400;
  font-size: 1.35rem;
  letter-spacing: 0.06em;
  color: var(--red, #f85149);
  margin-bottom: 12px;
  text-transform: uppercase;
}
.dash-dialog p {
  font-size: 0.85rem;
  line-height: 1.5;
  margin-bottom: 16px;
}
.dash-dialog p b { color: var(--ink); }
.dash-dialog-preview {
  border: 1px solid var(--hairline-soft, rgba(255,255,255,0.06));
  padding: 10px 14px;
  margin-bottom: 18px;
  font-size: 0.74rem;
  color: var(--gray);
  max-height: 140px;
  overflow: auto;
}
.dash-dialog-preview span { display: block; padding: 2px 0; }
.dash-dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
```

- [ ] **Step 2: Verify the page renders with the new styles**

Cmd+R the dev:app dashboard. The tab bar should now have proper monochrome styling with gold-on-hover and gold under-line on the active tab. Toolbar should be aligned. Panels should still be hidden.

- [ ] **Step 3: Commit**

```bash
git add public/css/style.css
git commit -m "feat(dashboard): CSS for tab bar, toolbar, bulk strip, panels, dialog"
```

---

## Task 4: Tab orchestration JS — switch tabs, update count badges, panel visibility

**Files:**
- Modify: `public/js/app.js` (append a new dashboard-orchestration block near the end)

This task wires the tabs themselves: clicking a tab shows its panel and hides others, updates the `aria-selected` state, and reads the count from each panel's child list to update the badge.

- [ ] **Step 1: Append the orchestration module at the END of `public/js/app.js`**

Add this code at the very end of `app.js` (after the last existing line):

```javascript

// ──────────────────────────────────────────────────────────────────────
// Dashboard tabbed layout — v2.51
// Spec: docs/superpowers/specs/2026-05-18-dashboard-tabbed-design.md
// All exported as window.dashXxx so onclick attributes in index.html find them.
// ──────────────────────────────────────────────────────────────────────

import {
  pickDefaultTab as _dashPickDefaultTab,
  computeCrossTabQualifier as _dashComputeQualifier,
  toggleInSelection as _dashToggleSel,
} from '../src/dashboard-state.js';

const DASH_TABS = ['active', 'monitoring', 'queued', 'schedules', 'drafts', 'past', 'all'];
const DASH_PERSIST_KEY = 'ortus.dashboard.activeTab';

let _dashActiveTab = '';        // current tab name
let _dashSelection = new Set(); // selected campaign ids (across tabs)
let _dashSearch = '';           // current search query (per active tab)

/** Read campaign ids per tab from the rendered DOM. Source of truth: the
 *  list containers populated by the existing refresh* functions. */
function dashGetIdsByTab() {
  const out = {};
  for (const tab of DASH_TABS) {
    if (tab === 'all') continue; // special-cased
    const list = document.getElementById(`${tab === 'monitoring' ? 'monitoring' : tab}-campaign-list`);
    if (!list) { out[tab] = []; continue; }
    out[tab] = Array.from(list.querySelectorAll('.campaign-row[data-campaign-id]'))
      .map((r) => r.dataset.campaignId);
  }
  // 'all' is the union of every other tab — Set dedupes if the same id
  // appears in two tabs (shouldn't, but defensive).
  const allIds = new Set();
  for (const tab of DASH_TABS) {
    if (tab === 'all') continue;
    for (const id of (out[tab] || [])) allIds.add(id);
  }
  out.all = Array.from(allIds);
  return out;
}

/** Update the count badges on the tab bar. */
function dashUpdateCounts() {
  const ids = dashGetIdsByTab();
  for (const tab of DASH_TABS) {
    const el = document.querySelector(`.dash-tab-ct[data-ct="${tab}"]`);
    if (el) el.textContent = (ids[tab] || []).length;
  }
}

/** Show the panel for `tab`, hide all others. Updates aria-selected. */
function dashShowPanel(tab) {
  for (const t of DASH_TABS) {
    const panel = document.getElementById(`dash-panel-${t}`);
    const btn = document.querySelector(`.dash-tab[data-tab="${t}"]`);
    if (panel) {
      panel.hidden = (t !== tab);
      panel.classList.toggle('on', t === tab);
    }
    if (btn) {
      btn.classList.toggle('on', t === tab);
      btn.setAttribute('aria-selected', t === tab ? 'true' : 'false');
    }
  }
}

/** Switch to `tab`. Clears search, re-renders selection state for the new tab. */
function dashSetTab(tab) {
  if (!DASH_TABS.includes(tab)) return;
  _dashActiveTab = tab;
  _dashSearch = '';
  const search = document.getElementById('dash-search');
  if (search) search.value = '';
  dashShowPanel(tab);
  dashApplySearch();
  dashRenderSelection();
  dashRenderBulkStrip();
  try { localStorage.setItem(DASH_PERSIST_KEY, tab); } catch {}
}

/** Apply the current search filter to the rows in the active panel.
 *  Rows that don't match get .dash-hidden-by-search; the empty-state
 *  message is swapped if the filter would leave zero visible rows. */
function dashApplySearch() {
  const panel = document.getElementById(`dash-panel-${_dashActiveTab}`);
  if (!panel) return;
  const q = (_dashSearch || '').toLowerCase().trim();
  const rows = panel.querySelectorAll('.campaign-row[data-campaign-id]');
  let visibleCount = 0;
  rows.forEach((row) => {
    if (!q) {
      row.style.display = '';
      visibleCount++;
      return;
    }
    const text = row.textContent.toLowerCase();
    const match = text.includes(q);
    row.style.display = match ? '' : 'none';
    if (match) visibleCount++;
  });
  // Toggle a "no matches" overlay
  let overlay = panel.querySelector('.dash-search-empty');
  if (q && visibleCount === 0 && rows.length > 0) {
    if (!overlay) {
      overlay = document.createElement('p');
      overlay.className = 'empty-state dash-search-empty';
      overlay.textContent = 'No matches. Try a different search term.';
      panel.querySelector('.campaign-list').appendChild(overlay);
    }
  } else if (overlay) {
    overlay.remove();
  }
}

/** Apply the selection state (gold tint + checkbox state) to every visible row. */
function dashRenderSelection() {
  // For every campaign-row in every panel, ensure the checkbox is present and
  // reflects the current selection state.
  const allRows = document.querySelectorAll('.dash-panel .campaign-row[data-campaign-id]');
  allRows.forEach((row) => {
    const id = row.dataset.campaignId;
    if (!id) return;
    let check = row.querySelector(':scope > .dash-row-check');
    if (!check) {
      check = document.createElement('span');
      check.className = 'dash-row-check';
      check.dataset.id = id;
      check.setAttribute('role', 'checkbox');
      check.tabIndex = 0;
      row.prepend(check);
    }
    const sel = _dashSelection.has(id);
    check.classList.toggle('on', sel);
    row.classList.toggle('dash-row-sel', sel);
    check.setAttribute('aria-checked', sel ? 'true' : 'false');
  });
  // Master select-all reflects the visible-row state of the active panel
  dashRenderSelectAll();
}

/** Update the master select-all checkbox state (none / some / all). */
function dashRenderSelectAll() {
  const panel = document.getElementById(`dash-panel-${_dashActiveTab}`);
  const check = document.getElementById('dash-selall-check');
  if (!panel || !check) return;
  const visible = Array.from(panel.querySelectorAll('.campaign-row[data-campaign-id]'))
    .filter((r) => r.style.display !== 'none');
  const selected = visible.filter((r) => _dashSelection.has(r.dataset.campaignId));
  check.classList.remove('on', 'some');
  if (visible.length > 0 && selected.length === visible.length) check.classList.add('on');
  else if (selected.length > 0) check.classList.add('some');
}

/** Show or hide the bulk-action strip, update count + qualifier + button visibility. */
function dashRenderBulkStrip() {
  const strip = document.getElementById('dash-bulkstrip');
  const nEl = document.getElementById('dash-bulk-n');
  const qualEl = document.getElementById('dash-bulk-qual');
  const pauseBtn = document.getElementById('dash-bulk-pause');
  if (!strip || !nEl || !qualEl || !pauseBtn) return;
  const n = _dashSelection.size;
  strip.hidden = (n === 0);
  nEl.textContent = String(n);
  const ids = dashGetIdsByTab();
  qualEl.textContent = _dashComputeQualifier(_dashSelection, _dashActiveTab, ids);
  // Show PAUSE WATCH only when at least one monitoring row is selected
  const monitoringIds = new Set(ids.monitoring || []);
  let anyMonitoringSelected = false;
  for (const id of _dashSelection) {
    if (monitoringIds.has(id)) { anyMonitoringSelected = true; break; }
  }
  pauseBtn.hidden = !anyMonitoringSelected;
}

/** Wire row-checkbox + select-all + search + tab clicks. Idempotent. */
function dashInitListeners() {
  // Tab clicks
  const tabs = document.getElementById('dash-tabs');
  if (tabs && !tabs.__dashWired) {
    tabs.addEventListener('click', (e) => {
      const btn = e.target.closest('.dash-tab');
      if (btn) dashSetTab(btn.dataset.tab);
    });
    tabs.__dashWired = true;
  }
  // Select-all
  const selall = document.getElementById('dash-selall');
  if (selall && !selall.__dashWired) {
    selall.addEventListener('click', dashToggleSelectAll);
    selall.__dashWired = true;
  }
  // Search input
  const search = document.getElementById('dash-search');
  if (search && !search.__dashWired) {
    search.addEventListener('input', (e) => {
      _dashSearch = e.target.value;
      dashApplySearch();
      dashRenderSelectAll();
    });
    search.__dashWired = true;
  }
  // Row checkbox clicks — event delegation on the body since rows come and go
  if (!document.body.__dashRowWired) {
    document.body.addEventListener('click', (e) => {
      const check = e.target.closest('.dash-row-check');
      if (check) {
        e.stopPropagation();
        const id = check.dataset.id;
        if (id) {
          _dashSelection = _dashToggleSel(_dashSelection, id);
          dashRenderSelection();
          dashRenderBulkStrip();
        }
      }
    });
    document.body.__dashRowWired = true;
  }
}

/** Master select-all click. Toggles every VISIBLE row in the active panel. */
function dashToggleSelectAll() {
  const panel = document.getElementById(`dash-panel-${_dashActiveTab}`);
  if (!panel) return;
  const visible = Array.from(panel.querySelectorAll('.campaign-row[data-campaign-id]'))
    .filter((r) => r.style.display !== 'none');
  const visibleIds = visible.map((r) => r.dataset.campaignId);
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => _dashSelection.has(id));
  if (allSelected) {
    for (const id of visibleIds) _dashSelection.delete(id);
  } else {
    for (const id of visibleIds) _dashSelection.add(id);
  }
  dashRenderSelection();
  dashRenderBulkStrip();
}

function dashClearSelection() {
  _dashSelection = new Set();
  dashRenderSelection();
  dashRenderBulkStrip();
}

function dashBulkPauseWatch() {
  // v2.51 — backend pause-monitoring not yet wired. Show a toast.
  const n = _dashSelection.size;
  if (typeof window.showToast === 'function') {
    window.showToast(`Pause Watch is not wired yet (${n} selected). Coming in the next release.`);
  } else {
    alert(`Pause Watch is not wired yet (${n} selected). Coming in the next release.`);
  }
}

/** Called by the existing refresh* functions OR on demand to re-decorate
 *  everything. Updates counts + selection + strip. Safe to call frequently. */
function dashRefreshAll() {
  dashUpdateCounts();
  dashRenderSelection();
  dashRenderBulkStrip();
}

/** First-paint: pick the default tab and show it. Called once on app load. */
function dashInit() {
  dashInitListeners();
  dashUpdateCounts();
  const ids = dashGetIdsByTab();
  const counts = {};
  for (const t of DASH_TABS) counts[t] = (ids[t] || []).length;
  let persisted = '';
  try { persisted = localStorage.getItem(DASH_PERSIST_KEY) || ''; } catch {}
  const tab = _dashPickDefaultTab(counts, persisted);
  dashSetTab(tab);
}

// Expose globals for index.html onclick handlers and for other modules to call
window.dashSetTab = dashSetTab;
window.dashClearSelection = dashClearSelection;
window.dashBulkPauseWatch = dashBulkPauseWatch;
window.dashRefreshAll = dashRefreshAll;
window.dashInit = dashInit;
// dashBulkDelete is wired in Task 6
```

- [ ] **Step 2: Add the init call**

Find the existing `DOMContentLoaded` handler at the end of `app.js` (search for `DOMContentLoaded` — there's an existing one near the end). Add `dashInit();` to its body. If there's no central handler, append:

```javascript
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { if (typeof dashInit === 'function') dashInit(); });
} else {
  if (typeof dashInit === 'function') dashInit();
}
```

at the very end of `app.js`.

- [ ] **Step 3: Verify the file still parses**

Run: `node --check public/js/app.js`
Expected: clean parse, no output.

- [ ] **Step 4: Reload dev:app and verify tab switching works**

Cmd+R the Electron window. Click each tab — the panel should swap. Count badges all read `0` (no `data-campaign-id` rows exist yet — that's Task 7). No JS errors in the console.

- [ ] **Step 5: Commit**

```bash
git add public/js/app.js
git commit -m "feat(dashboard): tab orchestration — switch, count badges, selection state, search"
```

---

## Task 5: Bulk delete confirmation dialog

**Files:**
- Modify: `public/js/app.js` (append `dashBulkDelete` near the other dash functions)

- [ ] **Step 1: Append the bulk-delete function**

Add this code at the end of `app.js` (after the dashboard orchestration block from Task 4, BEFORE the init call):

```javascript

/** Open a confirmation dialog for the current selection. On confirm, removes
 *  the campaigns from the dashboard via the existing per-row delete API.
 *  Cancel: no-op. */
function dashBulkDelete() {
  if (_dashSelection.size === 0) return;
  const ids = Array.from(_dashSelection);

  // Collect display names from the visible DOM
  const names = ids.map((id) => {
    const row = document.querySelector(`.campaign-row[data-campaign-id="${CSS.escape(id)}"]`);
    if (!row) return id;
    const nameEl = row.querySelector('.campaign-row-name, .campaign-row-name-text');
    return nameEl ? (nameEl.textContent || id).trim() : id;
  });

  // Build the dialog
  const bg = document.createElement('div');
  bg.className = 'dash-dialog-bg';
  bg.innerHTML = `
    <div class="dash-dialog" role="dialog" aria-modal="true" aria-labelledby="dash-dialog-h">
      <h2 id="dash-dialog-h">Delete ${ids.length} campaign${ids.length === 1 ? '' : 's'}?</h2>
      <p>This removes <b>${ids.length}</b> campaign${ids.length === 1 ? '' : 's'} from the dashboard. <b>Google Sheet rows are not affected.</b></p>
      <div class="dash-dialog-preview"></div>
      <div class="dash-dialog-actions">
        <button type="button" class="btn btn-secondary" id="dash-dialog-cancel">CANCEL</button>
        <button type="button" class="btn btn-stop" id="dash-dialog-confirm">DELETE ${ids.length}</button>
      </div>
    </div>
  `;
  // Populate preview with escaped names
  const preview = bg.querySelector('.dash-dialog-preview');
  for (const name of names) {
    const span = document.createElement('span');
    span.textContent = `· ${name}`;
    preview.appendChild(span);
  }
  document.body.appendChild(bg);

  // Focus the cancel button by default — safer than focusing the destructive one
  const cancelBtn = bg.querySelector('#dash-dialog-cancel');
  const confirmBtn = bg.querySelector('#dash-dialog-confirm');
  cancelBtn.focus();

  const close = () => bg.remove();
  cancelBtn.onclick = close;
  bg.onclick = (e) => { if (e.target === bg) close(); };
  document.addEventListener('keydown', function onKey(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
  });

  confirmBtn.onclick = async () => {
    close();
    await dashPerformBulkDelete(ids);
  };
}

/** Perform the actual deletion. Calls the existing /api/past/delete endpoint
 *  per id (no batch endpoint exists today; doing it serially is fine for
 *  reasonable selection sizes — confirmation gates it). Refreshes dashboard
 *  state on completion. */
async function dashPerformBulkDelete(ids) {
  let succeeded = 0;
  let failed = 0;
  for (const id of ids) {
    try {
      const resp = await fetch(`/api/past/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (resp.ok) succeeded++;
      else failed++;
    } catch {
      failed++;
    }
  }
  _dashSelection = new Set();
  // Refresh whichever per-tab list is currently visible (and the All tab data)
  try { if (typeof refreshPastCampaigns === 'function') await refreshPastCampaigns(); } catch {}
  try { if (typeof refreshDashboardDrafts === 'function') await refreshDashboardDrafts(); } catch {}
  try { if (typeof refreshDashboardQueue === 'function') await refreshDashboardQueue(); } catch {}
  try { if (typeof refreshDashboardSchedules === 'function') await refreshDashboardSchedules(); } catch {}
  try { if (typeof refreshActiveCampaign === 'function') await refreshActiveCampaign(); } catch {}
  dashRefreshAll();
  const msg = failed === 0
    ? `Deleted ${succeeded} campaign${succeeded === 1 ? '' : 's'}.`
    : `Deleted ${succeeded}, ${failed} failed.`;
  if (typeof window.showToast === 'function') window.showToast(msg);
}

window.dashBulkDelete = dashBulkDelete;
```

- [ ] **Step 2: Verify the existing `/api/past/<id>` DELETE endpoint exists**

Run:
```bash
grep -n "app\.delete.*past\|\.delete.*'/api/past" server.js
```

If found → great, the endpoint exists.
If NOT found → flag this as a concern back to the controller; the plan may need adjustment to use whatever endpoint actually exists.

- [ ] **Step 3: Verify file parses**

Run: `node --check public/js/app.js`
Expected: clean parse.

- [ ] **Step 4: Commit**

```bash
git add public/js/app.js
git commit -m "feat(dashboard): bulk-delete confirmation dialog calling existing per-id DELETE endpoint"
```

---

## Task 6: Add `data-campaign-id` + `data-state` attributes to existing campaign-row HTML

**Files:**
- Modify: `public/js/app.js` — the existing render functions

This task adds two data attributes to EVERY `.campaign-row` element emitted by:
- `refreshActiveCampaign` (line ~6505)
- `refreshDashboardQueue` (line ~6188)
- `refreshDashboardSchedules` (line ~6293)
- `refreshDashboardDrafts` (line ~6116)
- `refreshPastCampaigns` (line ~6893)

The attributes:
- `data-campaign-id="<unique-id>"` — what the orchestration uses for selection. For past/queued/drafts, this is the campaign's history entry id. For active, it's a literal `"active"` (only one row exists).
- `data-state="<active|monitoring|queued|schedules|draft|past|stopped>"` — what the orchestration uses for status pills + the Monitoring/Past filter.

**Critical: this task does NOT change rendering output otherwise. Only two attributes are added per row.**

- [ ] **Step 1: Modify `refreshActiveCampaign` (line ~6505)**

Find every line in `refreshActiveCampaign` that creates a row beginning `<div class="campaign-row` and add `data-campaign-id="active" data-state="active"` (for the active campaign) or `data-campaign-id="draft" data-state="draft"` (for the surfaced draft) to the opening div tag.

Example transform — find:
```html
<div class="campaign-row campaign-row--with-edit">
  <div class="campaign-row-name">${dashboardNameButton(draftName, 'draft', 'draft')}</div>
```

Change to:
```html
<div class="campaign-row campaign-row--with-edit" data-campaign-id="draft" data-state="draft">
  <div class="campaign-row-name">${dashboardNameButton(draftName, 'draft', 'draft')}</div>
```

And for the active campaign row (the `else` branch with `status.running`):
```html
<div class="campaign-row campaign-row--with-edit" data-campaign-id="active" data-state="active">
```

- [ ] **Step 2: Modify `refreshDashboardQueue` (line ~6188)**

Each queued campaign row needs `data-campaign-id="${q.id || q.queueId || ''}" data-state="queued"`. Read the function body to determine the correct id field — the function constructs queue entries; use whatever field uniquely identifies a queued campaign.

- [ ] **Step 3: Modify `refreshDashboardSchedules` (line ~6293)**

Same pattern: `data-campaign-id="${s.id || s.scheduleId || ''}" data-state="schedules"`.

- [ ] **Step 4: Modify `refreshDashboardDrafts` (line ~6116)**

Same pattern: `data-campaign-id="${d.id || d.draftId || ''}" data-state="draft"`.

- [ ] **Step 5: Modify `refreshPastCampaigns` (line ~6893)**

Two changes:
1. Add `data-campaign-id="${p.id || p.runId || ''}" data-state="${p.state === 'monitoring' ? 'monitoring' : (p.state || 'past')}"` to each row.
2. **Filter out monitoring** from the past list. Inside `refreshPastCampaigns`, after the existing data fetch + sort, add a filter step:
   ```javascript
   const _pastOnly = (pastList || []).filter((p) => p.state !== 'monitoring');
   const _monitoringOnly = (pastList || []).filter((p) => p.state === 'monitoring');
   ```
   Render `_pastOnly` into `#past-campaign-list` (as today) and **also** render `_monitoringOnly` into `#monitoring-campaign-list` using the same row HTML.

- [ ] **Step 6: At the END of each modified refresh function, call `dashRefreshAll()`**

Add this line at the end of each of the 5 functions (just before the closing brace of the function):

```javascript
if (typeof dashRefreshAll === 'function') dashRefreshAll();
```

This ensures count badges and selection state stay in sync whenever the underlying lists change.

- [ ] **Step 7: Render the All tab**

Append a new function:

```javascript
/** Render the All tab by cloning rows from every other panel's list into
 *  #all-campaign-list, prepending a status pill based on data-state. */
function renderDashboardAll() {
  const target = document.getElementById('all-campaign-list');
  if (!target) return;
  const sources = ['active', 'monitoring', 'queued', 'schedules', 'drafts', 'past'];
  const fragments = [];
  for (const src of sources) {
    const list = document.getElementById(`${src}-campaign-list`);
    if (!list) continue;
    list.querySelectorAll('.campaign-row[data-campaign-id]').forEach((row) => {
      const clone = row.cloneNode(true);
      // Remove any previously-injected checkbox so the cloned row picks up
      // the fresh one when dashRenderSelection() runs next.
      clone.querySelectorAll('.dash-row-check').forEach((c) => c.remove());
      // Prepend a status pill
      const state = clone.dataset.state || 'past';
      const pill = document.createElement('span');
      pill.className = `dash-row-pill ${state}`;
      pill.textContent = state.toUpperCase();
      // Insert pill at the start of the name cell if it exists, else as first child
      const nameCell = clone.querySelector('.campaign-row-name') || clone;
      nameCell.prepend(pill);
      fragments.push(clone);
    });
  }
  target.innerHTML = '';
  if (fragments.length === 0) {
    target.innerHTML = '<p class="empty-state">No campaigns yet.</p>';
  } else {
    for (const f of fragments) target.appendChild(f);
  }
  if (typeof dashRefreshAll === 'function') dashRefreshAll();
}
window.renderDashboardAll = renderDashboardAll;
```

Wire this call into the `dashSetTab` function from Task 4 — when the user switches to the `all` tab, call `renderDashboardAll()`:

Find this line in `dashSetTab`:
```javascript
dashShowPanel(tab);
```

Add ONE line above it:
```javascript
if (tab === 'all') renderDashboardAll();
dashShowPanel(tab);
```

- [ ] **Step 8: Verify file parses**

Run: `node --check public/js/app.js`
Expected: clean parse.

- [ ] **Step 9: Test in dev:app**

Cmd+R the Electron dashboard. Verify:
- Count badges update with actual numbers
- Each tab shows the right campaigns
- Monitoring tab actually contains campaigns whose state is monitoring (you may need to start a CC+IC campaign to test this — or skip and verify via manual sheet inspection)
- All tab shows everything with status pills
- Checkboxes appear next to each row and selection works
- Bulk strip appears when you click any checkbox

- [ ] **Step 10: Commit**

```bash
git add public/js/app.js
git commit -m "feat(dashboard): tag rows with data-campaign-id+data-state; split monitoring out of past; render All tab"
```

---

## Task 7: Keyboard shortcuts + cleanup obsolete functions

**Files:**
- Modify: `public/js/app.js`

- [ ] **Step 1: Append keyboard-shortcut handler at the end of `app.js`**

```javascript

// Dashboard keyboard shortcuts. Only fire when focus is inside the dashboard view
// (or on body) AND no input/textarea is focused (so typing doesn't trigger).
function dashKeyHandler(e) {
  const dashView = document.getElementById('dashboard-view');
  if (!dashView || dashView.style.display === 'none') return;
  // Ignore key events when typing in an input/textarea/contenteditable
  const t = document.activeElement;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;

  // 1..7 → tab
  if (e.key >= '1' && e.key <= '7') {
    const idx = Number(e.key) - 1;
    if (idx >= 0 && idx < DASH_TABS.length) {
      dashSetTab(DASH_TABS[idx]);
      e.preventDefault();
    }
    return;
  }
  // / → focus search
  if (e.key === '/') {
    const search = document.getElementById('dash-search');
    if (search) { search.focus(); e.preventDefault(); }
    return;
  }
  // Esc → clear selection
  if (e.key === 'Escape' && _dashSelection.size > 0) {
    dashClearSelection();
    e.preventDefault();
    return;
  }
  // Cmd/Ctrl+A → select all visible
  if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
    dashToggleSelectAll();
    e.preventDefault();
    return;
  }
  // Backspace/Delete → bulk delete (only when selection non-empty)
  if ((e.key === 'Backspace' || e.key === 'Delete') && _dashSelection.size > 0) {
    dashBulkDelete();
    e.preventDefault();
    return;
  }
}
document.addEventListener('keydown', dashKeyHandler);
```

- [ ] **Step 2: Identify obsolete functions safely**

For each candidate-for-removal, grep BEFORE removing to confirm no other code references it. Run:

```bash
grep -n "togglePastManageMode\|togglePastExpanded\|onPastSearchInput\|clearPastSelection\|bulkDeletePastSelected\|renderPastBulkBar" public/js/app.js public/index.html
```

Expected references:
- `togglePastManageMode` — defined in app.js, called only from index.html's removed Past section (now gone). If grep shows only the definition in app.js and zero remaining onclicks in index.html, safe to remove.
- Same check for the others.

**Do NOT remove if any external reference remains.** Flag as a concern instead.

- [ ] **Step 3: Remove obsolete functions**

For each function confirmed-orphaned in Step 2, delete its definition AND any `window.xxx = xxx` export line. Reference comment in app.js (look for `// v2.11.5: collapse + search for the past-campaigns list.`):

The obsolete functions and their typical locations:
- `togglePastManageMode` (function definition + `window.togglePastManageMode = togglePastManageMode;` export)
- `togglePastExpanded` (function definition + export)
- `onPastSearchInput` (function definition + export)
- `clearPastSelection` (function definition + export)
- `bulkDeletePastSelected` (function definition + export)
- `renderPastBulkBar` (function definition only — no window export — keep if it's called from somewhere internal)

For each: cut the function, run `node --check public/js/app.js`, run `npm test`. If both pass, the removal was safe.

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: previous count + 11 dashboard-state tests passing, no regressions.

- [ ] **Step 5: Manual test in dev:app**

Cmd+R. Try:
- Press `1` through `7` — tabs switch
- Press `/` — search focuses
- Select some campaigns, press `Esc` — selection clears
- Select campaigns, press `⌘+A` — toggles select-all
- Select campaigns, press Backspace — confirmation dialog appears
- Click "+ Create Campaign" — wizard opens (existing flow unchanged)
- Click any campaign-row — detail modal opens (existing flow unchanged)

- [ ] **Step 6: Commit**

```bash
git add public/js/app.js
git commit -m "feat(dashboard): keyboard shortcuts (1-7,/, Esc, Cmd+A, Del) + remove obsolete past-manage functions"
```

---

## Task 8: Auto-relaunch + final verification

- [ ] **Step 1: Kill + relaunch dev:app**

```bash
pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "Electron.*ortus" 2>/dev/null
npm run dev:app > /tmp/dev-app.log 2>&1 &
sleep 4
grep -E "Server running|listening" /tmp/dev-app.log | head -1
```

Expected: "Server running at http://localhost:NNNNN".

- [ ] **Step 2: End-to-end verification checklist (operator-led)**

The operator runs through this in dev:app:

- [ ] Open the dashboard. The default tab is Monitoring (if any monitoring campaigns) or Active (if any active) or All.
- [ ] Click each of the 7 tabs. Count badges match the row counts in each panel.
- [ ] Click a row's checkbox. Row tints gold. Bulk strip appears.
- [ ] Switch to a different tab. The bulk strip stays visible with the qualifier "· N IN OTHER TABS".
- [ ] Search filters live within the active tab.
- [ ] Switch tabs — search clears as expected.
- [ ] Select all → click Delete → confirmation dialog lists names → Cancel works → Confirm removes campaigns and toasts.
- [ ] Monitoring tab shows monitoring campaigns. Past tab does NOT show monitoring campaigns.
- [ ] All tab shows every campaign with a status pill.
- [ ] Per-row interactions (open detail, kebab, edit, re-run) all still work.
- [ ] Refresh the page — same tab is restored.

- [ ] **Step 3: Commit (only if final manual fixes needed)**

If any of Step 2 fails, fix the specific issue and commit the fix. Otherwise no commit needed — the previous task commits are the final state.

---

## Self-review checklist (run before declaring plan complete)

**Spec coverage:**
- ✅ 7 tabs with counts → Tasks 2, 4, 6
- ✅ Monitoring promoted → Task 6 (filter past)
- ✅ Bulk delete with confirmation → Task 5
- ✅ Search per tab → Task 4
- ✅ Selection across tabs → Tasks 4, 7
- ✅ Keyboard shortcuts → Task 7
- ✅ localStorage persistence → Task 4 (dashSetTab → setItem)
- ✅ "PAUSE WATCH" appears only on monitoring selection → Task 4 (`dashRenderBulkStrip`)
- ✅ All tab with status pill → Task 6 (`renderDashboardAll`)
- ✅ Existing render functions preserved (2 attrs added) → Task 6
- ✅ Off-limits files untouched → not modified

**Placeholder scan:** No "TBD", no "add appropriate", no "similar to Task N". Every code block is complete.

**Type consistency:** Function names (`dashSetTab`, `dashRenderSelection`, `dashGetIdsByTab`, etc.) used consistently across tasks. State Set (`_dashSelection`) referenced consistently.
