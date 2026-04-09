# Phase 8: Reliability Hardening - Context

**Gathered:** 2026-04-09
**Status:** Ready for planning

<domain>
## Phase Boundary

Convert sync file I/O to async, consolidate duplicate extractSheetId utility, add graceful shutdown with profile cleanup, and add pre-campaign profile health checks. Core automation logic (campaign loop, LinkedIn actions, outreach flow) stays unchanged.

</domain>

<decisions>
## Implementation Decisions

### Async I/O conversion
- **D-01:** Convert only `loadState()` and `saveState()` in `campaign.js` from `readFileSync`/`writeFileSync` to async `readFile`/`writeFile` from `node:fs/promises`
- **D-02:** Leave `existsSync`/`mkdirSync` at campaign.js top level unchanged — they run once at startup, not during campaigns, so blocking is acceptable
- **D-03:** Since `loadState` and `saveState` become async, all callers in campaign.js must `await` them. The campaign loop is already async, so this is straightforward.

### Utility deduplication
- **D-04:** Create `src/utils.js` with the shared `extractSheetId()` function. Both `sheets.js` and `sheets-writer.js` import from there instead of defining their own.
- **D-05:** The extracted function is identical in both files — no reconciliation needed, just pick one and export it.

### Graceful shutdown
- **D-06:** Register `SIGINT` and `SIGTERM` handlers in `server.js` (not campaign.js — server.js is the entry point)
- **D-07:** On signal: set `campaign._abort = true` (existing abort flag), wait for current lead to finish (the campaign loop already checks `_abort` between leads), then iterate `activeProfiles` Map from `gologin-launcher.js` to close all profiles, save state, then `process.exit(0)`
- **D-08:** Export `activeProfiles` (or a `closeAllProfiles()` function) from `gologin-launcher.js` so server.js can access it for cleanup
- **D-09:** Log shutdown progress to console: "Shutting down... waiting for current lead" → "Closing N profiles..." → "Done."

### Profile health check
- **D-10:** Before the campaign lead loop starts, each selected GoLogin profile is opened and navigated to `linkedin.com/feed` with a deep verification:
  - Check URL for `/login` or `/authwall` (not logged in)
  - Scroll the feed briefly
  - Check for rate-limit banners ("too many requests", "please try again later")
  - 30s timeout per profile
- **D-11:** Profiles that fail the health check are skipped with a warning in the dashboard log. The campaign continues with healthy profiles only.
- **D-12:** Health check results are reported in the dashboard live status before the campaign starts processing leads
- **D-13:** The health check happens AFTER profile launch but BEFORE the lead loop — reuses the existing `launchProfile` flow, just adds a verification step

### Claude's Discretion
- Whether `closeAllProfiles()` is a new export or the Map is exported directly
- Exact error handling for async state I/O failures
- Whether health check is a separate function or inline in campaign.js

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

No external specs — requirements fully captured in decisions above.

### Source files to modify
- `src/campaign.js` — Lines 22, 34, 37: sync I/O to convert; lines 206-260: campaign loop where health check inserts
- `src/gologin-launcher.js` — Line 4: `activeProfiles` Map to export; line 93: `closeProfile` function
- `src/sheets.js` — Line 11: `extractSheetId` to remove, replace with import
- `src/sheets-writer.js` — Line 16: `extractSheetId` to remove, replace with import
- `server.js` — Add SIGINT/SIGTERM handlers

### Prior phase context
- `.planning/phases/07-security-lockdown/07-CONTEXT.md` — Startup validation already guarantees env vars are set before campaign runs

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `campaign._abort` flag (line 71) already exists for graceful stop — SIGINT handler just sets this
- `activeProfiles` Map in gologin-launcher.js already tracks all open GoLogin instances
- `closeProfile()` in gologin-launcher.js already handles stopping a single profile
- Session check logic already exists in campaign.js lines 248-258 (checks for /login, /authwall) — health check can reuse this pattern

### Established Patterns
- Campaign loop already checks `campaign._abort` between leads (line 271)
- `stopCampaign()` already sets `campaign._abort = true` (line 495)
- All LinkedIn page checks use `page.url()` and `page.evaluate()` for DOM inspection

### Integration Points
- SIGINT handler in server.js calls `stopCampaign()` from campaign.js + `closeAllProfiles()` from gologin-launcher.js
- Health check inserts between profile launch (line 219) and lead loop start (line 271)
- `src/utils.js` (new) is imported by sheets.js and sheets-writer.js

</code_context>

<specifics>
## Specific Ideas

- Health check should feel thorough — scroll feed, check for rate limits, not just a URL check
- Shutdown should be graceful, not abrupt — let the current lead finish to avoid partial state

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 08-reliability-hardening*
*Context gathered: 2026-04-09*
