# Roadmap: Ortus GoLogin Clone — LinkedIn Outreach Automation

## Milestones

- ✅ **v1.0 ElevenLabs Calling Integration** - Phases 1-6 (shipped)
- ✅ **v2.0 Delivery Hardening** - Phases 7-10 (shipped)
- 🚧 **v3.0 Engagement & Intelligence** - Phases 11-15 (in progress)

## Phases

<details>
<summary>v1.0 ElevenLabs Calling Integration (Phases 1-6) — SHIPPED</summary>

- [x] **Phase 1: Foundation Fix** - Deploy variable mapping fix, enable TTS override, audit agent prompt
- [x] **Phase 2: Voice Selection Core** - Voice dropdown with per-batch override and last-used persistence
- [x] **Phase 3: UX Polish** - Voice previews, labels, bookmarks, and input validation
- [x] **Phase 4: Agent Intelligence** - Voicemail detection, end call tool, faster TTS, Vapi prompt port
- [x] **Phase 5: Reporting and Sheet Integration** - Fetch transcripts, recordings, summaries, write to sheet
- [x] **Phase 6: SMS Follow-Up and Scheduling** - Twilio SMS on voicemail/no-answer, callback scheduling

</details>

<details>
<summary>v2.0 Delivery Hardening (Phases 7-10) — SHIPPED</summary>

- [x] **Phase 7: Security Lockdown** - Remove hardcoded tokens, add basic auth, verify .gitignore
- [x] **Phase 8: Reliability Hardening** - Async I/O, dedup utility, graceful shutdown, health check
- [x] **Phase 9: Operational Features** - Scheduling, rate limits, campaign history, CSV export
- [x] **Phase 10: Dashboard UX** - Template save/load UI, progress bar fix, history panel (completed 2026-04-09)

</details>

### v3.0 Engagement & Intelligence

**Milestone Goal:** Extend the outreach automation into a full lifecycle tool — detect replies to sent DMs, and add Sales Navigator scraping + lead-volume scanning as independent tabs alongside the existing Campaign section.

**Phase Numbering:**
- Integer phases (11, 12, 13, 14, 15): Planned milestone work
- Decimal phases (e.g. 11.1): Reserved for urgent insertions (marked INSERTED)

- [ ] **Phase 11: Check DMs** - New Campaign mode; Voyager-based reply detection scoped per profile, with Replies panel + sheet writeback and delta semantics
- [x] **Phase 11.1: Resource-Aware Campaign Execution** (INSERTED) - Live RAM/CPU monitor in dashboard, idle profiles park on a low-RAM page between actions, campaign auto-throttles when resources cross threshold (completed 2026-04-22)
- [ ] **Phase 11.2: Batch-Mode Campaign + Window Management** (INSERTED) - Refactor campaign loop to batch-of-5 per profile with lazy launch, swap Daily Limit UI to Batches-per-hour, minimize Chromium windows via AppleScript on macOS, make Electron app tray-first with close-to-tray
- [ ] **Phase 12: Tab Framework** - Dashboard tab bar that hosts Campaign / SN Scraper / City Scanner as first-class tabs with preserved in-progress state
- [ ] **Phase 13: Ortus City Scanner Integration** - Port the standalone Electron scanner into a tab; Puppeteer-driven city-by-city lead counting
- [ ] **Phase 14: SN Scraper — Create Saved Search** - Filter form + Puppeteer that applies filters in Sales Nav and saves the search, returning a reusable URL
- [ ] **Phase 15: SN Scraper — Scrape Saved Search** - Pick a saved search, paginate, extract leads, export to CSV or Google Sheet

## Phase Details

### Phase 11: Check DMs
**Goal**: Operators can trigger a manual per-profile reply scan from the Campaign section and see only new replies to their sent DMs — both in a dashboard panel and written back to the Google Sheet.
**Depends on**: Nothing (runs independently of the tab framework — lives in the existing Campaign section)
**Requirements**: DMS-01, DMS-02, DMS-03, DMS-04, DMS-05, DMS-06, DMS-07
**Success Criteria** (what must be TRUE):
  1. Operator selects one or more GoLogin profiles, clicks "Check DMs" in the Campaign section, and sees a Replies panel populated with new replies for those profiles within roughly 30 seconds (volume dependent).
  2. A Replies panel row shows prospect name, a message snippet, timestamp, and an "Open Thread" button that opens the LinkedIn conversation in the system browser — not inside the Electron window.
  3. After a successful Check DMs run, the underlying Google Sheet rows (scoped to `Message="sent"` AND `Account Used = <running profile>`) have `Reply`, `Reply At`, and `Reply Preview` columns auto-added/populated, and rows already marked `Reply="yes"` are not overwritten.
  4. Running Check DMs a second time with no new activity returns an empty Replies panel; running it after a new inbound reply arrives surfaces only that reply (delta semantics driven by a per-profile `last_check_at` watermark).
  5. If the Voyager API path fails, the feature logs which fallback it attempted (DOM scrape) and surfaces a clear error in the dashboard — the operator is never left wondering whether the scan ran.
