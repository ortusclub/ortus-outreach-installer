# Parallel Campaigns — Implementation Plan

> **For agentic workers:** Execute task-by-task with auto-relaunch of `npm run dev:app` after each commit per CLAUDE.md operator rule #2. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Multiple campaigns run in parallel, each with isolated state, log, live status, and action controls. UI scopes everything to the campaign currently being viewed. Account exclusivity enforced at start time. Replaces the singleton-campaign model in `src/campaign.js`.

**Architecture:** Singleton `campaign` object becomes a `CampaignRegistry` (Map keyed by id). State + logs move from global files to `data/campaigns/<id>/`. API routes gain `:id` segment. Wizard view scopes to `currentCampaignId` localStorage. Runbar deleted; 6 actions move into per-campaign Live Status action row. New `account-lock.js` enforces "no shared running accounts" at start.

**Tech Stack:** Node ≥22, vanilla JS/HTML/CSS, `node --test`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-25-parallel-campaigns-design.md`

**Resolved decisions (from spec §7):**
- Monitoring does NOT lock accounts; only active sending does.
- No hard cap on parallel campaigns — hardware-limited.
- Delete is a single "Are you sure?" confirm that also closes any open wizard for that campaign.
- Saved Configs / Presets stay global.

---

## Phase 1 — Registry skeleton (no behavior change)

### Task 1.1: Create `src/campaign-registry.js`

**Files:**
- Create: `src/campaign-registry.js`
- Create: `tests/campaign-registry.test.js`

- [ ] **Step 1: Write failing tests**

  ```js
  import { test } from 'node:test';
  import assert from 'node:assert/strict';
  import { CampaignRegistry } from '../src/campaign-registry.js';

  test('register adds an entry', () => {
    const r = new CampaignRegistry();
    const c = r.register({ id: 'a', name: 'A' });
    assert.equal(r.get('a'), c);
    assert.equal(r.list().length, 1);
  });

  test('list filters by status', () => {
    const r = new CampaignRegistry();
    r.register({ id: 'a', status: 'running' });
    r.register({ id: 'b', status: 'idle' });
    assert.equal(r.list({ status: 'running' }).length, 1);
  });

  test('remove deletes by id', () => {
    const r = new CampaignRegistry();
    r.register({ id: 'a' });
    r.remove('a');
    assert.equal(r.get('a'), undefined);
  });

  test('runningIds returns set of ids with status=running', () => {
    const r = new CampaignRegistry();
    r.register({ id: 'a', status: 'running' });
    r.register({ id: 'b', status: 'paused' });
    r.register({ id: 'c', status: 'running' });
    const ids = r.runningIds();
    assert.ok(ids.has('a') && ids.has('c') && !ids.has('b'));
  });
  ```

- [ ] **Step 2: Implement registry**

  Module exports a class with: `register(entry)`, `get(id)`, `list({ status? })`, `remove(id)`, `runningIds()`. Entry shape is loose — registry just stores; CampaignRuntime is a separate concept built on top later.

- [ ] **Step 3: Run tests**

  ```bash
  cd ~/ortus-outreach-installer-2 && node --test tests/campaign-registry.test.js
  ```

- [ ] **Step 4: Commit**

  Message: `feat(registry): CampaignRegistry skeleton + tests`. No auto-relaunch (no runtime code touched yet).

### Task 1.2: Wrap singleton `campaign` object with registry

**Files:**
- Edit: `src/campaign.js`
- Edit: `tests/*.test.js` (only those that import the singleton)

- [ ] **Step 1**: At top of `src/campaign.js`, import `CampaignRegistry`, instantiate a module-level registry. Keep the existing exported `campaign` object as a shim that always returns `registry.get(SINGLETON_ID)` where `SINGLETON_ID = 'legacy-singleton'`.

- [ ] **Step 2**: `startCampaign()` now `registry.register({ id: SINGLETON_ID, ... })` instead of mutating module-level state. State reads/writes go through the registry entry.

- [ ] **Step 3**: Run `node --test tests/` — all existing tests should still pass without modification (the shim preserves the old API).

- [ ] **Step 4**: Commit + auto-relaunch dev:app. Manual verify: start a campaign, watch it run, verify status/logs identical to before.

  ```bash
  pkill -f "Electron.*ortus-outreach-installer-2" 2>/dev/null
  cd ~/ortus-outreach-installer-2 && nohup npm run dev:app > /tmp/dev-app.log 2>&1 & disown
  ```

---

## Phase 2 — Per-campaign storage layout

### Task 2.1: Storage path helpers

**Files:**
- Edit: `src/paths.js`
- Create: `tests/paths.test.js` (if not exists)

- [ ] Add `campaignDir(id)`, `campaignStatePath(id)`, `campaignLogPath(id)`, `campaignDraftPath(id)`. Each resolves to `data/campaigns/<id>/...` and `mkdirSync` the directory on first call (same pattern as `ROOT` in current `paths.js`).
- [ ] Tests assert paths are within `ROOT` and the directory exists after first call.
- [ ] Commit.

### Task 2.2: Per-campaign state.json read/write

**Files:**
- Edit: `src/campaign.js` (state save/load helpers)
- Edit: `src/campaign-registry.js` (add `loadFromDisk()`, `persistEntry(id)`)

- [ ] Save: writes `data/campaigns/<id>/state.json` atomically (`<file>.tmp` + rename per CLAUDE.md convention).
- [ ] Load: on startup, scan `data/campaigns/*/state.json` and rehydrate registry entries.
- [ ] Legacy `data/state.json`: read it once on first boot; if present, migrate contents to `data/campaigns/legacy-singleton/state.json`, then rename old file to `data/state.json.migrated-<ts>`.
- [ ] Commit + auto-relaunch. Verify: kill app mid-campaign, relaunch, state restored from new path.

### Task 2.3: Per-campaign log file (NDJSON)

**Files:**
- Edit: `src/campaign.js` (log writer)

- [ ] Replace global `data/campaign.log` writes with per-campaign `data/campaigns/<id>/log.ndjson`. Each line is `{ ts, level, msg }`.
- [ ] Existing `CAMPAIGN_LOG_ROTATED` rotation logic copies to `.1` per-campaign.
- [ ] Add `readRecentLogs(id, { since, limit })` helper for the new API.
- [ ] Migration: copy `data/campaign.log` to `data/campaigns/legacy-singleton/log.ndjson` (parsing existing format into the NDJSON shape).
- [ ] Commit + auto-relaunch. Verify: log appears in `data/campaigns/<id>/log.ndjson` during a run; existing log panel still populated via legacy endpoint.

---

## Phase 3 — API routes accept :id

### Task 3.1: New scoped routes alongside legacy

**Files:**
- Edit: `server.js`

- [ ] Add these routes — each reads/writes via the registry by id:

  ```
  POST   /api/campaign                      → create draft, returns { id }
  GET    /api/campaigns                     → list (full registry, brief shape for dashboard)
  GET    /api/campaign/:id                  → full state + recent logs (replaces /api/campaign/status)
  POST   /api/campaign/:id/start
  POST   /api/campaign/:id/pause
  POST   /api/campaign/:id/resume
  POST   /api/campaign/:id/stop
  POST   /api/campaign/:id/force-restart
  GET    /api/campaign/:id/logs?since=<ts>
  DELETE /api/campaign/:id
  ```

- [ ] Each route validates `:id` exists in registry → 404 otherwise.
- [ ] Reuse existing handlers internally — the per-id wrappers just inject the resolved registry entry.

### Task 3.2: Legacy global routes become deprecation shims

**Files:**
- Edit: `server.js`

- [ ] Existing `/api/campaign/status`, `/api/campaign/start`, etc., now:
  1. Resolve "most-recently-started campaign id" (or `legacy-singleton` if none).
  2. Forward to the new scoped handler.
  3. Add `Deprecation: true` and `Sunset: <date+30d>` headers.

- [ ] Add structured warning to server log on every legacy route hit (sampled, not per-request, to avoid spam).
- [ ] Commit + auto-relaunch. Verify: existing UI still works unchanged; curl new routes return identical data.

### Task 3.3: Draft persistence endpoints

**Files:**
- Edit: `server.js`

- [ ] Add:
  ```
  GET  /api/campaign/:id/draft
  PUT  /api/campaign/:id/draft   { name, mode, profileIds, templates, dailyLimit, ... }
  ```
- [ ] Body validated against a minimal schema (reject unknown keys).
- [ ] Atomic write to `data/campaigns/<id>/draft.json`.
- [ ] Existing `/api/drafts/:id` endpoints become shims to these (back-compat for the current Save Name button).
- [ ] Commit (no relaunch needed yet — no client code uses the new routes).

---

## Phase 4 — Client passes campaignId

### Task 4.1: localStorage `currentCampaignId`

**Files:**
- Edit: `public/js/app.js`

- [ ] Rename `currentDraftId` → `currentCampaignId` throughout. Drafts and running campaigns now share an id.
- [ ] `startNewCampaign()` POSTs `/api/campaign` (gets new id), stores in `currentCampaignId`.
- [ ] `editDraft(id)` → `editCampaign(id)`, sets `currentCampaignId`.
- [ ] Helper `getCurrentCampaignId()` reads from localStorage with fallback `null`.
- [ ] Commit + auto-relaunch. Verify: navigating to wizard shows the same data as before.

### Task 4.2: pollStatus and action calls switch to scoped routes

**Files:**
- Edit: `public/js/app.js`

- [ ] `pollStatus()` reads `currentCampaignId`; if null (dashboard view), polls `/api/campaigns` list instead.
- [ ] Start / Pause / Stop / Force-restart buttons all call `/api/campaign/:id/...`.
- [ ] Log polling switches to `/api/campaign/:id/logs?since=<lastTs>` — incremental.
- [ ] Legacy `/api/campaign/status` is no longer called; the deprecation log on the server should fall silent after this commit.
- [ ] Commit + auto-relaunch. Verify: live status updates in the wizard, dashboard shows the campaign list.

### Task 4.3: Dashboard renders from `/api/campaigns`

**Files:**
- Edit: `public/js/app.js`
- Edit: `public/index.html` (minor — per-row status pills)

- [ ] Dashboard list polls `/api/campaigns` every 2s.
- [ ] Each row shows: name, mode, status pill (`Draft`, `Running 16/210`, `Paused`, `Monitoring`, `Past N processed`), Edit / Delete / View buttons.
- [ ] Commit + auto-relaunch. Verify: two drafts in the list, edit each, fields independent.

---

## Phase 5 — Parallel runtime + account exclusivity

### Task 5.1: Account-lock helper + tests

**Files:**
- Create: `src/account-lock.js`
- Create: `tests/account-lock.test.js`

- [ ] Tests cover:
  - No conflict when account sets disjoint.
  - Conflict when one account overlaps with a `running` campaign.
  - No conflict when overlap is only with `monitoring` campaign (per Q1 resolution).
  - No conflict with `paused` campaign? **Decision needed at commit time** — likely YES (paused holds the account, can be unpaused at any time).
- [ ] Implement `checkAccountLock({ registry, campaignId, profileIds })` returns `{ ok: true }` or `{ ok: false, conflicts: [{ profileId, campaignId, campaignName }] }`.
- [ ] Commit.

### Task 5.2: Enforce account lock at start

**Files:**
- Edit: `server.js` (or the start handler)

- [ ] On `POST /api/campaign/:id/start`, run `checkAccountLock`. If conflict → return 409 with `{ error: 'account_conflict', conflicts: [...] }`.
- [ ] Add server unit test: start two campaigns with overlapping accounts, expect 409 on second.
- [ ] Commit + auto-relaunch. Verify: cannot start two campaigns sharing an account.

### Task 5.3: Conflict modal in UI

**Files:**
- Edit: `public/js/app.js`
- Edit: `public/index.html` (modal markup)
- Edit: `public/css/style.css`

- [ ] When start returns 409, render modal listing each conflict: `"barry.marilao@... — already running in HELLO_MOTTO. [Stop HELLO_MOTTO]"`.
- [ ] "Stop" button calls `/api/campaign/<other-id>/stop`, then retries the original start.
- [ ] Commit + auto-relaunch. Verify modal triggers + Stop shortcut works.

### Task 5.4: Two campaigns running simultaneously — first live test

**Files:** None (test-only)

- [ ] Manual test: configure campaign A with accounts 1-3, campaign B with accounts 4-6. Start A. Start B. Both run. Check:
  - Each cockpit reflects its own campaign (UI is still global at this point — known limitation, fixed in Phase 6).
  - Each `data/campaigns/<id>/log.ndjson` only contains its own lines.
  - Stop A → B keeps running.
- [ ] No code change; gate to Phase 6.

---

## Phase 6 — UI scoping + runbar deletion

### Task 6.1: Replace `isOnNewCampaignView()` with `isViewedCampaignRunning()`

**Files:**
- Edit: `public/js/app.js`

- [ ] New helper checks `currentCampaignId` against the set of running ids (from `/api/campaigns` cache). Returns true if the viewed campaign IS the one whose data should populate the live panels.
- [ ] All existing gates in `renderCockpit()`, `initRunBarMirror.sync()`, `syncActivityFeed()`, log-panel painter switch from `isOnNewCampaignView` to `!isViewedCampaignRunning()`.
- [ ] Remove the `currentDraftIsNew` localStorage flag (no longer needed — running state is the source of truth).
- [ ] Commit + auto-relaunch. Verify: viewing inactive draft tab while another campaign runs → blank state; viewing the running campaign → live state.

### Task 6.2: Delete bottom runbar markup + styles

**Files:**
- Edit: `public/index.html` (remove `<div id="run-bar-status">` + siblings)
- Edit: `public/css/style.css` (remove `.run-bar-*` rules)
- Edit: `public/js/app.js` (remove `initRunBarMirror`; references)

- [ ] Verify nothing else references the deleted IDs (`run-bar-status`, `run-bar-text`, `run-bar-name`).
- [ ] Sticky-toolbar layout adjusts (status indicators move into per-campaign row).
- [ ] Commit + auto-relaunch.

### Task 6.3: Move 6 actions into Live Status section

**Files:**
- Edit: `public/index.html` (action row at bottom of `#nav-status` body)
- Edit: `public/css/style.css`
- Edit: `public/js/app.js` (handlers already exist — just rebind onclick)

