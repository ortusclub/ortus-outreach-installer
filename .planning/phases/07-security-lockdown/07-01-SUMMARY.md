---
phase: 07-security-lockdown
plan: 01
subsystem: security
tags: [secrets, env-validation, hardcoded-tokens]
dependency_graph:
  requires: []
  provides: [secret-free-source, env-validation]
  affects: [server.js, src/campaign.js, .env.example, .gitignore]
tech_stack:
  added: []
  patterns: [fail-fast-env-validation, env-only-secrets]
key_files:
  created: []
  modified: [server.js, src/campaign.js, .env.example, .gitignore]
decisions:
  - Standardized on GOLOGIN_API_TOKEN env var name (campaign.js previously used GOLOGIN_TOKEN)
  - Startup validation exits process with clear error listing all missing vars
metrics:
  duration: 61s
  completed: 2026-04-09T13:09:28Z
  tasks_completed: 1
  tasks_total: 1
---

# Phase 07 Plan 01: Secret Removal and Env Validation Summary

Removed all hardcoded JWT tokens and Apps Script URLs from source, added fail-fast startup validation for 4 required env vars, and updated .env.example as a complete template.

## What Was Done

### Task 1: Remove hardcoded secrets and add startup env validation
**Commit:** `20e5d59`

- **server.js**: Removed lines 3-13 containing hardcoded `GOLOGIN_API_TOKEN` (JWT) and `SHEETS_WEBAPP_URL` (Apps Script deployment URL) fallbacks. Added `REQUIRED_ENV` array validation block after `dotenv/config` import that checks for `GOLOGIN_API_TOKEN`, `SHEETS_WEBAPP_URL`, `DASHBOARD_USER`, `DASHBOARD_PASS` and calls `process.exit(1)` with a clear error message listing all missing vars.
- **src/campaign.js**: Changed `getToken()` from `process.env.GOLOGIN_TOKEN || 'eyJhbGci...'` to simply `return process.env.GOLOGIN_API_TOKEN` -- standardizing the env var name and removing the hardcoded JWT fallback entirely. Safe because server.js startup validation guarantees the var exists.
- **.env.example**: Expanded from 2 vars (GOLOGIN_API_TOKEN, PORT) to 5 vars (added SHEETS_WEBAPP_URL, DASHBOARD_USER, DASHBOARD_PASS) with descriptive comments.
- **.gitignore**: Added section comments for clarity (already had `.env` and `data/state.json` entries).

## Decisions Made

| Decision | Rationale |
|----------|-----------|
| Standardize on `GOLOGIN_API_TOKEN` | campaign.js used `GOLOGIN_TOKEN`, server.js used `GOLOGIN_API_TOKEN` -- unified on the latter since it matches .env.example and is more descriptive |
| Fail-fast with process.exit(1) | App should not start with missing secrets -- prevents confusing runtime errors |
| Include DASHBOARD_USER/PASS in required env | These will be needed for basic auth (plan 07-02), validating them now prevents partial config |

## Deviations from Plan

None -- plan executed exactly as written.

## Verification Results

| Check | Result |
|-------|--------|
| No hardcoded JWT tokens in server.js or campaign.js | PASS (0 matches for `eyJhbGci`) |
| REQUIRED_ENV validation exists in server.js | PASS |
| process.exit(1) on missing vars | PASS |
| campaign.js uses GOLOGIN_API_TOKEN | PASS |
| getToken() has no hardcoded fallback | PASS |
| .env.example has DASHBOARD_USER | PASS |
| .env.example has DASHBOARD_PASS | PASS |
| .env.example has SHEETS_WEBAPP_URL | PASS |
| .gitignore has .env | PASS |
| .gitignore has data/state.json | PASS |

## Threat Surface Scan

No new threat surface introduced. Changes reduce threat surface by removing hardcoded secrets from source (mitigates T-07-01, T-07-02).
