# Dashboard Tabbed Layout Design

**Date:** 2026-05-18
**Author:** Antonio + Claude (Opus 4.7)
**Status:** Spec — based on the interactive prototype at `public/sketches/dashboard-B-interactive.html`. Pending user review → plan → execution.

## Problem

The current dashboard (`public/index.html:160-225`) stacks five sections vertically — Active, Queued, Schedules, Drafts, Past. Two concrete pain points the operator reported on 2026-05-18:

1. **Monitoring campaigns** (campaigns in the post-acceptance 7-day watch window) are buried inside the **Past** section even though they are still actively running. Result: it's not obvious which campaigns are still working in the background, and "Past" feels untrustworthy.
2. **Bulk delete** exists only on the Past section, and is hidden behind a small trash-icon toggle (`past-manage-toggle`) that the operator didn't know about. Deleting many old campaigns means clicking each one individually.

Additionally the dashboard "feels messy" — five vertical sections all visible at once produces a lot of vertical scroll, and the operator has to scan past three sections to reach the one they care about.

## Goal

Replace the stacked sections with a tabbed layout. Each tab shows ONE category of campaigns with its own toolbar (search, bulk-select, bulk-action strip). Monitoring becomes a peer-level tab. Bulk delete is always one click away (no hidden toggle). Existing campaign data, sheet integration, and per-row behavior are preserved unchanged.

## Non-goals

- **Do NOT change** the underlying data model, localStorage keys, or any Google Sheet column. The new dashboard is a purely visual restructure on top of the same data.
- **Do NOT touch** `src/linkedin/outreach.js`, `src/linkedin/actions.js`, `src/campaign.js`, or any backend code. This is frontend-only.
- **Do NOT redesign** the campaign-detail modal, the wizard, the cockpit, or any other view. Dashboard route only.
- **Do NOT add** new campaign states or status meanings. The seven tabs are a re-projection of existing states, not new states.

## Architecture

A single dashboard view (`#dashboard-view`) with a horizontal tab bar at the top. Below the tabs sits a toolbar (search + select-all + filters). Below that, a list panel that swaps in/out based on the active tab. Selection state is **shared across tabs** so a user can select 2 in Monitoring, switch to Past, select 3 more, and bulk-delete all 5.

### The seven tabs

| Tab | Source | Includes |
|---|---|---|
| **Active** | `renderActiveCampaignsList` data | Currently-running campaign(s) — `campaign.running === true` |
| **Monitoring** | A new filter applied to past-campaigns history | Campaigns whose `state === 'monitoring'` (CC+IC campaigns in the 7-day acceptance window). **Currently appear inside Past — this tab promotes them out.** |
| **Queued** | `renderQueuedCampaignsList` data | Campaigns waiting for a free slot |
| **Schedules** | `renderSchedulesList` data | Future-scheduled campaigns (cron) |
| **Drafts** | `renderDraftsList` data | Saved but not yet launched |
| **Past** | `renderPastCampaigns` data minus monitoring | Completed + stopped + failed campaigns. Monitoring campaigns are excluded since they have their own tab. |
| **All** | Union of all six above | Mixed list with a status pill column added so the operator can see what kind each row is. |

### The toolbar

Below the tab bar, fixed in position regardless of which tab is active:

- **Select all** checkbox on the left. Toggles selection of every row currently visible in the active tab (respects search filter — does not select rows hidden by search).
- **Search input** on the right. Filters the active tab's list by name, mode, sub-text, or date. Clearing the search restores the full list; selection persists.
- **Per-tab affordances** (e.g., "Filter by mode" dropdown in Past) MAY appear here in future iterations but are not part of v1.

### The bulk-action strip

When ≥1 row is selected (anywhere — including in tabs other than the active one), a strip appears between the toolbar and the list:

- Left: gold count badge (`2 SELECTED`) + qualifier when selection spans multiple tabs (`· 1 IN OTHER TABS`).
- Right: action buttons. Always: `CLEAR`, `DELETE` (red). Tab-context-aware: `PAUSE WATCH` appears only when at least one Monitoring row is selected.

Delete prompts a confirmation dialog listing the affected campaign names. The dialog explicitly notes that **Google Sheet rows are not affected** by dashboard deletion — only the dashboard cache/history entry is removed.

### Tab switching behavior

