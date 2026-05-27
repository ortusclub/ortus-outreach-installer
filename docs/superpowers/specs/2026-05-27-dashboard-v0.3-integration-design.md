# Dashboard v0.3 Unified — Integration Design

**Date:** 2026-05-27
**Author:** Antonio + Claude
**Status:** Draft — awaiting review

## Goal (verifiable)

Open the Electron app → land on the `#/` (dashboard) route → see the v0.3 unified-vocabulary layout populated with real campaign data → every interactive element fires the correct backend endpoint or local state change → no regression in wizard, right-pane, modals, polling, monitoring lifecycle, or any other untouched surface.

The dashboard becomes the **single visual surface for daily operator work**: one running campaign card (the hero), one monitoring slot (mini by default, expandable), the queue (drag-reorderable), this week's calendar, and past campaigns (collapsed summary by default).

## Background

Antonio iterated on dashboard sketches under `public/sketches/` over the past two days. The most recent (`dashboard-v0.3-unified.html`) is a free-standing prototype that solves a visual-coherence problem in the live app: the current dashboard has four competing visual languages (J cards with dot pattern + accent rail, outlined deck for queue, calendar grid, hairline list for past) that each look good individually but read as cluttered together. v0.3 quiets the chorus by unifying every section under one card primitive (hairline border, 4px radius, transparent background) with the **Now Active** card as the single hero (filled background + green accent rail). It also adds new affordances:
- Monitoring as a collapsible mini-J card (toggle expands to full)
- Inline details panel on Active + Monitoring (live log + bulk-check button)
- Drag-to-reorder queue
- Calendar grid between Up Next and Past

The current live app (`public/index.html` + `public/js/app.js`) is a 7-tab dashboard (Active / Monitoring / Queued / Schedules / Drafts / Past / All) with ~125 inline `onclick` handlers and a 9 887-line `app.js`. It works, but the visual fragmentation is real and the tab pattern doesn't fit how operators actually use the app (1 campaign at a time per the hard constraint).

## Scope (what's in)

1. **Replace `#dashboard-view` contents** in `public/index.html` with v0.3's single-scroll layout (Active → Monitoring → Up Next → Calendar → Past).
2. **Wire every interactive element** to the correct backend endpoint or local state change.
3. **Add 4 new backend endpoints**:
   - `PATCH /api/queue/:id` — edit queued campaign config (name + selected fields)
   - `POST /api/history/:idx/relaunch` — restart a finished campaign as a new queue entry
   - `PATCH /api/history/:idx/archive` — soft-archive a past entry
   - `GET /api/history/:idx/log` — return campaign.log lines filtered by campaign name
4. **Derive the calendar client-side** from `/api/schedules` (existing cron entries) + the running campaign's `nextCheckAt` + the monitoring window.
5. **Wire drag-reorder** via the existing `POST /api/queue/reorder` endpoint.
6. **Wire inline bulk-check / force-sweep** via existing `/api/bulk-check-now` and `/api/monitoring/check-now`.
7. **Extract v0.3 styles** into a new `public/css/dashboard-v0.3.css` scoped under a body class so existing styles are unaffected.

## Scope (what's out — explicit guard)

- **Wizard layout** — the existing wizard (12+ sections) is untouched. v0.3's wizard markup was a 6-section stub for sketch purposes only.
- **Right-pane** — keep current behavior (Status, Parked, Warnings, Passover, Selected, Next schedule, Live activity).
- **Sidebar** — visual stays current; theme toggle, notifications panel, sign-out unchanged.
- **Modals** — confirm-stop, restore, ic-preflight, post-launch-tips, etc. keep current look.
- **Polling cadence** — stays 2 s on `/api/campaign/status`. No new polls added.
- **Off-limits files** — `src/linkedin/outreach.js` and `src/linkedin/actions.js` per CLAUDE.md.
- **Drafts / Schedules dashboard surface** — hidden per "strict v0.3 layout" decision. Backend untouched; wizard still uses both.
- **Design tokens** — v0.3 uses what's already in `:root`. No new tokens introduced.
- **Data model migrations** — `history.json` gains an optional `archived: true` field; no other shape changes.

## Surfaced assumptions

