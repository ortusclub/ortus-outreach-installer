---
phase: 09-operational-features
plan: 01
subsystem: campaign-scheduling
tags: [scheduling, rate-limits, node-cron, campaign]
dependency_graph:
  requires: []
  provides: [schedule-crud-api, randomized-delay, cron-auto-fire]
  affects: [src/campaign.js, server.js, package.json, data/schedules.json]
tech_stack:
  added: [node-cron]
  patterns: [json-file-persistence, cron-scheduling, randomized-delay]
key_files:
  created:
    - data/schedules.json
  modified:
    - src/campaign.js
    - server.js
    - package.json
decisions:
  - "Default delay range 8-15s per context decision D-06"
  - "Schedule IDs use sched_{timestamp} pattern"
  - "Schedules stored as JSON array in data/schedules.json"
metrics:
  duration: "3 minutes"
  completed: "2026-04-09"
  tasks_completed: 2
  tasks_total: 2
  files_changed: 4
---

# Phase 09 Plan 01: Campaign Scheduling and Rate-Limit Delays Summary

Configurable randomized inter-lead delays (default 8-15s) and full node-cron campaign scheduling with CRUD API, JSON persistence, and auto-registration on server restart.

## What Was Built

### Task 1: Randomized Delay Between Leads
- Added `delayMin` (default 8) and `delayMax` (default 15) parameters to `startCampaign()` signature
- Replaced hardcoded 10-second inter-lead delay with `Math.random() * (delayMax - delayMin + 1) + delayMin` randomization
- Preserved the 20-second home page warmup wait (D-09)
- Wired `delayMin`/`delayMax` through the `POST /api/campaign/start` route in server.js
- **Commit:** `5f39abb`

### Task 2: Node-Cron Campaign Scheduling
- Installed `node-cron` dependency
- Created `data/schedules.json` for schedule persistence (empty array)
- Added `loadSchedules()`/`saveSchedules()` following existing templates persistence pattern
- Added `registerSchedule()` function with `cron.validate()` for input safety (T-09-01 mitigation)
- Added three API endpoints behind existing Basic Auth:
  - `GET /api/schedules` - list all schedules
  - `POST /api/schedules` - create/update schedule with validation
  - `DELETE /api/schedules/:id` - remove schedule and stop its cron job
- Schedules auto-fire `startCampaign()` with stored params at configured cron time
- `lastRun` timestamp updated after each successful fire
- All saved schedules are loaded and re-registered in the `app.listen` callback on server restart (D-05)
- **Commit:** `3cc0eed`

## Decisions Made

| Decision | Rationale |
|----------|-----------|
| Default delay 8-15s | Per context decision D-06 -- safe range for LinkedIn rate limits |
| Schedule ID: `sched_{timestamp}` | Simple, unique, no external dependency needed |
| Cron validation via `cron.validate()` | Mitigates T-09-01 (invalid cron expression injection) |

## Deviations from Plan

None -- plan executed exactly as written.

## Threat Mitigations Applied

| Threat ID | Mitigation |
|-----------|------------|
| T-09-01 | Cron expression validated with `cron.validate()` before registration; invalid patterns rejected with 400 |
| T-09-02 | Campaign `running` guard prevents concurrent runs; scheduled fire while campaign running throws and is caught |

## Known Stubs

None -- all functionality is fully wired.

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| 1 | `5f39abb` | Add configurable delayMin/delayMax with randomized inter-lead delay |
| 2 | `3cc0eed` | Add node-cron scheduling with CRUD API and persistence |

## Self-Check: PASSED