**Plans:** 5 plans
Plans:
- [ ] 11-01-PLAN.md — Wave 0 — Test infrastructure + live Voyager fixture capture + RED tests
- [ ] 11-02-PLAN.md — Wave 1 — Core module (check-dms.js, helpers extension, sheets-writer helper, campaign re-exports)
- [ ] 11-03-PLAN.md — Wave 2 — Server endpoints (4 routes + symmetric mutex) + Apps Script config
- [ ] 11-04-PLAN.md — Wave 2 — UI (button, Replies panel, polling, CSS, renderer module)
- [ ] 11-05-PLAN.md — Wave 3 — End-to-end verification + VALIDATION sign-off
**UI hint**: yes

### Phase 11.2: Batch-Mode Campaign + Window Management (INSERTED)

**Goal:** Every LinkedIn outreach mode runs as profile-local batches of 5 leads (lazy-launched, parked or fully closed between batches) governed by a simple "batches per hour" knob. On macOS the Orbita Chromium windows minimize to the dock on launch so they don't steal focus, and the Electron app itself runs tray-first — no dock icon, dashboard hides to tray on close.
**Depends on:** Phase 11.1 (inherits resource-monitor, parkProfile, getProfilePid, throttle primitives — must NOT retune)
**Requirements**: D-01..D-22 (captured in 11.2-CONTEXT.md)
**Success Criteria** (what must be TRUE):
  1. Campaigns process 5 leads per profile per batch for EVERY mode (connect_only, message_only, inmail_only, open_profile_only, check_status). No session-break pauses.
  2. Between-batch wait is derived from the operator's "Batches per hour" choice (1-6, default 2), with a 60s floor and a 15-min close-vs-park threshold.
  3. Rate & Limits form shows "Batches per hour" (1-6, default 2) with within-batch gap steppers; the legacy "Max connections per account" input is hidden and safety-capped at 40 in the backend.
  4. On macOS, every launched Orbita window minimizes to the dock within ~1 second of launch. A "Show Browsers" button on the dashboard (and tray menu item) un-minimizes them for debugging.
  5. Electron app boots tray-first: no dock icon on macOS, tray icon visible, NO auto-opened window. Tray menu has Show Dashboard / Start Campaign… / Show Browsers / Quit. Closing the dashboard hides it; only Cmd+Q or tray Quit actually exits.
**Plans:** 2/3 plans executed
Plans:
- [x] 11.2-01-PLAN.md — Wave 1 — macOS window management (mac-window.js + launcher hooks + /api/browsers/show endpoint)
- [x] 11.2-02-PLAN.md — Wave 2 — Batch-mode campaign loop refactor (delete STEP 1, batch-of-5, lazy launch, close@15min)
- [ ] 11.2-03-PLAN.md — Wave 3 — Rate & Limits UI relabel + Electron tray mode + human-verify checkpoint
**UI hint**: yes

### Phase 11.1: Resource-Aware Campaign Execution (INSERTED)
**Goal**: Operators can see live RAM/CPU usage in the dashboard, idle GoLogin profiles auto-park on a low-RAM page between actions, and the campaign automatically slows down when system resources cross a configurable threshold — preventing the slowdowns and crashes seen on lower-end colleague machines.
**Depends on**: Nothing (modifies existing campaign loop and dashboard status endpoint)
**Requirements**: TBD (captured in 11.1-CONTEXT.md via discuss-phase)
**Success Criteria** (what must be TRUE):
  1. Dashboard shows live RAM and CPU usage updating on the existing 2-second status poll, visible without scrolling.
  2. When a profile is idle between actions during a campaign, it navigates to a low-RAM page (e.g. about:blank) and returns to LinkedIn before its next action without losing its session.
  3. When RAM or CPU usage crosses a configurable threshold, the campaign delay multiplier increases automatically; when usage falls back below the threshold, normal pacing resumes.
  4. The throttled state is observable in the dashboard (operator sees when the campaign is in slow-mode and why) and the resource trend is legible enough to compare before/after when testing performance changes.
**Plans:** 3/3 plans complete
Plans:
- [x] 11.1-01-PLAN.md — Wave 1 — Foundation: resource-monitor module, PID export, Wave 0 test scaffold (node:test)
- [x] 11.1-02-PLAN.md — Wave 2 — Wire sampling + throttle + parking into the round-robin loop
- [x] 11.1-03-PLAN.md — Wave 3 — Dashboard tiles (RAM/CPU/Browsers), slow-mode banner, amber CSS
**UI hint**: yes

### Phase 12: Tab Framework
**Goal**: The dashboard has a top-level tab bar so new feature areas (SN Scraper, City Scanner) are first-class navigation destinations, and switching tabs does not disturb in-progress work.
**Depends on**: Nothing (pure dashboard refactor; does not block Phase 11)
**Requirements**: TAB-01, TAB-02
**Success Criteria** (what must be TRUE):
  1. Opening the dashboard shows a visible top-level tab bar with at least Campaign, SN Scraper, and City Scanner — the existing dashboard content is fully accessible under the Campaign tab with no missing controls.
  2. Starting a campaign on the Campaign tab, then switching to another tab and back, shows the campaign still running with live progress intact (no reload, no lost logs).
  3. Each tab can render its own content area independently — operator can interact with form inputs on the SN Scraper tab without interrupting a running campaign on the Campaign tab.