| # | Assumption | Confirmed by |
|---|---|---|
| 1 | `#dashboard-view` ID is preserved (only its contents swap); the hash router keeps working. | `applyRoute()` in `app.js:6889` toggles `route-dashboard` body class on `#/`. |
| 2 | `pollStatus()` (2 s) is the heartbeat; its payload already carries logs, errors, parked, monitoring state, throttle, resources. | Research output 3, server.js `/api/campaign/status`. |
| 3 | Existing `window.*` functions in `app.js` (pauseCampaign, stopCampaign, startQueueItem, etc.) are reused where they exist. | Research output 3, ~620 functions exported. |
| 4 | Calendar week is computed client-side from `/api/schedules` + running campaign. No backend changes. | User decision. |
| 5 | Inline `onclick=` style is preserved in v0.3 markup (matches existing convention). | User decision. Karpathy rule: match existing style. |
| 6 | Drafts and Schedules tabs disappear from the dashboard. Backend untouched. Wizard sections that reference them keep working. | User decision: strict v0.3 layout. |
| 7 | v0.3's mock data arrays (`MODES`, `ACCOUNTS`, `queue`, `past`, `week`) are removed from the dashboard's markup. Wizard uses the live app's existing data sources. | v0.3 is the dashboard, not the wizard. |
| 8 | 6 polling timers in app.js stay; only their **DOM target writes** change to v0.3 IDs. | Research output 3, list of intervals. |
| 9 | Monitoring lifecycle (`campaign.state = 'monitoring'`, 7-day window, sweep cadence) stays exactly as-is. Dashboard just renders it differently. | Research output 2, `monitoring-persistence.js`. |
| 10 | v0.3 calendar shows max 3 chips per day (current sketch). Overflow shows `+N more` and opens a day-detail popover. | New affordance, lightweight. |

## Architecture

### File-level diff

| File | Change |
|---|---|
| `public/index.html` | Replace `#dashboard-view` contents (~95 lines) with v0.3 markup (~250 lines). Add one `<link>` to dashboard-v0.3.css. No other regions touched. |
| `public/css/dashboard-v0.3.css` | **NEW** — all v0.3 CSS scoped under `body.theme-light, body.theme-dark` + section selectors. ~700 lines. |
| `public/css/style.css` | Untouched in normal flow. May delete the 7-tab CSS (`.dash-*`) in a separate cleanup commit. |
| `public/js/app.js` | Add 5 new renderers + ~12 new handler functions (~700 lines added). Refactor `pollStatus()` payload-consumption to write into v0.3 DOM (~200 lines changed). Delete the 7 `refreshDashboard*` per-tab renderers (~400 lines removed). |
| `server.js` | Add 3 routes (PATCH /api/queue/:id, POST /api/history/:idx/relaunch, PATCH /api/history/:idx/archive). ~80 lines added. |
| `src/campaign-queue.js` | Add `updateQueueEntry(id, patch)` helper. ~20 lines. |
| `src/history.js` (or wherever appendHistory lives) | Add `archiveHistory(idx)` + `getHistory({includeArchived: false})` filtering. ~30 lines. |
| `tests/*.test.js` | Add unit tests for the 3 new helpers (`node --test` per CLAUDE.md). ~150 lines. |

**Untouched files (explicit list):** `src/campaign.js`, `src/linkedin/*`, `src/monitoring-persistence.js`, `src/sheets*.js`, `src/auth.js`, `src/notifier.js`, all `public/sketches/*`, `electron/*`, modal HTML regions.

### Phase boundaries (parallel-safe)

