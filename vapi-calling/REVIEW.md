---
phase: code-review
reviewed: 2026-04-16T12:00:00Z
depth: standard
files_reviewed: 1
files_reviewed_list:
  - vapi-calling/Code.gs
findings:
  critical: 5
  warning: 8
  info: 7
  total: 20
status: issues_found
---

# VAPI Calling Code Review Report

**Reviewed:** 2026-04-16
**Depth:** standard
**Files Reviewed:** 1 (Code.gs, ~3000 lines)
**Status:** issues_found

## Summary

The script is a substantial Google Apps Script (~3000 lines) that orchestrates VAPI AI outbound calling, Gmail follow-ups, Twilio SMS, and multi-round campaign management. While functional, it has several critical bugs around concurrency and data consistency, security gaps in credential handling, and significant maintainability debt from duplicated code paths and dead debug functions.

The most urgent issues are: (1) race conditions in the webhook handler that can corrupt active call state, (2) the second-round calling bypass of the queue/concurrency system, and (3) header alias collisions that cause non-deterministic column mapping.

---

## Critical Issues

### CR-01: Race condition in doPost webhook -- no lock around active call map mutations

**File:** `Code.gs` (doPost function)
**Issue:** The `doPost` webhook handler reads the active calls map from ScriptProperties, removes a call, writes back, then triggers queue processing -- all without acquiring a lock. Two concurrent webhook callbacks (common when multiple calls end simultaneously) can read the same stale map and overwrite each other's deletions, leaving phantom "active" calls that block queue processing permanently.
**Fix:** Wrap the entire doPost body in a `LockService.getScriptLock()` with `tryLock(10000)`:
```javascript
function doPost(e) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    return ContentService.createTextOutput(JSON.stringify({ error: 'busy' }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  try {
    // ... existing doPost logic ...
  } finally {
    lock.releaseLock();
  }
}
```

### CR-02: startSecondRoundAutomatically_ bypasses queue and concurrency limits

**File:** `Code.gs` (startSecondRoundAutomatically_ function)
**Issue:** This function iterates eligible rows and calls `triggerVapiCall_` directly with `Utilities.sleep(1000)` between calls. It completely bypasses the queue system, ignoring the concurrency cap (typically 3-5 simultaneous calls). If 50 rows qualify for a second round, all 50 calls fire sequentially with no concurrency control, potentially hitting VAPI rate limits and exceeding Twilio concurrent call capacity.
**Fix:** Enqueue rows into the standard queue system instead of calling the API directly:
```javascript
// Instead of: triggerVapiCall_(row, sheetName, ...)
// Do: addToQueue_(sheetName, rowData)
// Then: processQueueForSheet_(sheetName)
```

### CR-03: Header alias collision -- "city" maps to both `location` and `event_city`

**File:** `Code.gs:88,100`
**Issue:** The alias `'city'` appears in both `location: ['location', 'city', 'region']` (line 88) and `event_city: ['event_city', 'event city', 'city']` (line 100). Similarly, `'region'` appears in both `location` and `event_area`. When a sheet has a column named "city", the resolved field depends on JavaScript object iteration order, which while deterministic in V8, is fragile and confusing. This can cause prospect location data to silently end up in event fields or vice versa.
**Fix:** Remove ambiguous aliases from one side. Since "city" alone more likely refers to the prospect's location, remove it from `event_city`:
```javascript
location: ['location', 'city', 'region'],
event_city: ['event_city', 'event city'],  // removed 'city'
event_area: ['event_area', 'event area', 'area'],  // removed 'region area' if ambiguous
```

### CR-04: Duplicate budget check with dead code between checks

**File:** `Code.gs` (processQueueForSheet_ function)
**Issue:** `isUnderBudget_()` is called twice before the main while loop. The code between the two checks (likely variable setup or logging) executes but is then gated again by a redundant budget check. This is a copy-paste error that wastes execution time and obscures the intended control flow. If the second check was meant to replace the first, the dead code between them may contain important setup that should run regardless.
**Fix:** Remove the duplicate check. Keep whichever check is at the correct position in the logic flow, and ensure any setup code between them is preserved outside the conditional.

### CR-05: No input validation on doPost webhook payload

**File:** `Code.gs` (doPost function)
**Issue:** The webhook parses `JSON.parse(e.postData.contents)` from external callers without validating the payload structure. A malformed or malicious payload (e.g., missing `call.id`, unexpected types) could cause the function to write garbage data to the sheet, throw unhandled exceptions that leave the lock unreleased, or corrupt the active calls map in ScriptProperties.
**Fix:** Add structural validation immediately after parsing:
```javascript
const payload = JSON.parse(e.postData.contents);
if (!payload || !payload.message || !payload.message.call || !payload.message.call.id) {
  return ContentService.createTextOutput(JSON.stringify({ error: 'invalid payload' }))
    .setMimeType(ContentService.MimeType.JSON);
}
```