**Plans**: TBD
**UI hint**: yes

### Phase 13: Ortus City Scanner Integration
**Goal**: The standalone Ortus City Scanner (Puppeteer-driven Sales Nav lead counter) is ported into a City Scanner tab in this app — operators run city-by-city scans and export results without leaving the main dashboard.
**Depends on**: Phase 12 (needs the tab bar to host the tab)
**Requirements**: SCAN-01, SCAN-02, SCAN-03, SCAN-04
**Success Criteria** (what must be TRUE):
  1. The City Scanner tab renders the full scanner UI (filter form for titles, seniority, headcount, industry, geography; city textarea; run controls; live results table) matching the standalone app's behavior.
  2. Operator fills filters + a city list + client/geography labels, clicks "Start Full Auto-Scan", and Puppeteer drives Sales Nav through each city in sequence, writing the resulting lead counts into the results table.
  3. While a scan is running, the UI shows the current city and completed results updating in near-real-time via a polling endpoint (matching the standalone app's status-polling pattern).
  4. After a scan completes, operator can download results as CSV and copy results in tab-separated format suitable for direct paste into the Ortus Feasibility Dashboard.
**Plans**: TBD
**UI hint**: yes

### Phase 14: SN Scraper — Create Saved Search
**Goal**: Operators can define a Sales Nav search via a filter form in the SN Scraper tab, have Puppeteer save the search in Sales Nav, and see the resulting saved search listed locally for reuse.
**Depends on**: Phase 12 (needs the tab bar)
**Requirements**: SCRC-01, SCRC-02, SCRC-03
**Success Criteria** (what must be TRUE):
  1. The SN Scraper tab has a "Create Saved Search" mode with a filter form that covers Sales Nav's filter set (titles, function, seniority, headcount, industry, geography).
  2. Operator fills the filters + a search name, clicks "Save Search", and Puppeteer applies the filters in Sales Nav, saves the search, and returns a valid saved-search URL to the UI.
  3. Saved searches are persisted to the per-user data dir and appear in a list in the UI with name, filter summary, and creation date — surviving app restarts.
  4. If Sales Nav rejects a filter combination or the save flow fails, the UI surfaces a clear error and the local list is not polluted with a broken entry.
**Plans**: TBD
**UI hint**: yes

### Phase 15: SN Scraper — Scrape Saved Search
**Goal**: Operators pick a saved search (or paste a Sales Nav search URL), scrape the results with Puppeteer under configurable rate limits, and export leads to CSV or a Google Sheet.
**Depends on**: Phase 14 (needs saved searches to scrape) — Phase 12 transitively
**Requirements**: SCRS-01, SCRS-02, SCRS-03, SCRS-04
**Success Criteria** (what must be TRUE):
  1. Operator selects a saved search from the list or pastes a Sales Nav search URL, clicks "Scrape", and Puppeteer opens the URL and begins scraping.
  2. Scraper paginates through results and extracts per-lead data — name, title, company, location, LinkedIn profile URL — surfacing a live count of leads scraped so far.
  3. After the scrape finishes (or is stopped), operator can download extracted leads as CSV and/or push them to a Google Sheet, with no manual copy-paste.
  4. Operator can configure a delay between pages and a max-pages cap per run; running a scrape with aggressive caps stops on the right page boundary, and delays are honored between pages (verifiable via timing in logs).
**Plans**: TBD
**UI hint**: yes

## Progress

**Execution Order:**
Phases execute in numeric order within the milestone: 11 -> 12 -> 13 -> 14 -> 15.
Phase 11 runs independently of the tab framework (lives in the existing Campaign section).
Phases 13, 14, 15 depend on Phase 12 (tab bar). Phase 15 additionally depends on Phase 14 (saved searches).

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 7. Security Lockdown | v2.0 | 2/2 | Complete | - |
| 8. Reliability Hardening | v2.0 | 2/2 | Complete | - |
| 9. Operational Features | v2.0 | 4/4 | Complete | - |
| 10. Dashboard UX | v2.0 | 2/2 | Complete | 2026-04-09 |
| 11. Check DMs | v3.0 | 0/5 | Not started | - |
| 11.1. Resource-Aware Campaign Execution | v3.0 | 3/3 | Complete    | 2026-04-22 |
| 11.2. Batch-Mode Campaign + Window Management | v3.0 | 2/3 | In Progress|  |
| 12. Tab Framework | v3.0 | 0/? | Not started | - |
| 13. Ortus City Scanner Integration | v3.0 | 0/? | Not started | - |
| 14. SN Scraper — Create Saved Search | v3.0 | 0/? | Not started | - |
| 15. SN Scraper — Scrape Saved Search | v3.0 | 0/? | Not started | - |
