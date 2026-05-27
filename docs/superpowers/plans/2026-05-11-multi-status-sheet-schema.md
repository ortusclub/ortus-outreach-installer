# Multi-Status Sheet Schema Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the single `Status` column into per-campaign-mode status columns (Connection / DM / OP / InM / Intro / Check Status), plus dynamic per-run column visibility, while preserving `Stage` as the workflow-state source of truth.

**Architecture:**
- Apps Script (`google-apps-script.js`) gains a new `prepareSheet` action that provisions only the columns relevant to the active campaign mode and hides every other mode's columns.
- `src/sheets-writer.js` gains a `prepareSheet` helper paralleling `ensureTrackingColumns`.
- `src/campaign.js` writebacks are refactored into a pure helper `buildSheetDataForAction(...)` that routes each `result.action` (and skip reason) to the correct mode-specific column AND mirrors to the always-visible `Status` column. The new helper is unit-tested. `Stage` writes don't change — pre-filter logic untouched.

**Tech Stack:** Google Apps Script (V8), Node.js (ES modules), node:test runner, puppeteer-core (no direct changes).

**Spec:** `docs/superpowers/specs/2026-05-11-multi-status-sheet-schema-design.md`

**Conventions:**
- Test runner: `npm test` runs `node --test tests/*.test.js`.
- After every commit on a code file, restart the Electron dev app per the project's auto-restart rule: `pkill -f "electron ." ; npm run dev:app &` (run from `~/ortus-gologin-clone`).
- All commits use the existing co-author trailer format (see `git log -1`).

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `google-apps-script.js` | Modify | Add `prepareSheet` handler, new column inventory + FIELD_MAP entries, formatting for new columns. Existing `ensureColumns` left intact for legacy sheets. |
| `src/sheets-writer.js` | Modify | Add `prepareSheet(sheetUrl, mode)` helper next to `ensureTrackingColumns`. |
| `src/campaign.js` | Modify | (1) Extract inline writebacks into pure helper `buildSheetDataForAction`. (2) Call `prepareSheet` instead of `ensureTrackingColumns` at campaign start. (3) Route skip reasons to mode-specific column. |
| `tests/build-sheet-data-for-action.test.js` | Create | Unit tests for the new pure helper covering every `result.action` branch + skip reasons across all 6 modes. |

The `Stage` writes and the pre-filter logic at `src/campaign.js:867–916` and `:1523–1577` are intentionally NOT touched.

---

## Column Inventory (locked from spec)

### Always-visible columns (provisioned by every mode)
`First Name`, `Last Name`, `LinkedIn URL`, `LinkedIn URN`, `LinkedIn Membership ID`, `Open Profile`, `Connected`, `Stage`, `Status`, `Sender`, `Date of Last Action`, `Time of Last Action`

### Mode-specific columns (added on first run of that mode)
| Mode | Columns added |
|---|---|
| `connect_only` | `Connection Status` |
| `check_status` | `Check Status` |
| `message_only` | `DM Status`, `Check Status` |
| `introduce_back` | `Intro Status`, `Check Status` |
| `open_profile_only` | `OP Status` |
| `inmail_only` | `InM Status` |

### Field-name → column-header map (new `sheetData` fields the bot will send)
| `sheetData` field | Column header |
|---|---|
| `stage` | `Stage` |
| `status` | `Status` |
| `sender` | `Sender` |
| `connectionStatus` | `Connection Status` |
| `dmStatus` | `DM Status` |
| `opStatus` | `OP Status` |
| `inmStatus` | `InM Status` |
| `introStatus` | `Intro Status` |
| `checkStatus` | `Check Status` |

Existing fields kept untouched in Apps Script: `linkedinUrn`, `linkedinMemberId`, `openProfile`, `connectedAlready`, `dateLastAction`, `accountUsed` (the old write path stays alive for legacy sheets that still use `ensureColumns`).

---

## Phase 1 — Apps Script: new schema + prepareSheet handler

### Task 1: Add new column inventory + FIELD_MAP entries

**Files:**
- Modify: `google-apps-script.js:30-45` (TRACKING_COLUMNS_V2 — new constant)
- Modify: `google-apps-script.js:65-73` (MODE_TRACKING_COLUMNS_V2 — new constant)
- Modify: `google-apps-script.js:102-122` (FIELD_MAP — extend)

- [ ] **Step 1: Add the v2 always-visible column constant**

After the existing `TRACKING_COLUMNS` array (around line 45), insert:

```javascript
// ── v2 schema (multi-status) ──
// Always-visible columns provisioned by every mode under prepareSheet.
var ALWAYS_VISIBLE_V2 = [
  'Stage',
  'Status',
  'Sender',
  'Date of Last Action',
  'Time of Last Action',
  'LinkedIn URN',
  'LinkedIn Membership ID',
  'Open Profile',
  'Connected'
];

// Per-mode columns added on top of ALWAYS_VISIBLE_V2 by prepareSheet.
var MODE_COLUMNS_V2 = {
  connect_only:      ['Connection Status'],
  check_status:      ['Check Status'],
  message_only:      ['DM Status', 'Check Status'],
  introduce_back:    ['Intro Status', 'Check Status'],
  open_profile_only: ['OP Status'],
  inmail_only:       ['InM Status']
};

// Every per-mode column across every mode — used to compute the "hide
// everything not in this run's set" list.
var ALL_MODE_COLUMNS_V2 = [
  'Connection Status', 'DM Status', 'OP Status',
  'InM Status', 'Intro Status', 'Check Status'
];
```

- [ ] **Step 2: Extend FIELD_MAP with the new field names**

Inside the existing `FIELD_MAP` object (lines 102–122), append BEFORE the `Reply:` entry:

```javascript
  // v2 multi-status fields. prepareSheet provisions these columns; writeFields
  // routes the bot's sheetData fields to the matching header. Old single-Status
  // field path (`status` → 'Connection Request Status') stays for legacy sheets.
  stage:             'Stage',
  sender:            'Sender',
  connectionStatus:  'Connection Status',
  dmStatus:          'DM Status',
  opStatus:          'OP Status',
  inmStatus:         'InM Status',
  introStatus:       'Intro Status',
  checkStatus:       'Check Status',
```

- [ ] **Step 3: Commit Apps Script schema additions**

```bash
git add google-apps-script.js
git commit -m "$(cat <<'EOF'
v2 sheet schema: declare always-visible + per-mode column constants and FIELD_MAP fields

Adds ALWAYS_VISIBLE_V2, MODE_COLUMNS_V2, ALL_MODE_COLUMNS_V2 alongside
the legacy TRACKING_COLUMNS. Extends FIELD_MAP with stage, sender, and
the six per-mode status fields. Existing ensureColumns handler untouched
— legacy sheets continue to work unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

No dev:app restart yet — server hasn't been wired to call any new path.

---

### Task 2: Implement `prepareSheet` action handler

**Files:**
- Modify: `google-apps-script.js:166-188` (doPost dispatcher — add case)
- Modify: `google-apps-script.js` (append new function `handlePrepareSheet` after the existing `handleEnsureColumns` block, around line 330)

- [ ] **Step 1: Add the dispatcher case**

Edit the switch in `doPost` (around line 167). Insert the new case BEFORE the `case 'ensureColumns':` line:

```javascript
      case 'prepareSheet':
        return handlePrepareSheet(sheet, data);

```

- [ ] **Step 2: Implement `handlePrepareSheet`**

Append this function immediately after `handleEnsureColumns` (the `}` that closes `handleEnsureColumns` is around line 328; insert below it, before `function migrateOldStatusValues`):

```javascript
// ═══════════════════════════════════════════════════════════════════════════
// Action: prepareSheet — v2 schema with per-mode column visibility
// ═══════════════════════════════════════════════════════════════════════════
// Idempotent. For data.mode:
//   1) Provisions any missing column in ALWAYS_VISIBLE_V2 ∪ MODE_COLUMNS_V2[mode].
//   2) Hides every column in ALL_MODE_COLUMNS_V2 that isn't in this mode's set.
//   3) Shows (un-hides) every column in this mode's set.
//   4) Re-applies conditional formatting to the new status columns.
// Returns { success, mode, added: [...], hidden: [...], shown: [...] }.

function handlePrepareSheet(sheet, data) {
  var modeKey = data && data.mode ? String(data.mode) : '';
  if (!MODE_COLUMNS_V2.hasOwnProperty(modeKey)) {
    return jsonResponse({
      error: 'Unknown mode for prepareSheet: ' + modeKey,
      errorCode: 'BAD_MODE'
    });
  }

  var thisModeCols = MODE_COLUMNS_V2[modeKey];
  var targetSet = ALWAYS_VISIBLE_V2.concat(thisModeCols);

  var headers = getHeaders(sheet);
  var added = [];

  // 1) Provision missing columns (always-visible first, then mode-specific).
  targetSet.forEach(function(col) {
    if (headers.indexOf(col) !== -1) return;
    var newPos = headers.length;
    sheet.getRange(1, newPos + 1).setValue(col).setFontWeight('bold');
    headers.push(col);
    added.push(col);
  });

  // 2) Compute hide/show lists. Any v2 mode column NOT in this mode's set
  // gets hidden (even if it has data from a prior run). Always-visible
  // columns stay visible. Operator columns (anything not in v2 inventory)
  // are untouched.
  var hidden = [];
  var shown = [];
  ALL_MODE_COLUMNS_V2.forEach(function(col) {
    var idx = headers.indexOf(col);
    if (idx === -1) return; // column not provisioned on this sheet — nothing to do
    if (thisModeCols.indexOf(col) !== -1) {
      sheet.showColumns(idx + 1);
      shown.push(col);
    } else {
      sheet.hideColumns(idx + 1);
      hidden.push(col);
    }
  });

  // Always-visible columns must always be shown (operator might have hidden
  // one manually — re-show under prepareSheet).
  ALWAYS_VISIBLE_V2.forEach(function(col) {
    var idx = headers.indexOf(col);
    if (idx !== -1) sheet.showColumns(idx + 1);
  });

  // 3) Re-apply conditional formatting to any newly-added per-mode status
  // columns. Same green/grey scheme used by applyStatusFormatting on the
  // legacy Status column.
  applyV2StatusFormatting(sheet, headers, thisModeCols);

  return jsonResponse({
    success: true,
    mode: modeKey,
    added: added,
    hidden: hidden,
    shown: shown
  });
}