---

## Warnings

### WR-01: Hardcoded VAPI phone number IDs in source code

**File:** `Code.gs:55-59`
**Issue:** The `VAPI_PHONE_NUMBERS` array contains production phone number UUIDs (`612a2ede-...`, `75651434-...`, `365601af-...`). These are resource identifiers that could be used to make unauthorized calls if exposed. Since this code is in a git repository, the IDs are permanently in version history.
**Fix:** Move phone number configuration to `PropertiesService.getScriptProperties()` or a protected `_Config` sheet. Load at runtime:
```javascript
function getPhoneNumbers_() {
  const raw = PropertiesService.getScriptProperties().getProperty('VAPI_PHONE_NUMBERS');
  return raw ? JSON.parse(raw) : [];
}
```

### WR-02: Hardcoded Google Sheet ID in logToProjectTagSheet_

**File:** `Code.gs` (logToProjectTagSheet_ function)
**Issue:** The sheet ID `1YsRylkQKuOevTuzoh2F9EuFTjwc_nh674Vm6XATe5tU` is hardcoded. This breaks if the log sheet is moved, shared, or cloned. It also leaks internal infrastructure details in the source.
**Fix:** Store the sheet ID in script properties:
```javascript
const LOG_SHEET_ID = PropertiesService.getScriptProperties().getProperty('PROJECT_TAG_SHEET_ID');
```

### WR-03: Email template injection -- no HTML sanitization in replaceTemplateVars_

**File:** `Code.gs` (replaceTemplateVars_ function)
**Issue:** Template variables like `{{prospect_name}}`, `{{company_name}}`, etc. are replaced directly into HTML email bodies without sanitization. If a prospect name contains HTML (e.g., `<script>alert('xss')</script>` or even just `<b>bold</b>`), it renders as live HTML in the recipient's email client. While this is a lower risk since the data comes from the operator's own sheet, imported lead lists from third parties could contain malicious content.
**Fix:** Add a simple HTML escape helper:
```javascript
function escapeHtml_(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
// Use in replaceTemplateVars_:
value = escapeHtml_(value);
```

### WR-04: Property storage size limits could be exceeded

**File:** `Code.gs` (queue storage via ScriptProperties)
**Issue:** Google Apps Script has a 9KB per-property-value limit. The queue arrays store full prospect data objects (name, email, company, all event fields, etc.) serialized as JSON. A campaign with 100+ rows, each having 20+ fields, will easily exceed 9KB and silently truncate or throw, corrupting the queue.
**Fix:** Store only row numbers in the queue, not full data objects. Read row data from the sheet at dequeue time:
```javascript
// Instead of: queue.push({ rowIndex: i, name: ..., phone: ..., ... })
// Do: queue.push(i)  // just the row number
// At dequeue: read row data fresh from the sheet
```

### WR-05: autoSortIfBatchComplete_ has no lock and reads/writes entire sheet

**File:** `Code.gs` (autoSortIfBatchComplete_ function)
**Issue:** This function reads the entire sheet, checks if all calls are done, then sorts and resizes. It has no lock, so two concurrent webhook completions can both trigger a sort simultaneously, potentially corrupting row order or causing "Service unavailable" errors from the Sheets API.
**Fix:** Acquire a lock before sorting, or use a property flag to ensure only one sort runs:
```javascript
const lock = LockService.getScriptLock();
if (!lock.tryLock(5000)) return;  // another sort is running
try { /* sort logic */ } finally { lock.releaseLock(); }
```

### WR-06: Watchdog trigger accumulation

**File:** `Code.gs` (startWatchdog_ / removeWatchdog_ functions)
**Issue:** `startWatchdog_()` creates a time-based trigger each time it is called (e.g., on every `vapiStartCallingNow`). `removeWatchdog_()` only runs when all queues are empty. If a campaign is started but crashes or is abandoned without completing, the watchdog trigger persists and fires indefinitely. Multiple abandoned campaigns create multiple triggers, all consuming execution quota.
**Fix:** Always remove existing watchdog triggers before creating a new one:
```javascript
function startWatchdog_() {
  removeWatchdog_();  // clean up any existing trigger first
  ScriptApp.newTrigger('watchdogCheck_')
    .timeBased().everyMinutes(1).create();
}
```

### WR-07: Two parallel campaign systems with duplicate logic

