# Requirements: Ortus GoLogin Clone — LinkedIn Outreach Automation

**Core Value:** Operators can run multi-account LinkedIn outreach campaigns reliably and safely.

## v3.0 Requirements — Engagement & Intelligence

Active milestone. Each requirement maps to a roadmap phase.

### Check DMs (DMS)

Detect replies to sent DMs and surface them for operator triage.

- [ ] **DMS-01**: Operator can click "Check DMs" in the Campaign section to trigger a manual scan on the currently selected GoLogin profile(s)
- [ ] **DMS-02**: Check DMs scans only sheet rows where `Message="sent"` AND `Account Used` matches the running profile (per-profile scoping)
- [ ] **DMS-03**: Reply detection uses LinkedIn Voyager `/voyager/api/messaging/conversations` API as the primary source, with inbox DOM scraping as a documented fallback path
- [ ] **DMS-04**: Matched replies are written back to the Google Sheet in new auto-added columns — `Reply` (yes), `Reply At` (ISO timestamp), `Reply Preview` (first ~100 chars)
- [ ] **DMS-05**: New replies appear in a Replies panel in the dashboard showing prospect name, message snippet, timestamp, and an "Open Thread" button per reply
- [ ] **DMS-06**: "Open Thread" opens the LinkedIn conversation URL in the system browser (`shell.openExternal`) — not inside the Electron window — so LinkedIn's own session handles it
- [ ] **DMS-07**: Subsequent Check DMs runs only surface replies newer than the per-profile `last_check_at` watermark (delta semantics, persisted to local state)

### Tab Framework (TAB)

Dashboard navigation so new feature areas land as first-class tabs.

- [ ] **TAB-01**: The dashboard exposes a top-level tab bar — at minimum: Campaign, SN Scraper, City Scanner (the existing dashboard becomes the Campaign tab)
- [ ] **TAB-02**: Switching tabs preserves the in-progress state of other tabs without a reload (an active campaign keeps running when the operator switches to the Scanner tab)

### Ortus City Scanner (SCAN)

Port the existing standalone Electron scanner into a tab; Puppeteer drives Sales Nav filters and counts leads per city.

- [ ] **SCAN-01**: City Scanner tab renders the full scanner UI (filter form for titles, seniority, headcount, industry, geography; city textarea; run controls; live results table)
- [ ] **SCAN-02**: Operator fills filters + city list + client/geography labels, clicks "Start Full Auto-Scan" → Puppeteer applies filters in Sales Nav and scans each city in sequence, recording lead counts
- [ ] **SCAN-03**: Scanner surfaces live progress (current city, completed results so far) via a polling endpoint, matching the standalone app's status-polling pattern
- [ ] **SCAN-04**: Scanner results can be exported as CSV and copied in tab-separated format (for paste into the Ortus Feasibility Dashboard)

### SN Scraper — Create Saved Search (SCRC)

Build saved-search URLs in Sales Nav via Puppeteer, for later scraping.

- [ ] **SCRC-01**: SN Scraper tab has a "Create Saved Search" mode with a filter form covering Sales Nav's filter set (titles, function, seniority, headcount, industry, geography)
- [ ] **SCRC-02**: Operator fills filters + search name, clicks "Save Search" → Puppeteer applies the filters in Sales Nav, saves the search, and returns the saved-search URL
- [ ] **SCRC-03**: Saved searches are persisted locally (per-user data dir) and listed in the UI with name, filter summary, and creation date

### SN Scraper — Scrape Saved Search (SCRS)

Extract leads from a previously saved search.

- [ ] **SCRS-01**: Operator picks a saved search from the list (or pastes a Sales Nav search URL) and clicks "Scrape" → Puppeteer opens the URL
- [ ] **SCRS-02**: Scraper paginates through results and extracts per-lead data: name, title, company, location, LinkedIn profile URL
- [ ] **SCRS-03**: Extracted leads can be written to a Google Sheet and/or downloaded as CSV
- [ ] **SCRS-04**: Scraper enforces configurable rate limits — delay between pages and a max-pages cap per run — to reduce Sales Nav throttling risk

## Shipped (v1.0 + v2.0)

Kept as reference; see PROJECT.md for full validated list.

- **v1.0** — GoLogin profile cycling, LinkedIn action detection, campaign orchestrator, sheet read/write, dashboard, state persistence, limit detection, Open Profile messaging
- **v2.0** — Security lockdown (.env only, email auth), reliability hardening (async I/O, graceful shutdown, profile health checks), operational features (scheduling, rate limits, history, CSV export), dashboard UX (template save/load, progress bar, history panel), Electron desktop packaging with unquarantine helper

## Future (tracked but not scheduled)

Captured as seeds in `.planning/seeds/`. Surfaced automatically when triggers fire.

- **Full-thread text fetch for Check DMs** — trigger: operators click "Open Thread" frequently (seed: `check-dms-full-thread-upgrade.md`)
- **Auto-responder filter for Check DMs** — trigger: Replies panel gets noisy with autoresponder messages (seed: `check-dms-auto-responder-filter.md`)

## Out of Scope

| Feature | Reason |
|---------|--------|
| Agent switching (LinkedIn personas) | Single-account-per-profile model is sufficient |
| LinkedIn group messaging | Different product surface |
| Proxy management | GoLogin handles this internally |
| Mobile/responsive dashboard | Internal tool, desktop only |
| Database storage | Per-user JSON files remain sufficient |
| Core automation logic changes | Working v1.0/v2.0 automation must not be modified |
| Auto follow-up on replies | Operator-driven — not in scope for Check DMs v1 |
| Push/email notifications for new replies | Morning-ritual model makes this unnecessary |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| DMS-01 | Phase 11 | Pending |
| DMS-02 | Phase 11 | Pending |
| DMS-03 | Phase 11 | Pending |
| DMS-04 | Phase 11 | Pending |
| DMS-05 | Phase 11 | Pending |
| DMS-06 | Phase 11 | Pending |
| DMS-07 | Phase 11 | Pending |
| TAB-01 | Phase 12 | Pending |
| TAB-02 | Phase 12 | Pending |
| SCAN-01 | Phase 13 | Pending |
| SCAN-02 | Phase 13 | Pending |
| SCAN-03 | Phase 13 | Pending |
| SCAN-04 | Phase 13 | Pending |
| SCRC-01 | Phase 14 | Pending |
| SCRC-02 | Phase 14 | Pending |
| SCRC-03 | Phase 14 | Pending |
| SCRS-01 | Phase 15 | Pending |
| SCRS-02 | Phase 15 | Pending |
| SCRS-03 | Phase 15 | Pending |
| SCRS-04 | Phase 15 | Pending |

**Coverage:**
- v3.0 requirements: 20 total
- Mapped to phases: 20
- Unmapped: 0

---
*Requirements defined: 2026-04-21 for milestone v3.0 Engagement & Intelligence*
