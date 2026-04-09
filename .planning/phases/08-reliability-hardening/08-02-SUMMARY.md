---
phase: 08-reliability-hardening
plan: 02
subsystem: process-lifecycle
tags: [graceful-shutdown, health-check, reliability]
dependency_graph:
  requires: [async-state-io]
  provides: [graceful-shutdown, profile-health-check]
  affects: [campaign-orchestrator, gologin-launcher, server]
tech_stack:
  added: []
  patterns: [signal-handler, pre-flight-check]
key_files:
  created: []
  modified:
    - src/gologin-launcher.js
    - server.js
    - src/campaign.js
key_decisions:
  - "30s deadline on graceful shutdown prevents indefinite hang if campaign loop is stuck"
  - "Health check replaces basic session check with scroll + rate-limit detection"
metrics:
  duration: 76s
  completed: "2026-04-09T14:30:00Z"
  tasks_completed: 2
  tasks_total: 2
---

# Phase 08 Plan 02: Graceful Shutdown and Profile Health Check Summary

SIGINT/SIGTERM graceful shutdown with profile cleanup via closeAllProfiles, plus pre-campaign health check verifying login state, feed scrollability, and rate-limit banners before lead processing.

## Task Results

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add closeAllProfiles export and graceful shutdown handler | 99291bd | src/gologin-launcher.js, server.js |
| 2 | Add pre-campaign profile health check | 4074502 | src/campaign.js |

## Changes Made

### Task 1: Graceful Shutdown (REL-03)
- Added `closeAllProfiles()` export to `src/gologin-launcher.js` that iterates the `activeProfiles` Map and closes each profile via existing `closeProfile()`
- Added `campaign` and `closeAllProfiles` imports to `server.js`
- Added `gracefulShutdown()` async handler registered on both SIGINT and SIGTERM
- Handler calls `stopCampaign()`, polls `campaign.running` with 30s deadline (500ms intervals), then calls `closeAllProfiles()` and `process.exit(0)`
- Logs three shutdown stages: "waiting for current lead", "Closing N profiles...", "Done."

### Task 2: Profile Health Check (REL-04)
- Added `checkProfileHealth(page, profileName)` function to `src/campaign.js` with three checks:
  1. URL-based login/authwall detection (immediate fail)
  2. Feed scroll interactivity test (scroll to 300px, wait 1s, scroll back)
  3. Rate-limit banner text detection ("too many requests", "please try again later", "you've reached the limit")
- Replaced the basic session check (lines 249-259) with the comprehensive health check
- Unhealthy profiles are skipped with `WARNING` log visible in dashboard via existing `log()` function
- Health check runs after 20s home page wait, before lead processing loop

## Verification Results

1. `grep "closeAllProfiles" src/gologin-launcher.js server.js` -- export and import present (PASS)
2. `grep "SIGINT" server.js` -- handler registered (PASS)
3. `grep "checkProfileHealth" src/campaign.js` -- function defined and called (PASS)
4. `grep -c "too many requests" src/campaign.js` -- returns 1 (PASS)

## Deviations from Plan

None -- plan executed exactly as written.

## Known Stubs

None.

## Self-Check: PASSED

All 3 modified files verified present. Both commit hashes (99291bd, 4074502) confirmed in git log. SUMMARY.md created.