- Clicking a tab swaps the list panel.
- **Search input is cleared on tab switch** (operator-confirmed default). Per-tab search persistence was rejected as too surprising — typing "tokyo" in Past then jumping to Monitoring usually produces an empty list, which feels broken.
- **Selection is preserved across tab switches**. The bulk strip stays visible with the cross-tab qualifier.
- **Tab count badges** show how many rows are in each category — visible at all times so the operator sees totals at a glance.
- The **Monitoring tab** has a small "N new" badge (gold) when there are monitoring campaigns whose latest auto-intro happened since the operator last visited the tab. This is a "new mail" affordance.

### Row anatomy (per tab)

Each row is a `display: grid` with these columns (left to right):

| Column | Width | Content |
|---|---|---|
| Selection checkbox | 28px | Toggles selection of this row |
| Name + sub-text | 1fr | Campaign name (bold) above a smaller line of context (e.g., "27 / 50 SENT · STARTED 41M AGO") |
| Status pill | 130px | Only in **All** tab. Shows the state in a pill (ACTIVE / MONITOR / QUEUED / SCHEDULE / DRAFT / DONE / STOPPED). |
| Mode | 140px | Campaign mode (CC + IC, CONNECT, MESSAGE, INTRO BACK, …) in display-font caps |
| When | 110px | Relative time ("3d ago", "May 16") |
| Metric | 100px | Display-font number + small caption ("27 / SENT", "5 / INTRO", "—") |
| Kebab menu | 32px | Per-row actions: Open detail, Re-run, Edit, Delete |

The **All** tab is the only one with the status pill column. The other six tabs omit it (the column would always show the same value).

### Empty states

Each tab shows a centered empty state when its list is empty:

> **NOTHING HERE**
> New campaigns will appear here.

For the search-filtered empty state (search query non-empty, no matches):

> **NO MATCHES**
> Try a different search term.

### Keyboard shortcuts (nice-to-have, optional in v1)

- `1`–`7` jumps to tab 1–7
- `⌘+A` selects all visible rows in current tab
- `⌫` deletes selected rows (with confirmation)
- `/` focuses the search input
- `Esc` clears selection

**Decision:** include keyboard shortcuts in v1 because they're cheap to add and the operator runs the dashboard daily.

## Implementation strategy — preserve existing rendering logic

The existing render functions stay intact. We add a thin orchestration layer on top:

- `renderActiveCampaignsList()` → unchanged. Output goes into `#tab-panel-active`.
- `renderQueuedCampaignsList()` → unchanged. Output goes into `#tab-panel-queued`.
- `renderSchedulesList()` → unchanged. Output goes into `#tab-panel-schedules`.
- `renderDraftsList()` → unchanged. Output goes into `#tab-panel-drafts`.
- `renderPastCampaigns()` → modified to **filter out** monitoring campaigns. Monitoring campaigns flow into `renderMonitoringList()` (new function).
- `renderMonitoringList()` → **new**. Reads the same source as `renderPastCampaigns` but filters to `state === 'monitoring'`. Renders into `#tab-panel-monitoring`.
- `renderAllList()` → **new**. Merges all sources into one list, prepends a status-pill column, renders into `#tab-panel-all`.

Tab orchestration lives in a new `renderDashboardTabs()` function that:
1. Reads selection state from a module-level `Set<string>` (campaign IDs).
2. Updates tab count badges.
3. Updates the bulk strip visibility + count + action set.
4. Shows/hides the active tab panel.
5. Re-applies row selection visual state.

**Constraint:** The existing per-row interactions (click to open detail, kebab menu, re-run button) MUST work identically in the new tabs. The select checkbox is **added** to the row but does NOT replace any existing affordance.

### HTML structure (replaces lines 160-225 of `public/index.html`)

