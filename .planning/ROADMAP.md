# Roadmap: Ortus GoLogin Clone — LinkedIn Outreach Automation

## Milestones

- ✅ **v1.0 ElevenLabs Calling Integration** - Phases 1-6 (shipped)
- 🚧 **v2.0 Delivery Hardening** - Phases 7-10 (in progress)

## Phases

<details>
<summary>v1.0 ElevenLabs Calling Integration (Phases 1-6) - SHIPPED</summary>

- [x] **Phase 1: Foundation Fix** - Deploy variable mapping fix, enable TTS override, audit agent prompt
- [x] **Phase 2: Voice Selection Core** - Voice dropdown with per-batch override and last-used persistence
- [x] **Phase 3: UX Polish** - Voice previews, labels, bookmarks, and input validation
- [x] **Phase 4: Agent Intelligence** - Voicemail detection, end call tool, faster TTS, Vapi prompt port
- [x] **Phase 5: Reporting and Sheet Integration** - Fetch transcripts, recordings, summaries, write to sheet
- [x] **Phase 6: SMS Follow-Up and Scheduling** - Twilio SMS on voicemail/no-answer, callback scheduling

</details>

### v2.0 Delivery Hardening

**Milestone Goal:** Harden the working automation tool for team delivery — fix security issues, improve reliability, add operational features, and polish the dashboard UX without touching core automation logic.

**Phase Numbering:**
- Integer phases (7, 8, 9, 10): Planned milestone work
- Decimal phases (7.1, 8.1): Urgent insertions (marked with INSERTED)

- [ ] **Phase 7: Security Lockdown** - Remove hardcoded tokens, add basic auth, verify .gitignore
- [ ] **Phase 8: Reliability Hardening** - Async I/O, dedup utility, graceful shutdown, health check
- [ ] **Phase 9: Operational Features** - Scheduling, rate limits, campaign history, CSV export
- [ ] **Phase 10: Dashboard UX** - Template save/load UI, progress bar fix, history panel

## Phase Details

### Phase 7: Security Lockdown
**Goal**: The application has no exposed secrets and only authenticated users can access the dashboard
**Depends on**: Nothing (first phase of v2.0)
**Requirements**: SEC-01, SEC-02, SEC-03
**Success Criteria** (what must be TRUE):
  1. Grep of the entire codebase for API tokens, passwords, or secrets returns zero hardcoded values — all secrets load from .env
  2. Opening the dashboard URL in a browser without credentials shows a login prompt, not the dashboard
  3. .env file is listed in .gitignore and `git status` confirms it is not tracked
**Plans:** 2 plans
Plans:
- [x] 07-01-PLAN.md — Remove hardcoded secrets, add startup env validation, verify .gitignore
- [x] 07-02-PLAN.md — Add HTTP Basic Auth middleware protecting all routes

### Phase 8: Reliability Hardening
**Goal**: The system handles I/O without blocking, avoids code duplication, shuts down cleanly, and verifies profiles before starting campaigns
**Depends on**: Phase 7
**Requirements**: REL-01, REL-02, REL-03, REL-04
**Success Criteria** (what must be TRUE):
  1. Campaign orchestrator reads and writes state files using async readFile/writeFile — no sync I/O calls remain in campaign.js
  2. Only one extractSheetId() function exists in the codebase (shared utility), and all callers import from the same location
  3. Pressing Ctrl+C during a running campaign closes all active GoLogin profiles before the process exits (no orphaned browser sessions)
  4. Before a campaign starts, each selected profile is verified to have an active LinkedIn session — profiles that fail the check are skipped with a warning in the dashboard
**Plans:** 2 plans
Plans:
- [x] 08-01-PLAN.md — Async I/O conversion and extractSheetId deduplication
- [x] 08-02-PLAN.md — Graceful shutdown handler and profile health checks

### Phase 9: Operational Features
**Goal**: Operators can schedule campaigns, configure safety limits, review past campaigns, and export results
**Depends on**: Phase 8
**Requirements**: OPS-01, OPS-02, OPS-03, OPS-04
**Success Criteria** (what must be TRUE):
  1. Operator can set a cron-style schedule in the dashboard and the campaign auto-starts at the scheduled time without manual intervention
  2. Operator can configure daily and hourly action caps per profile, and the system stops sending actions when a cap is reached
  3. Completed campaign logs are persisted to disk as JSON and survive server restarts
  4. Operator can click a CSV export button in the dashboard and download campaign results as a .csv file
  5. Randomized delays between actions fall within operator-configured min/max ranges
**Plans:** 2 plans
Plans:
- [x] 09-01-PLAN.md — Rate-limit delay randomization and cron-based campaign scheduling
- [x] 09-02-PLAN.md — Campaign history persistence and CSV export

### Phase 10: Dashboard UX
**Goal**: Operators can save/load message templates, see accurate per-campaign progress, and browse past campaign summaries from the dashboard
**Depends on**: Phase 9
**Requirements**: UX-01, UX-02, UX-03
**Success Criteria** (what must be TRUE):
  1. Operator can save a named message template from the dashboard and load it back later — templates persist across sessions
  2. Operator can delete a saved template from the template list
  3. Progress bar resets to 0% when a new campaign starts and accurately reflects that campaign's lead processing (not cumulative)
  4. Campaign history panel shows past campaigns with date, mode, profiles used, and success/error counts
**Plans**: TBD
**UI hint**: yes

## Progress

**Execution Order:**
Phases execute in numeric order: 7 -> 8 -> 9 -> 10

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 7. Security Lockdown | v2.0 | 2/2 | Complete | - |
| 8. Reliability Hardening | v2.0 | 0/2 | Planning | - |
| 9. Operational Features | v2.0 | 0/2 | Planning | - |
| 10. Dashboard UX | v2.0 | 0/0 | Not started | - |
