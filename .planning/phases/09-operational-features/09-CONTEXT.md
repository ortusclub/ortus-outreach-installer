# Phase 9: Operational Features - Context

**Gathered:** 2026-04-09
**Status:** Ready for planning

<domain>
## Phase Boundary

Add campaign scheduling (cron-style), configurable rate-limit safety (delay ranges), campaign history persistence, and CSV export of lead-level results. Core automation logic stays unchanged.

</domain>

<decisions>
## Implementation Decisions

### Campaign scheduling
- **D-01:** Use `node-cron` npm package for in-process cron scheduling. No system-level cron needed.
- **D-02:** Dashboard UI for schedule management — operator sets cron expression + campaign params (profiles, sheet URL, mode, templates, daily limit). Saved to `data/schedules.json`.
- **D-03:** API endpoints: `GET /api/schedules` (list), `POST /api/schedules` (create/update), `DELETE /api/schedules/:id` (remove)
- **D-04:** Each schedule stores: id, name, cron expression, profileIds, sheetUrl, mode, templates, dailyLimit, enabled/disabled flag, lastRun timestamp
- **D-05:** Schedules are loaded on server start and registered with node-cron. When a schedule fires, it calls `startCampaign()` with the stored params — same function the dashboard "Start" button uses.

### Rate-limit safety
- **D-06:** Add configurable min/max delay between actions (currently hardcoded 10s in campaign.js line 447). Default: min 8s, max 15s. Randomized within range.
- **D-07:** Keep existing `dailyLimit` per-profile cap. No hourly cap needed — daily + randomized delays provide sufficient safety.
- **D-08:** Delay settings are per-campaign (set in dashboard alongside daily limit), not global. Passed to `startCampaign()` as `delayMin`/`delayMax` params.
- **D-09:** The 20s home page wait (campaign.js line 246) stays unchanged — that's a session warmup, not a rate-limit delay.

### Campaign history
- **D-10:** On campaign end, save a summary object to `data/history.json` (append to array): date, mode, profiles used, dailyLimit, totalProcessed, successCount, errorCount, duration, templateNames
- **D-11:** `GET /api/history` returns the history array. Dashboard displays it (Phase 10).
- **D-12:** No retention policy — keep all history. File is small (one JSON object per campaign run).

### CSV export
- **D-13:** `GET /api/export/csv` returns lead-level detail from the most recent campaign: LinkedIn URL, firstName, lastName, company, title, action taken, result, profileUsed, timestamp
- **D-14:** Data source: `data/state.json` (already has processed leads with profileName, action, date). Enrich with original sheet data if available.
- **D-15:** CSV generated server-side using simple string concatenation (no library needed). Response has `Content-Type: text/csv` and `Content-Disposition: attachment`.

### Claude's Discretion
- node-cron version selection
- Schedule ID generation strategy (UUID vs incrementing)
- Whether to add a "run now" button per schedule
- Exact CSV column ordering

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

No external specs — requirements fully captured in decisions above.

### Source files to modify
- `server.js` — Add schedule + history + CSV export API endpoints
- `src/campaign.js` — Accept delayMin/delayMax params, use randomized delay, save history on campaign end
- `package.json` — Add node-cron dependency

### New files
- `data/schedules.json` — Schedule persistence
- `data/history.json` — Campaign history persistence

### Prior phase context
- `.planning/phases/07-security-lockdown/07-CONTEXT.md` — All routes require basic auth (schedules/history/export endpoints too)
- `.planning/phases/08-reliability-hardening/08-CONTEXT.md` — Async state I/O pattern, graceful shutdown

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `startCampaign()` in campaign.js — schedules call this directly with stored params
- `loadTemplates()`/`saveTemplates()` in server.js — pattern for JSON file persistence (reuse for schedules/history)
- `campaign.logs` array — current in-memory log for live status; history captures summary at end
- `data/state.json` — contains processed leads with action, profileName, date — source for CSV export

### Established Patterns
- Express routes follow RESTful pattern: GET list, POST create, DELETE remove
- JSON file persistence via `readFile`/`writeFile` from `node:fs/promises`
- Auth middleware already covers all new endpoints (positioned before all routes)

### Integration Points
- Schedule API endpoints go in server.js alongside existing template endpoints
- `startCampaign()` already accepts all params needed by a schedule (profileIds, sheetUrl, templates, dailyLimit, mode)
- Campaign history write hooks into the `finally` block of `startCampaign()` (campaign.js line 488)
- Delay randomization replaces the hardcoded `10000` at campaign.js line 447

</code_context>

<specifics>
## Specific Ideas

- Scheduling should feel like PhantomBuster's — set it and forget it
- CSV export is for quick team reporting without sharing the Google Sheet
- Rate limits should protect against LinkedIn detection without being too conservative

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 09-operational-features*
*Context gathered: 2026-04-09*