| Phase | Files | Parallel-safe with | Risk |
|---|---|---|---|
| **1. Backend** | server.js, campaign-queue.js, history.js, tests | Phase 2 | Low — additive routes, no behavior changes |
| **2. CSS extract** | dashboard-v0.3.css (new), index.html (one link line) | Phase 1 | Low — scoped, additive |
| **3. Markup swap** | index.html (#dashboard-view region only) | None (needs Phase 2 CSS) | Medium — DOM IDs change; renderers break until Phase 4 |
| **4. JS renderers** | app.js | None (needs Phase 3) | High — 9 887-line file; biggest surgery |
| **5. Verification** | none | None | Manual gate |

Phases 1 and 2 dispatch as parallel subagents. Phase 3 serializes. Phase 4 splits into 5 sub-phases (Active / Monitoring / Up Next / Calendar / Past) with verification after each.

### Data flow per v0.3 section

| Section | Source | Endpoint | Refresh trigger |
|---|---|---|---|
| Active card | `campaign` payload | `/api/campaign/status` | 2s poll |
| Monitoring mini ↔ full | `campaign.state === 'monitoring'` slice | same payload | 2s poll |
| Active/Monitoring details panel | `campaign.logs[]` (last 6) | same payload | 2s poll, only when `.is-detailed` |
| Up Next showcase + queue items | `/api/queue` | `/api/queue` | 5s poll (existing `_dashboardPollTimer`) |
| Calendar grid | `/api/schedules` + `campaign.nextCheckAt` + running campaign mode/name | `/api/schedules` + status | Once on load, refresh on schedule changes |
| Past collapsed summary | `/api/history` (last entry not archived) | `/api/history` | Once on load + after archive/relaunch actions |
| Past expanded list | `/api/history?includeArchived=false` | same | Same |

### Mapping table (every v0.3 element → backend action)

| v0.3 element | Current handler | Target backend action |
|---|---|---|
| Active "Open" pill | `toast('Open ... (mock)')` | Navigate to wizard with that campaign loaded (or open log modal — TBD: see open question 1) |
| Active "Show details" chevron | `toggleDetails('active-card', this)` | Local toggle (no backend) |
| Active dock: Pause | `togglePauseActive()` mock | `POST /api/campaign/pause` |
| Active dock: Resume (toggled state) | same | `POST /api/campaign/resume` |
| Active dock: Stop | `stopActiveCampaign()` mock | `POST /api/campaign/stop` (confirm modal) |
| Active dock: Restart | `restartActive()` mock | `POST /api/campaign/stop {full:true}` then re-launch via wizard — OR `POST /api/campaign/restore` (panic button) — needs decision |
| Active dock: Copy to queue | `copyLive(...)` mock | `POST /api/campaign/queue-only` with current campaign's config |
| Active details: "Run check now" | `toast(...)` mock | `POST /api/bulk-check-now` with current sheet + profiles |
| Active "batch every 30 min" link | `toast('Open batch settings')` | Open wizard at Settings section with current campaign loaded (or wizard quickedit modal — TBD: see open question 2) |
| Monitoring mini expand chevron | `toggleMonitorMini()` | Local toggle |
| Monitoring full collapse button | same | Local toggle |
| Monitoring "Show details" chevron | `toggleDetails('monitoring-section', this)` | Local toggle |
| Monitoring "Open" pill | toast | Navigate to wizard or log modal (same as Active) |
| Monitoring dock: Pause watch | `togglePauseMonitoring()` mock | Pause monitoring — no current endpoint. Either add `POST /api/monitoring/pause` (new — but not in our 3 added) OR map to `POST /api/campaign/pause`. **Open question 3.** |
| Monitoring dock: Stop watch | `stopMonitoring()` mock | `POST /api/monitoring/stop` |
| Monitoring dock: Force sweep | `forceSweep()` mock | `POST /api/monitoring/check-now` |
| Monitoring dock: Copy to queue | `copyLive(...)` mock | `POST /api/campaign/queue-only` with monitoring campaign's config |
| Monitoring details: "Force sweep now" | toast mock | Same `POST /api/monitoring/check-now` |
| Up Next drag handle | cosmetic | `POST /api/queue/reorder` on drop |
| Up Next dock: Start now | `startQueueItem(q)` mock | `POST /api/queue/run-next` (only valid for head) — for non-head items: `POST /api/queue/:id/move {direction:'up'}` until at head, then run-next. **OR** simpler: confirm modal + reorder to head + run-next. |
| Up Next dock: Reschedule | toast | `PATCH /api/queue/:id {scheduledAt: <ISO>}` — uses our new endpoint |
| Up Next dock: Edit | toast | Open wizard pre-filled with queued config (load via `GET /api/queue/:id` which exists) |
| Up Next dock: Duplicate | local push | `POST /api/campaign/queue-only` with same config |
| Up Next dock: Remove | local splice | `DELETE /api/queue/:id` |
| Calendar prev/next/today | toast | Local navigation — re-render grid for adjacent week |
| Calendar "+ Schedule" rail | toast | Open wizard with Schedule launch toggle active (existing wizard behavior) |
| Calendar day-cell click (non-today) | toast | Same as "+ Schedule" but pre-fill the chosen date |
| Calendar chip click | toast | If running chip → scroll to Active card. If scheduled chip → scroll to that queue item / open wizard edit. |
| Past "Show all" rail | local toggle | `GET /api/history?includeArchived=false` |
| Past dock: Rerun | toast | `POST /api/history/:idx/relaunch` — new endpoint |
| Past dock: Open log | toast | Open log modal (read `data/campaign.log` tail or per-run log file — currently no endpoint; tail in-memory logs by name match. **Open question 4.**) |
| Past dock: Copy to queue | local push | `POST /api/campaign/queue-only` with history entry's `settings` |
| Past dock: Export CSV | toast | `GET /api/export/csv` (exists; trigger download) |
| Past dock: Archive | local splice | `PATCH /api/history/:idx/archive` — new endpoint |
| Sidebar "Send test" | toast | `POST /api/notify/test` (exists) |
| Sidebar "Sign out" | toast | `POST /api/auth/logout` (exists) |
| Sidebar "Change" timezone | toast | Open existing op-tz modal (`#op-tz-modal` exists in index.html) |
| Header stats | static | Read from `/api/campaign/status` (today/total/errors) + `/api/disk-status` + resource snapshot (existing) |
| "+ Start new campaign" btn-start | `openWizard()` | `window.startNewCampaign()` (exists in app.js:8376) |

## Open questions — RESOLVED 2026-05-27

| # | Question | Decision |
|---|---|---|
| 1 | Active/Monitoring "Open" button behavior | **Wizard pre-filled** — scroll to `#/new` with running campaign config loaded (uses existing `#nav-status` section for live progress). |
| 2 | "batch every 30 min" inline link | **Scroll to wizard Settings section** — switch to `#/new`, jump to `#nav-pace`, current fields editable. |
| 3 | Monitoring card "Pause watch" button | **Hide entirely** — passive sweep doesn't need pause. Stop watch covers abort. Removes one button from the monitoring dock. |
| 4 | Past dock "Open log" | **Grep rolling campaign.log by name** — adds a 4th new backend endpoint: `GET /api/history/:idx/log` returns filtered log lines. |
| 5 | "Restart" semantics for past | **Always enqueue via `POST /api/campaign/queue-only`** — single code path. If nothing running, queue auto-drains immediately. |

**Risk #4 resolution** — CSS scoping: prefix every selector in `dashboard-v0.3.css` with `body[data-dashboard='v3']`. Toggle the attribute when v0.3 is active. Reversible.

**Risk #5 resolution** — Drop inline-edit from dashboard. Keep in wizard. v0.3 markup ships without `data-edit` attributes.

**Updated endpoint count:** 4 new backend endpoints, not 3.
- `PATCH /api/queue/:id` — edit queued campaign config
- `POST /api/history/:idx/relaunch` — restart finished campaign (enqueue copy)
- `PATCH /api/history/:idx/archive` — soft-archive past entry
- `GET /api/history/:idx/log` — grep campaign.log filtered by name (new, from Q4 resolution)

## Risks

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | `pollStatus()` is tightly coupled to specific DOM IDs (`#cockpit-ring-num`, `#st-today`, etc. — see research output 3). v0.3 doesn't have those IDs. | High | Phase 4 refactors `pollStatus` to write to v0.3 IDs. Verify after each sub-phase. |
| 2 | The 7 tab renderers (`refreshActiveCampaign`, `refreshDashboardQueue`, `refreshDashboardSchedules`, `refreshDashboardDrafts`, `refreshPastCampaigns`, etc.) get deleted. Some helpers (like `_dashSelection`, undo-window for past deletes) carry over to v0.3 in adapted form; others are wholesale removed. | Medium | Phase 4 audits which helpers are used elsewhere before deleting. |
| 3 | 9 887-line app.js means surgical patching is error-prone. | Medium | Phase 4 splits into 5 sub-phases per section; each is small, testable, committed atomically. Use Edit (not Write) on app.js. |
| 4 | New CSS file might cascade-conflict with existing style.css (component class names overlap: `.dock`, `.dock-btn`, `.glyph`, etc.). | Medium | Scope dashboard-v0.3.css selectors under `body[data-dashboard="v3"]` or similar; v0.3 styles only apply when that attribute is set. Add the attribute when v0.3 is the active dashboard. |
| 5 | Inline-edit ("Edit labels") mode in current app walks `data-edit="..."` attributes (app.js:4992). v0.3 markup doesn't have them. | Low | Either add `data-edit` attributes to the relevant v0.3 elements (campaign name, sheet URL) or accept losing inline-edit on the dashboard (it stays in the wizard). Prefer: add the attributes. |
| 6 | Drag-reorder uses HTML5 drag-and-drop. Existing queue uses similar (research output 3 mentions drag/drop on queue rows). Risk of double-init. | Low | Phase 4 removes old drag init before adding v0.3's. |
| 7 | Existing Electron auto-relaunch (CLAUDE.md rule 2) means dev:app restarts after every commit touching runtime code. Phase 4's atomic commits will trigger ~10-15 restarts. | Low | Expected; that's the dev loop. |
| 8 | The 3 new backend endpoints can break running campaigns if PATCH/queue/:id is called while the campaign is launching. | Medium | Guard each new endpoint with a 409 check (`if (campaign.running) return 409`). Tests cover the guard. |

## Verification plan (binary gates)

Each phase must pass its gate before the next starts.

### Phase 1 gate
- `npm test -- tests/queue-update.test.js` passes
- `npm test -- tests/history-relaunch.test.js` passes
- `npm test -- tests/history-archive.test.js` passes
- `curl -X PATCH localhost:<port>/api/queue/<id> -H "Content-Type: application/json" -d '{"name":"renamed"}'` returns 200 + the queue entry shows new name
- `curl -X POST localhost:<port>/api/history/0/relaunch` returns 200 + a new queue entry appears
- `curl -X PATCH localhost:<port>/api/history/0/archive` returns 200 + entry hidden from `GET /api/history`
- Existing tests still pass (`npm test`)

### Phase 2 gate
- `npm run dev:app` opens Electron → existing dashboard renders identically (CSS file loaded but inert because no v0.3 body attribute yet)
- No console errors
- View → Sources confirms `dashboard-v0.3.css` is loaded

### Phase 3 gate
- `npm run dev:app` opens Electron → `#dashboard-view` shows v0.3 markup (probably empty/uninitialized; that's OK)
- Wizard still opens via "+ Start new campaign"
- Right-pane still shows status
- No console errors related to missing handlers (everything is `onclick="window.fn()"` and the fn either exists or warns clearly)

### Phase 4 sub-phase gates (one per section)
- **4a. Active card** — running campaign shows real data; pause/resume works; stop works; show-details reveals real log lines; bulk-check fires endpoint and shows toast
- **4b. Monitoring** — monitoring slice shows real data in mini state; expand toggle works; force-sweep fires endpoint; details panel shows sweep events
- **4c. Up Next** — queue renders from `/api/queue`; drag-reorder persists; start-now works; remove works; edit opens wizard with config; duplicate enqueues
- **4d. Calendar** — week grid renders; today's chip shows running campaign; scheduled chips link to queue items; prev/next/today nav re-renders grid
- **4e. Past** — collapsed summary shows last finished; "Show all" expands to real history; rerun enqueues a copy; archive hides the row; export downloads CSV

### Phase 5 gate (final acceptance)
- Full operator workflow: open app → see running EU Founder Push Q2 in Active → see EU Founder Push Q1 in Monitoring mini → see 4 queue items in Up Next → see calendar with running + scheduled chips → see Past summary → click "+ Start new campaign" → wizard opens → fill it → submit → new item appears in Up Next → drag it to position 2 → confirm via curl that `/api/queue/reorder` was called → archive an old past entry → confirm it disappears → restart Electron → state persists
- Manual click-through with `read_console_messages` (claude-in-chrome MCP) confirming zero errors
- Memory check: open with Activity Monitor; v0.3 dashboard should be no worse than current dashboard (currently ~120 MB renderer process)

## Out-of-band: what we do NOT verify

- LinkedIn outreach correctness (off-limits files)
- GoLogin profile lifecycle (untouched)
- Email / desktop notifications (untouched paths)
- Sheets schema (untouched)
- Multi-campaign concurrency (hard constraint: ONE campaign at a time per `project_ortus_one_campaign_at_a_time`)

## Future work (deliberately deferred)

- Drafts + Schedules dashboard surface (hidden in v1)
- v0.3-style wizard (current wizard is 12+ sections; rewriting it is a separate project)
- Per-run log files (currently single `data/campaign.log`)
- Multi-monitoring slots (currently single monitoring slot)
- Live activity feed in main canvas (still in right-pane)
- Dark/light theme refinement for v0.3 (initial pass uses existing tokens)

---

**Status:** Spec drafted 2026-05-27. Awaiting Antonio's review. Once approved → write executable plan to `docs/superpowers/plans/2026-05-27-dashboard-v0.3-integration-plan.md` → execute via `subagent-driven-development`.