```html
<div id="dashboard-view" class="route-view">
  <!-- Tab bar -->
  <div class="dash-tabs" id="dash-tabs">
    <button class="dash-tab on" data-tab="active">Active <span class="dash-tab-ct" data-ct="active">0</span></button>
    <button class="dash-tab" data-tab="monitoring">Monitoring <span class="dash-tab-ct" data-ct="monitoring">0</span> <span class="dash-tab-new" data-new="monitoring" hidden>0 new</span></button>
    <button class="dash-tab" data-tab="queued">Queued <span class="dash-tab-ct" data-ct="queued">0</span></button>
    <button class="dash-tab" data-tab="schedules">Schedules <span class="dash-tab-ct" data-ct="schedules">0</span></button>
    <button class="dash-tab" data-tab="drafts">Drafts <span class="dash-tab-ct" data-ct="drafts">0</span></button>
    <button class="dash-tab" data-tab="past">Past <span class="dash-tab-ct" data-ct="past">0</span></button>
    <button class="dash-tab" data-tab="all">All <span class="dash-tab-ct" data-ct="all">0</span></button>
  </div>

  <!-- Toolbar -->
  <div class="dash-toolbar">
    <span class="dash-selall" id="dash-selall"><span class="dash-check" id="dash-selall-check"></span> SELECT ALL</span>
    <input class="dash-search" id="dash-search" type="text" placeholder="Search this list…" />
  </div>

  <!-- Bulk action strip (hidden by default) -->
  <div class="dash-bulkstrip" id="dash-bulkstrip" hidden>
    <div><span class="dash-bulk-n" id="dash-bulk-n">0</span>SELECTED <span class="dash-bulk-qual" id="dash-bulk-qual"></span></div>
    <div class="dash-bulkstrip-r">
      <button class="btn" onclick="dashClearSelection()">CLEAR</button>
      <button class="btn" id="dash-bulk-pause" onclick="dashBulkPauseWatch()" hidden>PAUSE WATCH</button>
      <button class="btn btn-stop" onclick="dashBulkDelete()">DELETE</button>
    </div>
  </div>

  <!-- Tab panels — only one visible at a time -->
  <div class="dash-panels">
    <div class="dash-panel" data-panel="active" id="dash-panel-active"></div>
    <div class="dash-panel" data-panel="monitoring" id="dash-panel-monitoring" hidden></div>
    <div class="dash-panel" data-panel="queued" id="dash-panel-queued" hidden></div>
    <div class="dash-panel" data-panel="schedules" id="dash-panel-schedules" hidden></div>
    <div class="dash-panel" data-panel="drafts" id="dash-panel-drafts" hidden></div>
    <div class="dash-panel" data-panel="past" id="dash-panel-past" hidden></div>
    <div class="dash-panel" data-panel="all" id="dash-panel-all" hidden></div>
  </div>

  <div class="dashboard-actions">
    <button type="button" class="btn btn-primary create-campaign-btn" onclick="goCreateCampaign()">+ Create Campaign</button>
  </div>
</div>
```

### Routing and persistence

- The active tab is persisted to `localStorage.ortus.dashboard.activeTab` — refreshing the page returns to the same tab.
- On load, default tab is **Monitoring** if any monitoring campaigns exist, otherwise **Active** if any active campaigns exist, otherwise **All** as last-resort fallback.
- Hash-based deep links (e.g., `#/dashboard/monitoring`) are NOT in v1. Tab state is local-only.

## What gets deleted from the current dashboard

**Removed HTML/CSS classes** (all from `public/index.html:160-225`):
- `.dashboard-section` blocks for Active, Queued, Schedules, Drafts, Past
- `.past-section-header`, `.past-manage-toggle`, `.past-search-row`, `.past-bulk-bar`, `.past-toggle-row` — the bulk-delete affordance is now part of the unified toolbar
- `.dashboard-section-title` for the per-section H2s — replaced by the tab labels

**Removed JS functions** (from `public/js/app.js`, only ones that are now obsolete):
- `togglePastManageMode()` — selection is always on now
- `togglePastExpanded()` — replaced by per-tab search/filtering
- `onPastSearchInput()` — unified into `dashSearchInput()`
- `clearPastSelection()` — replaced by `dashClearSelection()`
- `bulkDeletePastSelected()` — replaced by `dashBulkDelete()`

**Kept functions** (called from inside the new tab renderers):
- `renderActiveCampaignsList`, `renderQueuedCampaignsList`, `renderSchedulesList`, `renderDraftsList`, `renderPastCampaigns` — all still emit row HTML, just into new container IDs.
- The campaign-detail modal, kebab-menu actions, re-run, edit — all untouched.

**Risk mitigation:** the removed functions are ONLY used by the dashboard route. Search confirms no other view (cockpit, wizard, history) references them.

## CSS — new classes only, no existing class modified

All new classes are prefixed with `dash-` to avoid collision with the existing CSS. Tokens reuse the established Bugatti command-deck variables (`--ink`, `--gold`, `--hairline`, `--display`, etc.). Specific styles defined inline in the plan.