**File:** `Code.gs` (SECOND_ROUND_ and MULTI_ROUND_ systems)
**Issue:** The old `SECOND_ROUND_` system and the new `MULTI_ROUND_` system coexist with nearly identical logic for scheduling, monitoring, cancellation, and status tracking. Cancel functions check both systems. Monitor functions check both. This doubles the surface area for bugs -- a fix applied to one system may not be applied to the other.
**Fix:** Deprecate the `SECOND_ROUND_` system entirely. Migrate all callers to the `MULTI_ROUND_` system, which is a superset. Add a thin compatibility layer if any external triggers still reference the old property keys.

### WR-08: Typo in version header comment

**File:** `Code.gs:14`
**Issue:** The feature list says `heartbeatnp0` instead of `heartbeat`. While cosmetic, this suggests a typo during editing that was never caught, raising the question of whether similar typos exist in functional code.
**Fix:** Correct the comment:
```javascript
// * Execution monitoring & heartbeat
```

---

## Info

### IN-01: ~15 debug functions left in production code

**File:** `Code.gs` (various locations)
**Issue:** Functions like `debugHeaders`, `debugCallData`, `debugStatusColumn`, `debugAutoSort`, `debugPhoneColumn`, `countCells`, `test`, `manualAutoSort`, `testAutoSort`, `debugMultiRoundAssistants`, `debugRowRetryConfig`, `debugShowAllCampaignConfigs`, `debugLeaveVoicemailValue` are present. These clutter the Apps Script function dropdown menu, consume deployment size, and some may inadvertently expose internal data if triggered.
**Fix:** Move debug functions to a separate `Debug.gs` file, or delete them entirely and rely on version history if they are needed again.

### IN-02: Massive code duplication across batch start functions

**File:** `Code.gs` (vapiStartBatchWithConfig, vapiStartBatchWithConfigV2, vapiStartCallingNow, vapiStartMultiRoundNow)
**Issue:** Three or more "start batch" entry points share 80%+ identical logic (header parsing, row validation, queue building, config setup). Changes to shared logic must be replicated across all functions, which is error-prone.
**Fix:** Extract the common logic into a single `prepareBatch_(config)` helper. Each entry point becomes a thin wrapper that builds its config object and calls the shared helper.

### IN-03: ~400 lines of inline HTML in template literal

**File:** `Code.gs` (schedule dialog HTML)
**Issue:** The schedule/config dialog is built as a multi-hundred-line HTML string with embedded CSS and JavaScript inside a template literal. This prevents syntax highlighting, linting, and makes the dialog unmaintainable.
**Fix:** Move the HTML to a separate `.html` file and use `HtmlService.createHtmlOutputFromFile()`:
```javascript
function showScheduleDialog() {
  const html = HtmlService.createHtmlOutputFromFile('ScheduleDialog')
    .setWidth(500).setHeight(600);
  SpreadsheetApp.getUi().showModalDialog(html, 'Schedule Campaign');
}
```

### IN-04: Inconsistent function naming convention

**File:** `Code.gs` (throughout)
**Issue:** Private functions use a mix of `functionName_` (trailing underscore, GAS convention) and `camelCase` without underscore. Some clearly internal functions like `emergencyUnstick` lack the trailing underscore, making them visible in the script runner and potentially callable by users.
**Fix:** Adopt a consistent convention. In GAS, trailing underscore marks a function as private (hidden from the script runner). Apply `_` suffix to all internal functions.

### IN-05: var vs const/let inconsistency

**File:** `Code.gs` (scheduleAutoFollowup_, sendAutoFollowup_, and others)
**Issue:** Most of the codebase uses modern `const`/`let` declarations, but several functions still use `var`. This is not a bug on V8 runtime but creates inconsistency and risks accidental variable hoisting issues.
**Fix:** Replace remaining `var` declarations with `const` (preferred) or `let` where reassignment is needed.

### IN-06: Misleading comment about required columns

**File:** `Code.gs` (processQueueForSheet_ function)
**Issue:** A comment states "Reduced required columns - assistant and vapi_number no longer required" but the required columns array still includes fields that may not always be present, creating confusion about what is truly required vs. optional.
**Fix:** Update the comment to match the actual required array, or better, remove the comment and let the code be self-documenting with a clearly named constant.

### IN-07: ALLOWED_STATUSES Set vs array inconsistency

**File:** `Code.gs:46-48`
**Issue:** `ALLOWED_STATUSES` is a `Set` (line 46) while `AUTO_FOLLOWUP_TRIGGER_STATUSES` (line 47), `CALLBACK_WORTHY_STATUSES` (line 49), and `DO_NOT_CALL_AGAIN_STATUSES` (line 50) are arrays. They all serve the same purpose (membership testing) but use different data structures, requiring different lookup syntax (`.has()` vs `.includes()`).
**Fix:** Pick one approach. For small lists (<20 items), arrays with `.includes()` are fine and more familiar. For consistency, convert all to arrays or all to Sets.

---

_Reviewed: 2026-04-16_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