// Apply success-green / skip-grey conditional formatting to each v2 status
// column. Idempotent — clears any prior rules on these column ranges and
// re-applies. Called from handlePrepareSheet so freshly-provisioned columns
// get formatting on first run.
function applyV2StatusFormatting(sheet, headers, thisModeCols) {
  if (!thisModeCols || thisModeCols.length === 0) return;
  var lastRow = Math.max(sheet.getLastRow(), 2);
  var existing = sheet.getConditionalFormatRules();
  var targetColIdxs = [];
  thisModeCols.forEach(function(col) {
    var idx = headers.indexOf(col);
    if (idx !== -1) targetColIdxs.push(idx + 1); // 1-based
  });

  // Drop any prior rules that touch our target columns; preserve others.
  var preserved = existing.filter(function(rule) {
    var ranges = rule.getRanges();
    for (var i = 0; i < ranges.length; i++) {
      if (targetColIdxs.indexOf(ranges[i].getColumn()) !== -1) return false;
    }
    return true;
  });

  // Build a rule pair (success-green and skip-grey) for each target column.
  var newRules = [];
  thisModeCols.forEach(function(col) {
    var idx = headers.indexOf(col);
    if (idx === -1) return;
    var range = sheet.getRange(2, idx + 1, lastRow - 1, 1);
    // "Sent" / "Done" / "Connected" / "Still Pending" / "Already Connected"
    // all share the success treatment. The skip rule is a formula because
    // skip values carry a free-text reason after the prefix.
    var successRule = SpreadsheetApp.newConditionalFormatRule()
      .whenTextDoesNotContain('Skipped:')
      .setBackground('#f0f9f1').setFontColor('#4a7a54')
      .setRanges([range]).build();
    var skipRule = SpreadsheetApp.newConditionalFormatRule()
      .whenTextStartsWith('Skipped:')
      .setBackground('#f5f5f5').setFontColor('#888888')
      .setRanges([range]).build();
    // Skip rule must be listed FIRST so it wins for "Skipped: …" values.
    newRules.push(skipRule, successRule);
  });

  sheet.setConditionalFormatRules(preserved.concat(newRules));
}
```

- [ ] **Step 3: Manual smoke test in Apps Script editor**

Open the Apps Script project in the browser → paste the updated file → run a manual test:

```javascript
// In the Apps Script editor, run this from a temporary function:
function testPrepareSheet_v2() {
  var ss = SpreadsheetApp.openById('TEST_SHEET_ID');  // a throwaway sheet
  var sheet = ss.getActiveSheet();
  var resp = handlePrepareSheet(sheet, { mode: 'message_only' });
  Logger.log(resp.getContent());
}
```

Expected log (JSON): `{ success: true, mode: 'message_only', added: [...], hidden: [...], shown: ['DM Status', 'Check Status'] }`. The throwaway sheet must show 11 columns visible (9 always-visible + DM Status + Check Status), with Connection/OP/InM/Intro Status hidden.

If this fails, fix the script in place and re-run before continuing.

- [ ] **Step 4: Commit the Apps Script handler**

```bash
git add google-apps-script.js
git commit -m "$(cat <<'EOF'
Apps Script: add prepareSheet action with per-mode column visibility

handlePrepareSheet provisions ALWAYS_VISIBLE_V2 + MODE_COLUMNS_V2[mode]
columns, hides every other mode's column, re-applies conditional
formatting on the active mode's status columns. Idempotent.

applyV2StatusFormatting wires success-green / skip-grey rules to each
new status column. Skip rule is whenTextStartsWith('Skipped:') because
skip values carry a free-text reason.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 2 — Bot: prepareSheet helper

### Task 3: Add `prepareSheet` to `src/sheets-writer.js`

**Files:**
- Modify: `src/sheets-writer.js:71-94` (add new function paralleling `ensureTrackingColumns`)

- [ ] **Step 1: Append the new helper after `ensureTrackingColumns`**

Find `ensureTrackingColumns` (line 71). Immediately after its closing `}` (line 94), insert:

```javascript
/**
 * v2 schema: provision per-mode columns and hide non-relevant mode columns.
 * Called once at campaign start (replaces ensureTrackingColumns for v2 sheets).
 *
 * @param {string} sheetUrl - any Google Sheet URL
 * @param {string} mode - one of connect_only | check_status | message_only |
 *                        introduce_back | open_profile_only | inmail_only
 * @returns {Promise<{ ok: boolean, added: string[], hidden: string[], shown: string[] }>}
 *          ok=true when the bridge confirmed the prepareSheet call.
 *          Returns { ok: false } silently if SHEETS_WEBAPP_URL isn't set so
 *          local-dev runs without bridge config continue to work.
 */
export async function prepareSheet(sheetUrl, mode) {
  if (!getWebAppUrl()) {
    console.log('[sheets-writer] No SHEETS_WEBAPP_URL configured — prepareSheet skipped');
    return { ok: false, added: [], hidden: [], shown: [] };
  }

  const sheetId = extractSheetId(sheetUrl);
  const gid = extractSheetGid(sheetUrl);
  console.log(`[sheets-writer] prepareSheet(${mode}) on sheet ${sheetId}…`);

  const result = await postToWebApp({
    action: 'prepareSheet',
    sheetId,
    gid: gid || '',
    mode: mode || ''
  });

  if (result?.success) {
    if (result.added?.length) {
      console.log(`[sheets-writer] ✓ prepareSheet added: ${result.added.join(', ')}`);
    }
    if (result.hidden?.length) {
      console.log(`[sheets-writer] ✓ prepareSheet hidden: ${result.hidden.join(', ')}`);
    }
    return { ok: true, added: result.added || [], hidden: result.hidden || [], shown: result.shown || [] };
  }

  if (result?.error) {
    console.warn(`[sheets-writer] prepareSheet failed: ${result.error}`);
  }
  return { ok: false, added: [], hidden: [], shown: [] };
}
```

- [ ] **Step 2: Verify the file parses**

```bash
node --check /Users/antoniovarlese/ortus-gologin-clone/src/sheets-writer.js
```

Expected: no output (success). If syntax error, fix in place.

- [ ] **Step 3: Commit the helper**