## Accessibility

- Tab bar uses `<button>` elements with `aria-selected` set on the active tab. Keyboard arrow-key navigation moves between tabs.
- The bulk strip's count is announced via `aria-live="polite"` so screen readers hear "2 selected" without focusing the strip.
- The Delete confirmation dialog has focus trap + Escape-to-cancel.

## Test surface

**Manual tests** (no automated UI tests exist for this layer — `node:test` is for pure helpers only):

1. **Tab counts update correctly** when campaigns are created, started, stopped, or deleted in another tab/cockpit.
2. **Monitoring tab actually shows monitoring campaigns**, not Past. Verify by starting a CC+IC campaign and checking the tab post-launch.
3. **Cross-tab selection persists** when switching tabs.
4. **Bulk delete confirmation** lists the affected names and cancels cleanly.
5. **Search filters live** without dropping selection.
6. **Default tab on fresh load** picks the right tab based on which lists are populated.
7. **Existing campaign data appears unchanged** in its proper tab (no data loss / no schema drift).
8. **Per-row interactions still work** (open detail, re-run, edit, per-row delete).

**Automated tests** for pure helpers:
- A new `tests/dash-tab-state.test.js` covering the tab-routing helper (`pickDefaultTab(state)`), selection helpers (`addToSelection`, `removeFromSelection`, `clearSelection`), and the cross-tab qualifier computation (`computeCrossTabQualifier(selection, activeTab, allCampaigns)`).

## Risk register

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | Existing render functions emit HTML with the old container IDs hard-coded | Medium | Read each `renderXxx` function and refactor minimally — change the container ID parameter only. Do not rewrite logic. |
| 2 | `renderPastCampaigns` currently shows monitoring inline — splitting may break observed counts | Medium | The split is via a filter on `state === 'monitoring'`. Existing data passes through; only the visual destination changes. |
| 3 | Cross-tab selection edge cases (e.g., select a row, switch tabs, that row gets deleted from another source) | Low | The selection Set holds campaign IDs. If an ID disappears from all sources, the selection silently drops it on next render. |
| 4 | Removing `togglePastManageMode` etc. breaks code I didn't find | Low | Pre-flight grep before deletion. Plan includes a "verify no references exist" step before removing each function. |
| 5 | Schedules tab is empty for most operators today | Low (not a risk, just a fact) | Empty state copy is friendly. If the operator never uses schedules, the tab is just slightly noisy — acceptable. |
| 6 | Keyboard shortcuts conflict with other app shortcuts | Low | Shortcuts only fire when focus is on the dashboard view (`document.querySelector('#dashboard-view').contains(document.activeElement)`). |

## Open questions — none

All originally open questions resolved in conversation:
- ✅ Search clears on tab switch
- ✅ Select-all picks visible-only
- ✅ Schedules → its own 6th tab (option A)
- ✅ Existing data preserved (no wipe)
- ✅ "All" tab added (7th)

## Acceptance criteria

1. Dashboard route (`#/`) renders 7 tabs with correct counts at first paint.
2. Monitoring campaigns appear in the **Monitoring** tab, not Past. Past contains only completed/stopped/failed.
3. Clicking a tab swaps the list panel and clears the search.
4. Checkbox on any row toggles selection; row tint goes gold.
5. The bulk strip appears when ≥1 row is selected and shows the count.
6. The cross-tab qualifier appears when selection spans tabs other than active.
7. `PAUSE WATCH` appears in the bulk strip only when ≥1 Monitoring row is selected.
8. `DELETE` opens a confirmation listing campaign names; Cancel closes cleanly; Confirm removes from the dashboard and refreshes counts.
9. Search filters the active tab's list live; clearing search restores full list; selection survives.
10. Existing campaign-detail modal, re-run, edit, per-row delete all still work identically.
11. Tab choice persists across page refresh (localStorage).
12. Existing tests still pass (322 + 2 skipped). New tests for pure helpers pass.
13. Off-limits files (`src/linkedin/outreach.js`, `src/linkedin/actions.js`) have zero diff.

## Sign-off

This spec is grounded in:
- The interactive prototype at `public/sketches/dashboard-B-interactive.html` (the user confirmed "ok i like it")
- The actual current dashboard at `public/index.html:160-225`
- The existing render functions in `public/js/app.js`
- Operator decisions captured in the 2026-05-18 conversation
