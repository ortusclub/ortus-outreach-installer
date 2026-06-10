# Issue #4 — "Stop" must clear the "monitoring · N days" chip

> Execute via subagent-driven-development, TDD.

**Goal:** After an operator stops a monitoring campaign, the dashboard's past-section "● Monitoring · N days" chip disappears.

**Root cause:** The chip is computed server-side (`_monitoringForEntry`, `server.js`) from the persisted post-campaign **reply-check + bulk-check schedule files**. `stopMonitoring()` (`src/campaign.js:3993`) clears the in-memory/on-disk monitoring slice (`clearMonitoringState()`) but **never removes those schedule files** — so the chip lingers ~7 days. (`stopCampaign({full})` already removes them; the operator path into a monitoring campaign is `stopMonitoring`, which does not.)

**Fix:** In `stopMonitoring()`, after `clearMonitoringState()` (line ~4063), remove the reply + bulk schedules for the captured `sheetId` + `participatingProfileIds` (both already in scope; the fn is async so await). `removeSchedulesForSheet(sheetId, profileIds)` removes entries matching the sheet (and, when profileIds is non-empty, those profiles; empty/omitted → all for the sheet).

---

### Task 1: Failing regression test

**Files:** Create `tests/stop-monitoring-clears-schedules.test.js`

- [ ] **Step 1:** Set a temp data dir BEFORE imports (mirror `tests/history-relaunch.test.js`'s `ORTUS_DATA_DIR` setup — `SCHEDULE_FILE`/`paths.js ROOT` are resolved at import time). Then:
  - Seed both schedule files with an entry for `sheetId='SHEET123'`, `profileId='p1'`, `expiresAt = <far future>` — via the schedule modules' register/write API (import `registerReplySchedule`/`registerSchedule` or write the JSON directly through their `writeSchedule` path).
  - Import `campaign` + `stopMonitoring` from `../src/campaign.js`. Set `campaign.state='monitoring'`, `campaign.sheetUrl='https://docs.google.com/spreadsheets/d/SHEET123/edit'`, `campaign.participatingProfileIds=['p1']`.
  - Call `await stopMonitoring({ reason: 'test' })`.
  - Assert: both schedule files (read back via the modules' read API) contain **no** entry with `sheetId==='SHEET123'`.
- [ ] **Step 2:** Run `node --test tests/stop-monitoring-clears-schedules.test.js` → FAILS (entries still present, because stopMonitoring doesn't remove them yet). If campaign.js import side-effects make the integration test infeasible, STOP and report — do not fake it; we'll find the right seam together.

---

### Task 2: Implement

**Files:** Modify `src/campaign.js` (inside `stopMonitoring`, after the `clearMonitoringState()` try/catch ~line 4063)

- [ ] **Step 1:** Add:
  ```js
  // v2.86.13: also remove this campaign's persisted post-campaign reply/bulk
  // schedules so the dashboard's "● Monitoring · N days" chip clears. The chip
  // reads these schedule files (server.js _monitoringForEntry), NOT in-memory
  // state — without this a stopped campaign keeps showing monitoring for ~7d.
  if (sheetId) {
    try { await removeReplySchedules(sheetId, participatingProfileIds); } catch { /* */ }
    try { await removeBulkSchedules(sheetId, participatingProfileIds); } catch { /* */ }
  }
  ```
  (`removeReplySchedules`/`removeBulkSchedules` are already imported in campaign.js — lines 39-40.)
- [ ] **Step 2:** Run the new test → PASS.
- [ ] **Step 3:** Full suite `node --test tests/*.test.js` → ALL pass (esp. existing monitoring/* + stop-monitoring tests). 0 fail.

---

### Task 3: Bump + commit + relaunch (orchestrator handles)
2.86.12 → 2.86.13; commit; relaunch if no campaign running.

## Constraints
- Off-limits: `src/linkedin/outreach.js`, `actions.js`, `src/profile-identity.js`. No status-string changes.
- Don't alter `stopCampaign`'s existing `full` removal — only add the missing removal in `stopMonitoring`.