```bash
git add src/sheets-writer.js
git commit -m "$(cat <<'EOF'
sheets-writer: add prepareSheet helper for v2 multi-status schema

Mirrors ensureTrackingColumns shape. POSTs action=prepareSheet to the
Apps Script bridge with { sheetId, gid, mode }. Returns { ok, added,
hidden, shown } so callers can log diagnostics or surface a banner on
unexpected hides.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 4: Restart dev:app**

```bash
pkill -f "electron \." 2>/dev/null; sleep 1; cd /Users/antoniovarlese/ortus-gologin-clone && npm run dev:app &
```

---

## Phase 3 — Bot: extract pure writeback helper + tests

The current writebacks at `src/campaign.js:1772–1888` are inline inside the per-lead loop. To make them testable AND to centralize the new field-routing logic, we extract a pure function.

### Task 4: Extract `buildSheetDataForAction` helper

**Files:**
- Modify: `src/campaign.js` (add new exported helper near the top of the file's exports, immediately above `startCampaign`)

- [ ] **Step 1: Add the helper just before `startCampaign`**

Find the line `export async function startCampaign({` (around line 748). Immediately before it, insert:

```javascript
/**
 * Pure helper: builds the sheetData payload for a given outreach action result.
 * Routes the action to the right v2 mode-specific status column, mirrors the
 * latest action into `Status`, and writes Stage when applicable.
 *
 * @param {object} args
 * @param {string} args.action         - result.action ('connection_sent' | 'message_sent' | ...)
 * @param {string} args.mode           - active campaign mode
 * @param {string} args.profileName    - GoLogin profile display name (becomes Sender)
 * @param {string} args.hyperSent      - HYPERLINK formula for "Sent" label (or '')
 * @param {boolean} args.introMode     - tpl.introMode flag (relevant for message_sent)
 * @param {boolean} args.messageOpenProfiles - tpl flag (relevant for op_message_sent audit)
 * @param {number} [args.creditsLeft]  - inmail credits remaining (inmail_sent only)
 * @returns {object} sheetData         - keys consumed by Apps Script FIELD_MAP
 */
export function buildSheetDataForAction({
  action,
  mode,
  profileName = '',
  hyperSent = '',
  introMode = false,
  messageOpenProfiles = false,
  creditsLeft
}) {
  const out = { sender: profileName };

  switch (action) {
    case 'connection_sent':
      out.status            = 'Connection Request Sent';
      out.connectionStatus  = 'Connection Request Sent';
      out.stage             = 'Connect Pending';
      out.auditAction       = 'Connection sent';
      return out;

    case 'already_connected':
      out.status            = 'Already Connected';
      out.connectionStatus  = 'Already Connected';
      out.cc                = 'Connected';
      out.connectedAlready  = 'Yes';
      out.stage             = 'Connected';
      out.auditAction       = 'Already 1st-degree connection';
      return out;

    case 'message_sent':
      if (introMode && (mode === 'message_only' || mode === 'introduce_back')) {
        out.status      = 'IC Sent';
        out.introStatus = 'IC Sent';
        out.stage       = 'IC Sent';
      } else {
        out.status   = 'DM Sent';
        out.dmStatus = 'DM Sent';
        out.stage    = 'DM Sent';
      }
      out.message     = hyperSent;
      out.auditAction = 'Message sent';
      return out;

    case 'op_message_sent':
      // Legacy: Status mirrors 'DM Sent' for op_message_sent (preserved
      // from src/campaign.js:1841 for back-compat with sheet conditional
      // formatting rules that key on 'DM Sent').
      out.status     = 'DM Sent';
      out.opStatus   = 'OP Sent';
      out.op         = hyperSent;
      out.stage      = 'OP Sent';
      out.auditAction = (mode === 'connect_only' && messageOpenProfiles)
        ? 'Open Profile message sent (via connect mode)'
        : 'Open Profile message sent';
      return out;

    case 'inmail_sent':
      out.status     = 'Done';
      out.inmStatus  = 'InM Sent';
      out.inmail     = hyperSent;
      out.stage      = 'InM Sent';
      out.auditAction = 'InMail sent';
      if (typeof creditsLeft === 'number') {
        out.auditNotes = `InMail credits left: ${creditsLeft}`;
      }
      return out;

    case 'status_accepted':
      out.status           = 'Check Done.';
      out.checkStatus      = 'Connected';
      out.cc               = 'Connected';
      out.connectedAlready = 'Yes';
      out.stage            = 'Connected · DM Now';
      out.auditAction      = 'Acceptance confirmed';
      return out;

    case 'status_pending':
      // Stage left unchanged on pending (prior code: no stage write).
      out.checkStatus = 'Still Pending';
      out.auditAction = 'Check Status: still pending';
      return out;

    case 'already_processed': {
      // Stamp Stage per mode so empty-Stage rows don't stay empty after
      // a re-run. No status column write — the prior real action already
      // populated it.
      out.auditAction = 'Already in target state';
      if (mode === 'connect_only')          out.stage = 'Connect Pending';
      else if (mode === 'message_only')     out.stage = introMode ? 'IC Sent' : 'DM Sent';
      else if (mode === 'introduce_back')   out.stage = 'IC Sent';
      else if (mode === 'inmail_only')      out.stage = 'InM Sent';
      else if (mode === 'open_profile_only') out.stage = 'OP Sent';
      return out;
    }

    default:
      // Unknown action — return minimal payload so the caller can still
      // log audit info, no column writes.
      return out;
  }
}

/**
 * Pure helper: routes a normalized skip reason to the mode-specific column
 * + mirrors into Status + Stage. Used by every skip branch in the per-lead
 * loop so skip reasons land in the right place under the v2 schema.
 *
 * @param {string} mode             - active campaign mode
 * @param {string} normalizedReason - already passed through normalizeSkipReason()
 * @param {string} profileName      - sender label
 * @returns {object} sheetData
 */
export function buildSkipSheetData(mode, normalizedReason, profileName = '') {
  // normalizeSkipReason already produces "Skipped: <reason>" — Stage + Status
  // mirror that verbatim. The mode-specific column also receives the prefix
  // so the operator sees the skip reason in the column matching the campaign
  // they ran.
  const out = {
    sender: profileName,
    stage:  normalizedReason,
    status: normalizedReason
  };
  switch (mode) {
    case 'connect_only':       out.connectionStatus = normalizedReason; break;
    case 'check_status':       out.checkStatus      = normalizedReason; break;
    case 'message_only':       out.dmStatus         = normalizedReason; break;
    case 'introduce_back':     out.introStatus      = normalizedReason; break;
    case 'open_profile_only':  out.opStatus         = normalizedReason; break;
    case 'inmail_only':        out.inmStatus        = normalizedReason; break;
  }
  return out;
}
```

- [ ] **Step 2: Verify the file parses**

```bash
node --check /Users/antoniovarlese/ortus-gologin-clone/src/campaign.js
```

Expected: no output. If syntax error, fix in place.

- [ ] **Step 3: Commit the helper**

```bash
git add src/campaign.js
git commit -m "$(cat <<'EOF'
campaign: extract buildSheetDataForAction + buildSkipSheetData pure helpers

Centralizes v2 multi-status field routing. Each outreach result.action
maps to (1) Status (Latest Action mirror), (2) the mode-specific status
column, and (3) Stage when applicable. Skip helper mirrors the
normalized reason into the matching mode column.

Pure functions — no I/O, no side effects. Inline writebacks in the
per-lead loop will be migrated to use these in the next commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

No dev:app restart — helpers aren't wired yet.

---

### Task 5: Unit tests for the new helpers

**Files:**
- Create: `tests/build-sheet-data-for-action.test.js`

- [ ] **Step 1: Write the test file**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSheetDataForAction, buildSkipSheetData } from '../src/campaign.js';

// ── connection_sent ──
test('connection_sent: writes Connection Status + mirrors Status + Stage', () => {
  const r = buildSheetDataForAction({
    action: 'connection_sent',
    mode: 'connect_only',
    profileName: 'matt@ortus'
  });
  assert.equal(r.connectionStatus, 'Connection Request Sent');
  assert.equal(r.status, 'Connection Request Sent');
  assert.equal(r.stage, 'Connect Pending');
  assert.equal(r.sender, 'matt@ortus');
});

// ── already_connected ──
test('already_connected: marks Connected + flips connectedAlready', () => {
  const r = buildSheetDataForAction({
    action: 'already_connected',
    mode: 'connect_only',
    profileName: 'sam@ortus'
  });
  assert.equal(r.connectionStatus, 'Already Connected');
  assert.equal(r.cc, 'Connected');
  assert.equal(r.connectedAlready, 'Yes');
  assert.equal(r.stage, 'Connected');
});

// ── message_sent (plain DM) ──
test('message_sent without introMode: writes DM Status', () => {
  const r = buildSheetDataForAction({
    action: 'message_sent',
    mode: 'message_only',
    profileName: 'matt@ortus',
    hyperSent: '=HYPERLINK("x","Sent")',
    introMode: false
  });
  assert.equal(r.dmStatus, 'DM Sent');
  assert.equal(r.introStatus, undefined);
  assert.equal(r.status, 'DM Sent');
  assert.equal(r.stage, 'DM Sent');
  assert.equal(r.message, '=HYPERLINK("x","Sent")');
});

// ── message_sent (intro mode) ──
test('message_sent with introMode + message_only: writes Intro Status', () => {
  const r = buildSheetDataForAction({
    action: 'message_sent',
    mode: 'message_only',
    introMode: true
  });
  assert.equal(r.introStatus, 'IC Sent');
  assert.equal(r.dmStatus, undefined);
  assert.equal(r.status, 'IC Sent');
  assert.equal(r.stage, 'IC Sent');
});

test('message_sent with introMode + introduce_back: writes Intro Status', () => {
  const r = buildSheetDataForAction({
    action: 'message_sent',
    mode: 'introduce_back',
    introMode: true
  });
  assert.equal(r.introStatus, 'IC Sent');
  assert.equal(r.stage, 'IC Sent');
});

// ── op_message_sent ──
test('op_message_sent: writes OP Status, Status mirrors "DM Sent" (legacy)', () => {
  const r = buildSheetDataForAction({
    action: 'op_message_sent',
    mode: 'open_profile_only',
    hyperSent: '=HYPERLINK("x","Sent")'
  });
  assert.equal(r.opStatus, 'OP Sent');
  assert.equal(r.status, 'DM Sent');
  assert.equal(r.stage, 'OP Sent');
  assert.equal(r.op, '=HYPERLINK("x","Sent")');
});

test('op_message_sent inside connect_only with messageOpenProfiles: audit reflects it', () => {
  const r = buildSheetDataForAction({
    action: 'op_message_sent',
    mode: 'connect_only',
    messageOpenProfiles: true
  });
  assert.equal(r.auditAction, 'Open Profile message sent (via connect mode)');
});

// ── inmail_sent ──
test('inmail_sent: writes InM Status + credits note', () => {
  const r = buildSheetDataForAction({
    action: 'inmail_sent',
    mode: 'inmail_only',
    hyperSent: '=HYPERLINK("x","Sent")',
    creditsLeft: 3
  });
  assert.equal(r.inmStatus, 'InM Sent');
  assert.equal(r.status, 'Done');
  assert.equal(r.stage, 'InM Sent');
  assert.equal(r.auditNotes, 'InMail credits left: 3');
});

// ── status_accepted ──
test('status_accepted: writes Check Status + flips Stage to Connected · DM Now', () => {
  const r = buildSheetDataForAction({
    action: 'status_accepted',
    mode: 'check_status'
  });
  assert.equal(r.checkStatus, 'Connected');
  assert.equal(r.cc, 'Connected');
  assert.equal(r.connectedAlready, 'Yes');
  assert.equal(r.status, 'Check Done.');
  assert.equal(r.stage, 'Connected · DM Now');
});

// ── status_pending ──
test('status_pending: writes Check Status "Still Pending", no stage change', () => {
  const r = buildSheetDataForAction({
    action: 'status_pending',
    mode: 'check_status'
  });
  assert.equal(r.checkStatus, 'Still Pending');
  assert.equal(r.stage, undefined);
});

// ── already_processed (per-mode stage stamps) ──
test('already_processed connect_only → Stage = Connect Pending', () => {
  const r = buildSheetDataForAction({ action: 'already_processed', mode: 'connect_only' });
  assert.equal(r.stage, 'Connect Pending');
});
test('already_processed message_only + introMode → Stage = IC Sent', () => {
  const r = buildSheetDataForAction({ action: 'already_processed', mode: 'message_only', introMode: true });
  assert.equal(r.stage, 'IC Sent');
});
test('already_processed message_only without introMode → Stage = DM Sent', () => {
  const r = buildSheetDataForAction({ action: 'already_processed', mode: 'message_only' });
  assert.equal(r.stage, 'DM Sent');
});
test('already_processed inmail_only → Stage = InM Sent', () => {
  const r = buildSheetDataForAction({ action: 'already_processed', mode: 'inmail_only' });
  assert.equal(r.stage, 'InM Sent');
});

// ── unknown action ──
test('unknown action: returns sender-only payload', () => {
  const r = buildSheetDataForAction({ action: 'mystery', mode: 'connect_only', profileName: 'x@y' });
  assert.equal(r.sender, 'x@y');
  assert.equal(r.status, undefined);
  assert.equal(r.stage, undefined);
});

// ── buildSkipSheetData: routes by mode ──
test('skip in connect_only → Connection Status holds the reason', () => {
  const r = buildSkipSheetData('connect_only', 'Skipped: weekly invitation limit reached', 'a@b');
  assert.equal(r.connectionStatus, 'Skipped: weekly invitation limit reached');
  assert.equal(r.status, 'Skipped: weekly invitation limit reached');
  assert.equal(r.stage, 'Skipped: weekly invitation limit reached');
  assert.equal(r.sender, 'a@b');
});

test('skip in message_only → DM Status holds the reason', () => {
  const r = buildSkipSheetData('message_only', 'Skipped: not connected');
  assert.equal(r.dmStatus, 'Skipped: not connected');
  assert.equal(r.connectionStatus, undefined);
});

test('skip in introduce_back → Intro Status holds the reason', () => {
  const r = buildSkipSheetData('introduce_back', 'Skipped: send not confirmed');
  assert.equal(r.introStatus, 'Skipped: send not confirmed');
});

test('skip in open_profile_only → OP Status', () => {
  const r = buildSkipSheetData('open_profile_only', 'Skipped: Not Open Profile');
  assert.equal(r.opStatus, 'Skipped: Not Open Profile');
});

test('skip in inmail_only → InM Status', () => {
  const r = buildSkipSheetData('inmail_only', 'Skipped: InMail credits exhausted');
  assert.equal(r.inmStatus, 'Skipped: InMail credits exhausted');
});

test('skip in check_status → Check Status', () => {
  const r = buildSkipSheetData('check_status', 'Skipped: URL not found');
  assert.equal(r.checkStatus, 'Skipped: URL not found');
});
```

- [ ] **Step 2: Run the tests — expect all to PASS**

```bash
cd /Users/antoniovarlese/ortus-gologin-clone && npm test -- tests/build-sheet-data-for-action.test.js
```

Expected: every test passes. If any fails, fix the helper (not the test) until green.

- [ ] **Step 3: Run the full test suite to confirm no regressions**

```bash
cd /Users/antoniovarlese/ortus-gologin-clone && npm test 2>&1 | tail -30
```

Expected: existing tests pass unchanged. New file's tests are in the count.

- [ ] **Step 4: Commit the tests**

```bash
git add tests/build-sheet-data-for-action.test.js
git commit -m "$(cat <<'EOF'
test: cover buildSheetDataForAction + buildSkipSheetData across all modes

Covers every outreach action branch (connection_sent, already_connected,
message_sent ± introMode, op_message_sent, inmail_sent, status_accepted,
status_pending, already_processed per-mode stage stamps, unknown). Skip
helper tested across all 6 campaign modes.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 4 — Bot: wire helpers into the per-lead loop

### Task 6: Replace inline writebacks with the new helpers

**Files:**
- Modify: `src/campaign.js:1776-1888` (the per-action writeback block) and the skip branches at `:1981-2098`

- [ ] **Step 1: Read the current writeback block to confirm scope**

```bash
sed -n '1764,1890p' /Users/antoniovarlese/ortus-gologin-clone/src/campaign.js
```

Note the exact `if (result.action === ...)` chain. Each branch sets fields on `sheetData`. The replacement: call `buildSheetDataForAction(...)` once, merge its output into `sheetData`, then keep any post-branch code that captures `meta` (URN, member ID, OP, degree).

- [ ] **Step 2: Replace the action chain with a single call**

Locate the block starting `if (result.action === 'connection_sent') {` (around line 1776). Replace the entire chain (everything through the closing `}` of the `} else if (result.action === 'status_pending') {` branch, ending around line 1888 — the line BEFORE `// Check Status went two-state`) with:

```javascript
            // v2 multi-status: pure helper builds the field-routed payload.
            // Merge into sheetData so meta/sender/date fields from outer scope
            // are preserved.
            const built = buildSheetDataForAction({
              action: result.action,
              mode,
              profileName: pName,
              hyperSent,
              introMode: !!tpl.introMode,
              messageOpenProfiles,
              creditsLeft: typeof result.creditsLeft === 'number' ? result.creditsLeft : undefined
            });
            Object.assign(sheetData, built);

            // Capture profile meta on a fresh connection — same as before,
            // routed only for connection_sent.
            if (result.action === 'connection_sent') {
              try {
                const meta = await captureProfileMeta(page);
                if (meta.memberId)     sheetData.linkedinUrn       = meta.memberId;
                if (meta.memberNumber) sheetData.linkedinMemberId  = meta.memberNumber;
                if (meta.isOpenProfile !== null) sheetData.openProfile     = meta.isOpenProfile ? 'Yes' : 'No';
                if (meta.connectionDegree !== null) sheetData.connectedAlready = meta.connectionDegree === 1 ? 'Yes' : 'No';
              } catch { /* best-effort */ }
            } else if (result.action === 'already_connected') {
              // Synthetic action — meta arrives on result._meta from the
              // post-flight degree check. Apply if present.
              const meta = result._meta || {};
              if (meta.memberId)     sheetData.linkedinUrn      = meta.memberId;
              if (meta.memberNumber) sheetData.linkedinMemberId = meta.memberNumber;
              if (meta.isOpenProfile !== null && meta.isOpenProfile !== undefined) {
                sheetData.openProfile = meta.isOpenProfile ? 'Yes' : 'No';
              }
            } else if (result.action === 'inmail_sent') {
              // InMail credits side-effect: log + park profile when exhausted.
              if (typeof result.creditsLeft === 'number') {
                log(`  💳 InMail credits left: ${result.creditsLeft}`);
                if (result.creditsLeft <= 0) {
                  log(`  ⚠ ${pName} has 0 InMail credits — removing from InMail rotation.`);
                  weeklyLimited.add(profileId);
                  recordProfileEnd(profileId, pName, 'No InMail credits left');
                }
              }
            }
```

If your editor disagrees on bracket depth, run `node --check src/campaign.js` after each save to catch unmatched braces immediately.

- [ ] **Step 3: Migrate the skip branches to `buildSkipSheetData`**

The skip branches at `:1981-2098` each construct a `sheetData` object with `stage: normalizeSkipReason(...)`. Find each branch (search the file for `normalizeSkipReason(`) and replace the inline `{ ... stage: normalizeSkipReason(X) ... }` literal with:

```javascript
Object.assign(sheetData, buildSkipSheetData(mode, normalizeSkipReason('Weekly invitation limit reached'), pName));
```

Repeat for each skip case. Make sure the existing `auditAction` / `auditNotes` fields that are skip-specific are preserved alongside the helper merge — `buildSkipSheetData` doesn't set those, so they stay on the literal.

After each substitution, run:

```bash
node --check /Users/antoniovarlese/ortus-gologin-clone/src/campaign.js
```

- [ ] **Step 4: Run the full test suite**

```bash
cd /Users/antoniovarlese/ortus-gologin-clone && npm test 2>&1 | tail -30
```

Expected: all green, no regressions.

- [ ] **Step 5: Commit the migration**

```bash
git add src/campaign.js
git commit -m "$(cat <<'EOF'
campaign: route writebacks through buildSheetDataForAction + skip helper

Replaces the inline if/else chain at the per-lead loop's success branch
with a single buildSheetDataForAction call + meta capture. Skip branches
now route through buildSkipSheetData so each campaign's column receives
the right normalized reason. No behavioural change for the legacy
single-Status sheet path — Apps Script silently ignores unknown fields.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 6: Restart dev:app**

```bash
pkill -f "electron \." 2>/dev/null; sleep 1; cd /Users/antoniovarlese/ortus-gologin-clone && npm run dev:app &
```

---

### Task 7: Swap `ensureTrackingColumns` for `prepareSheet` at campaign start

**Files:**
- Modify: `src/campaign.js:28` (imports)
- Modify: `src/campaign.js:832-838` (the call site)

- [ ] **Step 1: Update the import**

Find line 28: `import { updateSheetRow, ensureTrackingColumns } from './sheets-writer.js';`

Replace with:

```javascript
import { updateSheetRow, ensureTrackingColumns, prepareSheet } from './sheets-writer.js';
```

- [ ] **Step 2: Replace the call site**

Find the existing block at line 832–838:

```javascript
    // Ensure tracking columns exist for THIS mode. Apps Script picks the
    // mode-specific subset (e.g. connect_only writes Connection Status / CC,
    // inmail_only writes Connection Status / InMail). Multi-mode sheets
    // accumulate columns across runs.
    await ensureTrackingColumns(sheetUrl, mode).catch(err => {
      log(`⚠ Could not ensure tracking columns: ${err.message}`);
    });
```

Replace with:

```javascript
    // v2 schema: prepareSheet provisions only this mode's columns and hides
    // every other mode's columns. Apps Script silently ignores prepareSheet
    // for legacy sheets that haven't been migrated (returns BAD_MODE only on
    // unknown modes — known modes always provision/hide). Fall back to the
    // legacy ensureTrackingColumns path when prepareSheet doesn't confirm
    // (e.g. SHEETS_WEBAPP_URL not set, or bridge not redeployed yet).
    const prep = await prepareSheet(sheetUrl, mode).catch(err => {
      log(`⚠ prepareSheet failed: ${err.message}`);
      return { ok: false };
    });
    if (!prep.ok) {
      log('  ⚠ prepareSheet didn\'t confirm — falling back to legacy ensureTrackingColumns');
      await ensureTrackingColumns(sheetUrl, mode).catch(err => {
        log(`⚠ Could not ensure tracking columns: ${err.message}`);
      });
    } else if (prep.hidden?.length) {
      log(`  ℹ Hidden columns from prior modes: ${prep.hidden.join(', ')}`);
    }
```

- [ ] **Step 3: Verify parse + run tests**

```bash
cd /Users/antoniovarlese/ortus-gologin-clone && node --check src/campaign.js && npm test 2>&1 | tail -20
```

Expected: parse clean, tests all pass.

- [ ] **Step 4: Commit the call site**

```bash
git add src/campaign.js
git commit -m "$(cat <<'EOF'
campaign: call prepareSheet at start, fall back to ensureTrackingColumns

prepareSheet provisions only the active mode's columns + hides every
other mode's columns. Legacy fallback keeps untouched sheets working
when the bridge hasn't been redeployed yet.

Logs hidden columns so the operator can see what was tucked away from
prior runs.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 5: Restart dev:app**

```bash
pkill -f "electron \." 2>/dev/null; sleep 1; cd /Users/antoniovarlese/ortus-gologin-clone && npm run dev:app &
```

---

## Phase 5 — Integration smoke test

### Task 8: End-to-end manual smoke

**Files:** None — manual verification.

Prerequisites:
- Apps Script: the updated `google-apps-script.js` has been pasted into Sam's deployed script and a new version published. Web App URL unchanged.
- A FRESH Google Sheet with 3–5 test rows (First Name, Last Name, LinkedIn URL columns only) shared with the deploying Google account.
- `SHEETS_WEBAPP_URL` env var set in the running dev:app.

- [ ] **Step 1: CC campaign provisioning check**

In the running Electron app:
1. Start a Connect Only campaign against the test sheet.
2. After launch, refresh the sheet in the browser.

Expected columns visible: First Name, Last Name, LinkedIn URL, **Stage**, **Status**, **Sender**, **LinkedIn URN**, **LinkedIn Membership ID**, **Open Profile**, **Connected**, **Date of Last Action**, **Time of Last Action**, **Connection Status**.

Expected NOT visible (no other mode has run yet): DM Status, OP Status, InM Status, Intro Status, Check Status.

Stop the campaign after one lead has been processed. Confirm `Connection Status` cell contains either `Connection Request Sent` or `Skipped: <reason>`. Confirm `Status` cell mirrors it.

- [ ] **Step 2: Add Message Only on top — visibility swap**

1. Start a Message Only campaign on the same sheet.
2. Refresh.

Expected: `DM Status` and `Check Status` columns now exist AND are visible. `Connection Status` is HIDDEN (but still contains the CC data from step 1 — un-hide manually to verify). Send a message to one lead and confirm `DM Status` = `DM Sent` (or skip text), `Status` mirrors it.

- [ ] **Step 3: Switch back to CC — re-show / re-hide**

1. Start another Connect Only campaign on the same sheet.

Expected: `Connection Status` re-shown, `DM Status` and `Check Status` hidden again.

- [ ] **Step 4: Confirm Stage pre-filter unchanged**

In dev:app console, watch the campaign start log line: `Fetching sheet…` followed by `N row(s). Columns: ...`. Confirm leads with `Stage = "Connect Pending"` are NOT re-processed by the CC campaign, and leads with `Stage = "Connected · DM Now"` ARE picked up by the Message Only campaign. Filter logic at `:872–916` is the source of truth — observed behavior should match what it was before the schema change.

- [ ] **Step 5: Record any deviations**

Append findings to the spec doc:

```bash
cat >> docs/superpowers/specs/2026-05-11-multi-status-sheet-schema-design.md <<'EOF'

## Smoke test results (YYYY-MM-DD)

- CC provisioning: PASS / FAIL — notes
- Message Only swap: PASS / FAIL — notes
- Re-switch to CC: PASS / FAIL — notes
- Stage filter unchanged: PASS / FAIL — notes
EOF
```

Fill in the dates and PASS/FAIL. Commit:

```bash
git add docs/superpowers/specs/2026-05-11-multi-status-sheet-schema-design.md
git commit -m "$(cat <<'EOF'
docs: record multi-status schema smoke test results

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 6 — Defer until Sam's Apps Script sign-off

These items don't ship until Sam reviews and re-deploys the Apps Script:

- [ ] **Step 1: Send Sam the updated `google-apps-script.js`** — link to the relevant commits + the new spec.
- [ ] **Step 2: After Sam deploys** — confirm the bridge URL hasn't changed (existing deployments keep their URL across new versions).
- [ ] **Step 3: Remove the `ensureTrackingColumns` fallback** in `src/campaign.js:Task 7 Step 2` once every sheet in use has been migrated to v2. Commit separately so it's easy to revert if a legacy sheet shows up later.

---

## Coverage check (vs. spec §"Writeback routing")

| Spec row | Plan task |
|---|---|
| `connection_sent` writeback | Task 4 helper + Task 5 test |
| `already_connected` writeback | Task 4 + Task 5 |
| `already_processed` (per-mode stage stamp) | Task 4 + Task 5 |
| `status_accepted` writeback | Task 4 + Task 5 |
| `status_pending` writeback | Task 4 + Task 5 |
| `message_sent` (DM + Intro variants) | Task 4 + Task 5 |
| `op_message_sent` writeback | Task 4 + Task 5 |
| `inmail_sent` writeback | Task 4 + Task 5 |
| Skip reasons routed to mode-specific column | Task 4 `buildSkipSheetData` + Task 5 + Task 6 step 3 |
| Stage never touched by this change | Task 6 step 2 (helper writes stage to same values current code does) + Task 8 step 4 (smoke verifies pre-filter) |
| `prepareSheet({ sheetId, mode })` Apps Script contract | Task 2 |
| App calls `prepareSheet` at campaign start | Task 7 |
| Apps Script ignores unknown modes gracefully | Task 2 returns `BAD_MODE`; Task 7 falls back to `ensureTrackingColumns` |
| Fresh sheet provisioning is additive | Task 2 — only ALWAYS_VISIBLE_V2 + this mode's MODE_COLUMNS_V2 added |
| Hide non-relevant mode columns | Task 2 step 2 |
| Conditional formatting on new columns | Task 2 `applyV2StatusFormatting` |
| No migration script needed | Plan assumes fresh sheet — Task 8 prerequisites state this explicitly |
| Stage + Status + Sender always visible | Task 2 — ALWAYS_VISIBLE_V2 includes all three; `ALWAYS_VISIBLE_V2.forEach showColumns` in handler |
| Risk: operator sees prior-mode data get hidden | Task 7 step 2 logs hidden columns so the operator sees what was tucked away |

All spec rows mapped to at least one task.