- [ ] Action row markup:

  ```html
  <div class="status-actions">
    <div class="status-actions-status"><span class="status-dot"></span> <span id="status-action-label">Idle</span></div>
    <div class="status-actions-group">
      <span class="status-actions-label">RUN</span>
      <button id="btn-start" onclick="startCampaign()">START</button>
      <button id="btn-pause" onclick="pauseCampaign()">PAUSE</button>
      <button id="btn-stop" onclick="stopCampaign()">STOP</button>
    </div>
    <div class="status-actions-group">
      <span class="status-actions-label">VIEW</span>
      <button onclick="openStatus()">STATUS</button>
    </div>
    <div class="status-actions-group">
      <span class="status-actions-label">RECOVERY</span>
      <button onclick="forceRestart()">FORCE RESTART</button>
    </div>
    <div class="status-actions-group">
      <button id="saved-configs-trigger" onclick="togglePresetPopover()">SAVED CONFIGS <span id="preset-pill-count">0</span></button>
    </div>
  </div>
  ```

- [ ] Visibility logic per spec §4.7:
  - Draft → only `START` + `SAVED CONFIGS` visible.
  - Running → all 6 visible (`START` disabled, others active).
  - Paused → `RESUME` (re-labelled START) + `STOP` visible.
- [ ] Commit + auto-relaunch. Verify: all 6 work as before, but per-campaign.

### Task 6.4: Per-campaign log polling in UI

**Files:**
- Edit: `public/js/app.js`

- [ ] Log panel reads from `/api/campaign/:id/logs?since=<lastLogTs>` keyed by `currentCampaignId`.
- [ ] On tab switch (campaign change), clear `lastLogTs` so fresh log loads from scratch.
- [ ] Verify: tabs A and B show different logs; switching is instant; no global log leaks in.

---

## Phase 7 — Save Edits + draft persistence + delete confirm

### Task 7.1: Wire Save Edits to per-campaign draft store

**Files:**
- Edit: `public/js/app.js`

- [ ] Replace `saveCampaignEdits()` stub (added 2026-05-25) with real handler: collect wizard form state (name, mode, profileIds, templates, dailyLimit, sheet URL, etc.), `PUT /api/campaign/:id/draft`.
- [ ] On success: clear dirty flag, show toast "Edits saved".
- [ ] On failure: keep dirty flag, toast error.
- [ ] Verify: edit, save, reload tab — fields persist.

### Task 7.2: Dirty-flag tracking on wizard fields

**Files:**
- Edit: `public/js/app.js`

- [ ] Add `wizardDirty` flag, set to true on any input/change in the wizard, cleared on Save and on tab entry (load).
- [ ] Disable Save Edits button when not dirty.
- [ ] Commit + auto-relaunch.

### Task 7.3: Unsaved-changes guard on tab switch

**Files:**
- Edit: `public/js/app.js`
- Edit: `public/index.html` (modal markup)
- Edit: `public/css/style.css`

- [ ] When operator navigates away from a wizard with `wizardDirty === true`, intercept and show modal:
  ```
  You have unsaved changes to <name>.
  [Save and continue]  [Discard]  [Cancel]
  ```
- [ ] Enter defaults to Save and continue.
- [ ] Cancel returns to the wizard with edits intact.
- [ ] Commit + auto-relaunch.

### Task 7.4: Delete confirmation popup (also closes wizard if open)

**Files:**
- Edit: `public/js/app.js`
- Edit: `public/index.html` (modal markup; reuse confirm-modal scaffold)

- [ ] Dashboard Delete button shows confirm:
  ```
  Delete "<name>"? This cannot be undone.
  [Delete]  [Cancel]
  ```
- [ ] On confirm: `DELETE /api/campaign/:id`. If `currentCampaignId === id`, close wizard back to dashboard.
- [ ] Commit + auto-relaunch.

### Task 7.5: End-to-end verification of all 8 user stories

**Files:** None.

- [ ] Walk through S1–S8 from spec §3. Document any deviations as follow-up tasks.
- [ ] Update spec's §8 (Acceptance) with a "✅ verified 2026-XX-XX" marker.
- [ ] Final commit summarizing phase: `feat(parallel-campaigns): operator verification complete`.

---

## Out-of-scope follow-ups (capture as gsd:add-backlog)

- Per-campaign notifications routing (R2 in spec §6).
- Schedule system per-campaign attachment (R3).
- Per-campaign post-amplification + check-DMs overlays (R4).
- Concurrent history append mutex (Q5 in spec).
- Web Worker / SSE for log streaming (drops the 2s poll latency).
- Per-account browser serialization (if operators ever want to share accounts across parallel campaigns).
