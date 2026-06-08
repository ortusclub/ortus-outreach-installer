/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ORTUS LINKEDIN TRACKER — Google Apps Script
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Deploy this ONCE from your central Google Sheet:
 *   https://docs.google.com/spreadsheets/d/1YL-sa8OnMs-VwNKcIe75TrUdzFTvYKeezxX-RUuAeBM
 *
 * It will accept requests to update ANY Google Sheet your Google account
 * has edit access to. The target sheet ID is passed in each request.
 *
 * SETUP (one-time):
 *   1. Open the central sheet above
 *   2. Extensions → Apps Script
 *   3. Delete all existing code, paste this entire file
 *   4. Click Deploy → New Deployment
 *      - Type: Web app
 *      - Execute as: Me  (your Google account)
 *      - Who has access: Anyone
 *   5. Authorize when prompted (it needs permission to open other sheets)
 *   6. Copy the deployment URL
 *   7. Paste it into server.js:
 *      process.env.SHEETS_WEBAPP_URL = 'https://script.google.com/macros/s/YOUR_ID/exec';
 *
 * IMPORTANT: Your Google account must have edit access to every sheet
 * the campaign uses. For Ortus team sheets this should already be the case.
 * ═══════════════════════════════════════════════════════════════════════════
 */

// ── Tracking columns we manage (new schema) ──
var TRACKING_COLUMNS = [
  'Connection Request Status',
  'Connected Status',
  'OP',
  'Message',
  'InMail',
  'Account Used',
  'Date of Last Action',
  'Time of Last Action',
  // Phase 11.3 — Check DMs writeback columns. Non-destructive: updateRow
  // will not overwrite Reply="yes" if the operator manually edited the row.
  'Reply',
  'Reply At',
  'Reply Preview'
];

// ── v2 schema (multi-status) ──
// Always-PROVISIONED columns — every prepareSheet call ensures these exist.
// Three of these (Status / LinkedIn URN / LinkedIn Membership ID) are
// metadata: provisioned every run but hidden by default — the operator can
// unhide manually when they need to inspect.
var ALWAYS_PROVISIONED_V2 = [
  'Stage',
  'Last Action',
  'Sender',
  'Date of Last Action',
  'Time of Last Action',
  'LinkedIn URN',
  'LinkedIn Membership ID'
];

// Columns within ALWAYS_PROVISIONED_V2 (plus Connected) that prepareSheet
// hides on every run. Operator can unhide manually — they just don't show
// up by default. v2.14: 'Connected' moved here from MODE_COLUMNS_V2 — its
// boolean Yes/No is redundant with Connection Accepted Status's text value,
// but the bot still writes to it for downstream tooling.
var ALWAYS_HIDDEN_BY_DEFAULT_V2 = [
  'Last Action',
  'LinkedIn URN',
  'LinkedIn Membership ID',
  'Connected'
];

// v2.14: Pre-v2 column headers from the old `ensureColumns` schema. Every
// `prepareSheet` call hides these when found on the sheet — never deletes
// (preserves historical data per operator rule). Operator can unhide
// manually if they need to inspect old runs. 'Connected Status' is the v1
// name for the column that v2.14 renames to 'Connection Accepted Status' —
// COLUMN_RENAMES doesn't migrate it because hybrid sheets may have both;
// hiding the legacy one keeps the operator's primary view clean.
var LEGACY_COLUMNS_TO_HIDE_V2 = [
  'OP', 'Message', 'InMail', 'Account Used',
  'Reply', 'Reply At', 'Reply Preview',
  'Connected Status'
];

// Per-mode columns added on top of ALWAYS_PROVISIONED_V2 by prepareSheet.
// v2.14: header rename — Connection Status → Connection Request Status,
// Check Status → Connection Accepted Status. 'Connected' boolean dropped
// from every visible mode set (now ALWAYS_HIDDEN_BY_DEFAULT_V2).
// 'Open Profile' shows only during Open Profile mode.
var MODE_COLUMNS_V2 = {
  connect_only:      ['Connection Request Status'],
  check_status:      ['Connection Accepted Status'],
  message_only:      ['DM Status', 'Connection Accepted Status'],
  introduce_back:    ['Intro Status', 'Connection Accepted Status'],
  open_profile_only: ['OP Status', 'Open Profile'],
  inmail_only:       ['InM Status'],
  // Connect + Introduce Back: full cold-lead flow with three mode columns.
  // Auto-intro fires when bulk-check detects acceptance — Introduction
  // Status becomes the single source of truth for those rows (Connection
  // Accepted Status stays blank to avoid dual-stamping). Rows where
  // auto-intro doesn't fire (e.g. primary person missing) get the normal
  // Connection Accepted Status = 'Connected' stamp as fallback.
  connect_and_introduce: ['Connection Request Status',
                          'Connection Accepted Status',
                          'Introduction Status'],
  // v2.62: Connect + DM (CC+DM) — same connect-then-followup pipeline as
  // CC+IC but phase-2 stamps DM Status instead of Introduction Status.
  // Connection Accepted Status stays blank when the auto-DM fires (single
  // source of truth = DM Status); rows where auto-DM doesn't fire fall
  // back to the normal 'Connected' stamp.
  connect_and_message:   ['Connection Request Status',
                          'Connection Accepted Status',
                          'DM Status']
};

// Every per-mode column across every mode — used to compute the "hide
// everything not in this run's set" list. Open Profile joins this set so
// it's hidden when Open Profile mode isn't running. v2.14: 'Connected'
// removed (now ALWAYS_HIDDEN_BY_DEFAULT_V2); 'Connection Status' →
// 'Connection Request Status'; 'Check Status' → 'Connection Accepted
// Status'.
var ALL_MODE_COLUMNS_V2 = [
  'Connection Request Status', 'DM Status', 'OP Status',
  'InM Status', 'Intro Status', 'Connection Accepted Status',
  'Open Profile', 'Introduction Status'
];

// Column widths applied on every prepareSheet call. Universal map: any
// column on the sheet whose header matches a key here gets its width
// set; unknown columns (operator-added) are left untouched. Includes
// common operator-owned columns alongside bot-provisioned ones so a
// fresh Ortus sheet displays without "…" truncation by default.
var COLUMN_WIDTHS_V2 = {
  // Operator-owned columns commonly seen on Ortus sheets.
  'First Name': 100,
  'Last Name':  110,
  'linkedin url': 320,
  'LinkedIn URL': 320,

  // Always-provisioned bot columns (Stage + timing + sender).
  'Stage':               160,
  'Sender':              200,
  'Date of Last Action': 110,
  'Time of Last Action': 100,

  // Per-mode status columns. Widths chosen to fit the longest common
  // value without wrap (e.g. "Connection Request Sent", "Still Pending
  // (2026-05-17 11:46)"). Long-tail values may still wrap in Sheets if
  // the operator has wrap enabled.
  'Connection Request Status':  200,
  'Connection Accepted Status': 240,
  'DM Status':                  160,
  'OP Status':                  130,
  'InM Status':                 130,
  'Intro Status':               160,
  'Introduction Status':        180,
  'Open Profile':               140
};

// ── Status palette (legacy yellow / green / red / grey) ──
// Applied as conditional format rules to Stage + every per-mode status
// column on every prepareSheet call. Cells are bold + tinted bg + tinted
// fg so the eye lands on the status at a glance.
var STATE_PALETTE = {
  pending:   { bg: '#fff4d6', fg: '#8a5a00' }, // yellow — invite / DM in flight
  sent:      { bg: '#f0f9f1', fg: '#4a7a54' }, // light green — action completed
  connected: { bg: '#d9f1da', fg: '#0a6b27' }, // deep green — connection confirmed
  declined:  { bg: '#fce4e4', fg: '#a1252b' }, // red — decline / unreachable
  skipped:   { bg: '#f5f5f5', fg: '#888888' }  // grey — skipped rows
};

// Exact-match values painted by applyStatePaletteToColumns. Values that
// never appear in a given column are harmless — they simply never match.
// "Skipped:" is handled separately as a startsWith rule (skip reasons
// carry free-text after the prefix).
// v2.52.0: timestamped-suffix variants — prefix-matched via whenTextStartsWith
// so the same rule covers "Still Pending" + "Still Pending (2026-05-17 23:29)".
// Without this, cells with a timestamp suffix slipped through the exact-match
// rules below and rendered uncolored.
var STATE_STARTS_WITH = [
  { prefix: 'Still Pending',          state: 'pending' },
  // v2.57.x — Long-form Introduction Status failure values written by
  // auto-intro.js _friendlyIntroFailure(): "Failed — Compose page didn't
  // load", "Failed — Primary not in your connections", etc. Without this
  // prefix rule the bare-"Failed" exact-match below only colors the legacy
  // short value; the new explanatory variants slip through uncolored.
  // Centralized here so every operator's sheets pick it up via
  // prepareSheet — no per-sheet manual conditional-formatting setup needed.
  { prefix: 'Failed —',                state: 'declined' }
];

var STATE_VALUES = [
  // pending (yellow)
  { val: 'Connect Pending',            state: 'pending' },
  { val: 'Connection Request Sent',    state: 'pending' },
  { val: 'Not yet connected',          state: 'pending' },
  // sent (light green)
  { val: 'DM Sent',                    state: 'sent' },
  { val: 'IC Sent',                    state: 'sent' },
  { val: 'OP Sent',                    state: 'sent' },
  { val: 'InM Sent',                   state: 'sent' },
  { val: 'Sent',                       state: 'sent' },
  { val: 'Done',                       state: 'sent' },
  { val: 'Check Done.',                state: 'sent' },
  // connected (deep green)
  { val: 'Connected',                  state: 'connected' },
  { val: 'Connected · DM Now',         state: 'connected' },
  { val: 'Already Connected',          state: 'connected' },
  { val: 'Accepted',                   state: 'connected' },
  { val: 'Yes',                        state: 'connected' },
  { val: 'Introduction Made',          state: 'connected' },
  // v2.14.x: 'Introduction Already Made' uses the lighter 'sent' green to
  // visually distinguish "we found a pre-existing thread" from "we just
  // fired a new intro" — both are valid completions, the lighter tint
  // signals the no-action variant at a glance.
  { val: 'Introduction Already Made',  state: 'sent' },
  // declined (red)
  { val: 'Declined',                   state: 'declined' },
  { val: 'Unreachable',                state: 'declined' },
  { val: 'Not OP',                     state: 'declined' },
  { val: 'Not connectable',            state: 'declined' },
  { val: 'No',                         state: 'declined' },
  // skipped (grey) — terminal closure stamp written by stop-monitoring.js
  // when monitoring window expires without acceptance. Grouped with the
  // other "we're done with this row" greys (Skipped:, Skipped —).
  { val: 'Closed - Not Connected',     state: 'skipped' },
  // v2.14.x: 'Failed' appears in Introduction Status when a real LinkedIn-
  // side rejection happens (compose textbox didn't appear, recipient not
  // in typeahead results, etc.). Red mirrors how 'Declined' renders in CC.
  { val: 'Failed',                     state: 'declined' }
];

// Rename pairs — old header → new header. ensureColumns copies values from
// old to new before removing the old (see migrateColumnRenames + the new
// names being added to OLD_COLUMNS_TO_REMOVE below). v2.14: the existing
// 'Connection Status' → 'Connection Request Status' rename now also
// handles the v2 → v2.14 rename (idempotent). Added 'Check Status' →
// 'Connection Accepted Status' for the v2.14 rename. Existing v2 sheets
// auto-migrate values on first prepareSheet call after redeploy.
var COLUMN_RENAMES = [
  { from: 'Status',            to: 'Connection Request Status' },
  { from: 'Connection Status', to: 'Connection Request Status' },
  { from: 'Check Status',      to: 'Connection Accepted Status' },
  { from: 'CC',                to: 'Connected Status' },
  { from: 'Date',              to: 'Date of Last Action' },
  { from: 'Time',              to: 'Time of Last Action' },
  { from: 'Connected', to: 'Connected' },
];

// Mode-specific column subsets. ensureColumns picks the entry matching
// data.mode and adds only those columns. Columns from previous modes are
// NOT removed — running a second mode against the same sheet accumulates
// columns. Account Used carries the sender's email in every mode (Sender
// column dropped 2026-05-10 — info was redundant). Connected Status only
// appears in check_status mode (it's that mode's output).
var MODE_TRACKING_COLUMNS = {
  connect_only:              ['Connection Request Status', 'Account Used', 'Date of Last Action', 'Time of Last Action', 'LinkedIn URN', 'LinkedIn Membership ID', 'Open Profile', 'Connected'],
  connect_and_check_status:  ['Connection Request Status', 'Connected Status', 'Account Used', 'Date of Last Action', 'Time of Last Action', 'LinkedIn URN', 'LinkedIn Membership ID', 'Open Profile', 'Connected'],
  // Connect + Introduce Back uses the same column set as Connect + Check
  // Connection Status (it's that flow + an intro DM follow-up, with the
  // intro tracked elsewhere for now).
  connect_and_introduce:     ['Connection Request Status', 'Connected Status', 'Account Used', 'Date of Last Action', 'Time of Last Action', 'LinkedIn URN', 'LinkedIn Membership ID', 'Open Profile', 'Connected'],
  // v2.62: CC+DM uses the same tracking column set as CC+IC — it's the
  // same connect-then-followup flow, just with a 1:1 DM in phase 2.
  connect_and_message:       ['Connection Request Status', 'Connected Status', 'Account Used', 'Date of Last Action', 'Time of Last Action', 'LinkedIn URN', 'LinkedIn Membership ID', 'Open Profile', 'Connected'],
  message_only:              ['Connection Request Status', 'Message',  'Account Used', 'Date of Last Action', 'Time of Last Action'],
  inmail_only:               ['Connection Request Status', 'InMail',   'Account Used', 'Date of Last Action', 'Time of Last Action'],
  open_profile_only:         ['Connection Request Status', 'OP',       'Account Used', 'Date of Last Action', 'Time of Last Action'],
  check_status:              ['Connection Request Status', 'Connected Status', 'Account Used', 'Date of Last Action', 'Time of Last Action'],
  check_dms:                 ['Reply', 'Reply At', 'Reply Preview'],
};

// Action columns — get a dash "—" by default, HYPERLINK when the action happens.
var ACTION_COLUMNS = ['OP', 'Message', 'InMail'];

// Old tracking columns to REMOVE on ensureColumns (lossy cleanup)
var OLD_COLUMNS_TO_REMOVE = [
  'Connection Date',
  'Connection By',
  'First Message Status',
  'First Message Date',
  'Follow-up Status',
  'Follow-up Date',
  'InMail Credits Left',
  // Replaced by separate Date / Time of Last Action columns.
  'Date Last Action',
  // Renamed via COLUMN_RENAMES — values are migrated to the new names by
  // migrateColumnRenames() before these are deleted.
  'Status',
  'Connection Status',
  'CC',
  'Date',
  'Time',
  // Sender column dropped 2026-05-10 — Account Used carries the same info,
  // making Sender redundant.
  'Sender'
];

// ── Field name → Column header mapping ──
var FIELD_MAP = {
  status:          'Connection Request Status',
  cc:              'Connection Accepted Status',  // v2.14: was 'Connected Status'; bulk-check writes route here
  op:              'OP',
  message:         'Message',
  inmail:          'InMail',
  accountUsed:     'Account Used',
  linkedinUrn:     'LinkedIn URN',
  linkedinMemberId:'LinkedIn Membership ID',
  openProfile:     'Open Profile',
  connectedAlready:'Connected',  // legacy field name, new column header
  // 'sender' field intentionally omitted — column dropped 2026-05-10.
  // Bot may still send sheetData.sender (back-compat); writeFields ignores
  // unknown fields silently.
  // dateLastAction is handled specially in writeFields — split into
  // 'Date of Last Action' and 'Time of Last Action' instead of one cell.
  // v2 multi-status fields. prepareSheet provisions these columns; writeFields
  // routes the bot's sheetData fields to the matching header. Old single-Status
  // field path (`status` → 'Connection Request Status') stays for legacy sheets.
  stage:             'Stage',
  sender:            'Sender',
  // v2.14: connectionStatus → Connection Request Status, checkStatus →
  // Connection Accepted Status. Bot field names unchanged — only destination
  // column headers shift.
  connectionStatus:  'Connection Request Status',
  dmStatus:          'DM Status',
  opStatus:          'OP Status',
  inmStatus:         'InM Status',
  introStatus:       'Intro Status',
  checkStatus:       'Connection Accepted Status',
  introductionStatus:'Introduction Status',
  // Phase 11.3 — Check DMs writeback
  Reply:           'Reply',
  ReplyAt:         'Reply At',
  ReplyPreview:    'Reply Preview'
};

// ── URL column detection ──
var URL_COLUMN_NAMES = [
  'LinkedIn URL', 'linkedin_url', 'linkedinUrl', 'LinkedIn',
  'URL', 'url', 'Profile URL', 'profile_url', 'Link'
];

// ═══════════════════════════════════════════════════════════════════════════
// HTTP Handlers
// ═══════════════════════════════════════════════════════════════════════════

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);

    // Validate required field
    if (!data.sheetId) {
      return jsonResponse({ error: 'sheetId is required' });
    }

    // Open the TARGET sheet (not the central one)
    var spreadsheet = SpreadsheetApp.openById(data.sheetId);

    // Honor the operator's chosen tab when a gid is supplied (matches the
    // `#gid=` in the sheet URL the operator pasted). Falls back to the
    // active sheet for legacy payloads that don't include a gid, so existing
    // single-tab callers keep working unchanged.
    var sheet;
    if (data.gid !== undefined && data.gid !== null && data.gid !== '') {
      var allSheets = spreadsheet.getSheets();
      var match = null;
      for (var i = 0; i < allSheets.length; i++) {
        if (String(allSheets[i].getSheetId()) === String(data.gid)) {
          match = allSheets[i];
          break;
        }
      }
      sheet = match || spreadsheet.getActiveSheet();
    } else {
      sheet = spreadsheet.getActiveSheet();
    }

    // Route to the right handler
    switch (data.action) {
      case 'prepareSheet':
        return handlePrepareSheet(sheet, data);

      case 'ensureColumns':
        return handleEnsureColumns(sheet, data);

      case 'updateRow':
      default:
        return handleUpdateRow(sheet, data);

      case 'batchUpdate':
        return handleBatchUpdate(sheet, data);

      case 'getStatus':
        return handleGetStatus(sheet, data);

      case 'getSoO':
        return handleGetSoO(data);

      case 'writeRecentConnections':
        return handleWriteRecentConnections(spreadsheet, data);

      case 'clearRecentConnections':
        return handleClearRecentConnections(spreadsheet, data);

      case 'writeRecentMessages':
        return handleWriteRecentMessages(spreadsheet, data);

      case 'getRowStatus':
        return handleGetRowStatus(sheet, data);
    }

  } catch (err) {
    return jsonResponse({ error: err.message, stack: err.stack });
  }
}

function doGet(e) {
  // Quick health check — also verifies the script is deployed
  return jsonResponse({
    status: 'ok',
    service: 'Ortus LinkedIn Tracker',
    deployed: new Date().toISOString(),
    usage: 'POST with { sheetId, action, ... }'
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Action: Ensure tracking columns exist
// ═══════════════════════════════════════════════════════════════════════════

function handleEnsureColumns(sheet, data) {
  var headers = getHeaders(sheet);
  var added = [];
  var removed = [];
  var migrated = [];

  // Pick the column set: mode-specific subset if data.mode is recognised,
  // otherwise fall back to the full TRACKING_COLUMNS list (back-compat with
  // callers that don't pass mode).
  var modeKey = data && data.mode ? String(data.mode) : '';
  var columnsForThisRun = MODE_TRACKING_COLUMNS[modeKey] || TRACKING_COLUMNS;

  // 0) Migration — copy values from any old column header into its renamed
  // counterpart BEFORE the OLD_COLUMNS_TO_REMOVE pass deletes the old name.
  // Only runs when the new column doesn't already exist (idempotent).
  COLUMN_RENAMES.forEach(function(r) {
    var fromIdx = headers.indexOf(r.from);
    if (fromIdx === -1) return;
    if (headers.indexOf(r.to) !== -1) return;
    var lastRowMig = sheet.getLastRow();
    sheet.insertColumnAfter(fromIdx + 1);
    sheet.getRange(1, fromIdx + 2).setValue(r.to).setFontWeight('bold');
    if (lastRowMig >= 2) {
      var oldVals = sheet.getRange(2, fromIdx + 1, lastRowMig - 1, 1).getValues();
      sheet.getRange(2, fromIdx + 2, lastRowMig - 1, 1).setValues(oldVals);
    }
    headers.splice(fromIdx + 1, 0, r.to);
    migrated.push(r.from + ' → ' + r.to);
  });

  // 1) Remove old tracking columns (iterate right → left so indices stay valid)
  for (var i = headers.length - 1; i >= 0; i--) {
    if (OLD_COLUMNS_TO_REMOVE.indexOf(headers[i]) !== -1) {
      sheet.deleteColumn(i + 1);
      removed.push(headers[i]);
      headers.splice(i, 1);
    }
  }

  // 2) Add missing tracking columns for THIS mode. Existing columns from
  // previous modes are preserved (so multi-mode sheets accumulate columns).
  // Order on the sheet follows columnsForThisRun — each new column is
  // inserted right after the nearest preceding sibling already on the sheet.
  columnsForThisRun.forEach(function(col, idx) {
    if (headers.indexOf(col) !== -1) return;

    var insertAfter = -1;
    for (var k = idx - 1; k >= 0; k--) {
      var prevIdx = headers.indexOf(columnsForThisRun[k]);
      if (prevIdx !== -1) { insertAfter = prevIdx; break; }
    }

    var newPos;
    if (insertAfter === -1) {
      newPos = headers.length;
      sheet.getRange(1, newPos + 1).setValue(col);
    } else {
      sheet.insertColumnAfter(insertAfter + 1);
      newPos = insertAfter + 1;
      sheet.getRange(1, newPos + 1).setValue(col);
    }
    sheet.getRange(1, newPos + 1).setFontWeight('bold');
    headers.splice(newPos, 0, col);
    added.push(col);
  });

  // 2.5) Reorder tracking columns so they sit at the end of the sheet
  // in the canonical order defined by columnsForThisRun. Operator columns
  // (anything not in columnsForThisRun) keep their original positions at
  // the front. Iteration order matters: walking columnsForThisRun in order
  // and moving each to the end leaves them in the correct relative order
  // because subsequent moves push them back.
  columnsForThisRun.forEach(function(col) {
    var hdrs = getHeaders(sheet);
    var idx = hdrs.indexOf(col);
    if (idx === -1) return;
    var lastCol = sheet.getLastColumn();
    if (idx + 1 === lastCol) return; // already at the end
    var sourceRange = sheet.getRange(1, idx + 1, sheet.getMaxRows(), 1);
    sheet.moveColumns(sourceRange, lastCol + 1);
  });
  // Refresh local headers cache after the reorder dance.
  headers = getHeaders(sheet);

  var lastRow = sheet.getLastRow();

  // 3) Dash-fill empty cells in action columns
  if (lastRow >= 2) {
    ACTION_COLUMNS.forEach(function(col) {
      var idx = headers.indexOf(col);
      if (idx === -1) return;
      var range = sheet.getRange(2, idx + 1, lastRow - 1, 1);
      var values = range.getValues();
      for (var r = 0; r < values.length; r++) {
        var cur = (values[r][0] || '').toString().trim();
        if (cur === '') values[r][0] = '—';
      }
      range.setValues(values);
    });
  }

  // 4) One-time migration — map old Status vocabulary into the new
  // Status (Done/Skipped) + CC (Sent/Accepted/Declined/Unreachable) scheme.
  // Idempotent: rows already using the new vocab stay as-is.
  if (lastRow >= 2 && headers.indexOf('CC') !== -1) {
    migrateOldStatusValues(sheet, headers, lastRow);
  }

  // 5) Conditional formatting
  applyStatusFormatting(sheet, headers);
  applyCCFormatting(sheet, headers);

  return jsonResponse({
    success: true,
    headers: headers,
    added: added,
    removed: removed,
    message: 'ensureColumns complete. added=[' + added.join(', ') + '] removed=[' + removed.join(', ') + ']'
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Action: prepareSheet — v2 schema with per-mode column visibility
// ═══════════════════════════════════════════════════════════════════════════
// Idempotent. For data.mode:
//   1) Provisions any missing column in ALWAYS_PROVISIONED_V2 ∪ MODE_COLUMNS_V2[mode].
//   2) Hides every column in ALL_MODE_COLUMNS_V2 that isn't in this mode's set.
//   3) Shows (un-hides) every column in this mode's set.
//   4) Hides every column in ALWAYS_HIDDEN_BY_DEFAULT_V2 (metadata like
//      Status mirror, URN, Membership ID — operator unhides manually).
//   5) Re-applies conditional formatting to the new status columns.
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
  var targetSet = ALWAYS_PROVISIONED_V2.concat(thisModeCols);

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

  // Always-provisioned columns minus the by-default-hidden ones must always
  // be shown (operator might have hidden one manually — re-show under
  // prepareSheet).
  ALWAYS_PROVISIONED_V2.forEach(function(col) {
    if (ALWAYS_HIDDEN_BY_DEFAULT_V2.indexOf(col) !== -1) return;
    var idx = headers.indexOf(col);
    if (idx !== -1) sheet.showColumns(idx + 1);
  });

  // 3) Hide always-provisioned metadata columns (Status mirror, URN,
  // Membership ID, Connected). Provisioned so the bot can write to them,
  // hidden so the operator sees a clean primary view. Push them onto
  // `hidden` so the caller's log surfaces them.
  ALWAYS_HIDDEN_BY_DEFAULT_V2.forEach(function(col) {
    var idx = headers.indexOf(col);
    if (idx === -1) return;
    sheet.hideColumns(idx + 1);
    if (hidden.indexOf(col) === -1) hidden.push(col);
  });

  // 4) v2.14: hide pre-v2 legacy columns from older `ensureColumns` runs
  // (OP, Message, InMail, Account Used, Reply, Reply At, Reply Preview).
  // Never deletes — preserves historical data. Operator can unhide manually.
  LEGACY_COLUMNS_TO_HIDE_V2.forEach(function(col) {
    var idx = headers.indexOf(col);
    if (idx === -1) return;
    sheet.hideColumns(idx + 1);
    if (hidden.indexOf(col) === -1) hidden.push(col);
  });

  // 5) Re-apply conditional formatting. Stage + every per-mode status
  // column get the full state palette (yellow / green / red / grey, bold).
  applyStatePaletteToColumns(sheet, headers, ['Stage'].concat(thisModeCols));

  // 5) Bold + tint the header row so it reads as a header band. Freeze
  // it so it stays put when the operator scrolls.
  if (headers.length > 0) {
    sheet.getRange(1, 1, 1, headers.length)
      .setFontWeight('bold')
      .setBackground('#f1f3f4');
    if (sheet.getFrozenRows() < 1) sheet.setFrozenRows(1);
  }

  // 6) Set column widths from COLUMN_WIDTHS_V2. Kills "…" truncation on
  // common columns (Stage, Sender, status text, LinkedIn URL). Idempotent:
  // every prepareSheet call resets widths to the map values. Columns
  // whose header is not in the map keep their existing width.
  Object.keys(COLUMN_WIDTHS_V2).forEach(function(col) {
    var idx = headers.indexOf(col);
    if (idx === -1) return;
    sheet.setColumnWidth(idx + 1, COLUMN_WIDTHS_V2[col]);
  });

  return jsonResponse({
    success: true,
    mode: modeKey,
    added: added,
    hidden: hidden,
    shown: shown
  });
}

// Apply the full state palette (yellow / green / red / grey, bold) to a
// set of columns. Used by handlePrepareSheet to style Stage + every
// per-mode status column. Idempotent — clears existing rules on these
// columns first. Each rule paints one value across ALL target columns at
// once (multi-range), which keeps the rule count low (~21 rules total).
function applyStatePaletteToColumns(sheet, headers, columnNames) {
  if (!columnNames || columnNames.length === 0) return;
  var lastRow = Math.max(sheet.getLastRow(), 2);

  var ranges = [];
  var targetColIdxs = [];
  columnNames.forEach(function(col) {
    var idx = headers.indexOf(col);
    if (idx === -1) return;
    ranges.push(sheet.getRange(2, idx + 1, lastRow - 1, 1));
    targetColIdxs.push(idx + 1);
  });
  if (ranges.length === 0) return;

  // Drop any prior rules that touch our target columns; preserve others.
  var existing = sheet.getConditionalFormatRules();
  var preserved = existing.filter(function(rule) {
    var ruleRanges = rule.getRanges();
    for (var i = 0; i < ruleRanges.length; i++) {
      if (targetColIdxs.indexOf(ruleRanges[i].getColumn()) !== -1) return false;
    }
    return true;
  });

  var newRules = [];
  // Skip rule FIRST so it wins for "Skipped: …" values (which carry a
  // free-text reason after the prefix). Two variants: the colon form is
  // the legacy reason format ("Skipped: URL not found"); the em-dash form
  // is what Introduction Status uses for the v2.14.x interrupted-intro
  // stamps ("Skipped — Stop pressed", "Skipped — browser closed"). Both
  // get the same grey palette so the eye reads them as the same class.
  var skipPal = STATE_PALETTE.skipped;
  newRules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenTextStartsWith('Skipped:')
    .setBackground(skipPal.bg)
    .setFontColor(skipPal.fg)
    .setBold(true)
    .setRanges(ranges)
    .build());
  newRules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenTextStartsWith('Skipped —')
    .setBackground(skipPal.bg)
    .setFontColor(skipPal.fg)
    .setBold(true)
    .setRanges(ranges)
    .build());

  // One exact-match rule per value. Listed AFTER the skip rule so skip
  // always wins for "Skipped: <reason>" cells.
  STATE_VALUES.forEach(function(r) {
    var pal = STATE_PALETTE[r.state];
    if (!pal) return;
    newRules.push(SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo(r.val)
      .setBackground(pal.bg)
      .setFontColor(pal.fg)
      .setBold(true)
      .setRanges(ranges)
      .build());
  });

  // v2.52.0: prefix-matched rules for values whose suffix varies at write
  // time (e.g. "Still Pending (2026-05-17 23:29)" from bulk-check). Without
  // these, the timestamped variants slipped through the exact-match rules
  // above and rendered uncolored.
  STATE_STARTS_WITH.forEach(function(r) {
    var pal = STATE_PALETTE[r.state];
    if (!pal) return;
    newRules.push(SpreadsheetApp.newConditionalFormatRule()
      .whenTextStartsWith(r.prefix)
      .setBackground(pal.bg)
      .setFontColor(pal.fg)
      .setBold(true)
      .setRanges(ranges)
      .build());
  });

  sheet.setConditionalFormatRules(preserved.concat(newRules));
}

function migrateOldStatusValues(sheet, headers, lastRow) {
  var statusIdx = headers.indexOf('Status');
  var ccIdx = headers.indexOf('CC');
  if (statusIdx === -1 || ccIdx === -1) return;

  var statusRange = sheet.getRange(2, statusIdx + 1, lastRow - 1, 1);
  var ccRange = sheet.getRange(2, ccIdx + 1, lastRow - 1, 1);
  var statusVals = statusRange.getValues();
  var ccVals = ccRange.getValues();

  // Old Status → { new Status, CC to set if CC cell is still empty }
  var map = {
    'invite pending':    { status: 'Done',    cc: 'Sent' },
    'connected':         { status: 'Done',    cc: '' },
    'declined':          { status: 'Done',    cc: 'Declined' },
    'not connectable':   { status: 'Done',    cc: 'Unreachable' },
    'not yet connected': { status: 'Skipped', cc: '' },
    'weekly limit':      { status: 'Skipped', cc: '' },
    'error':             { status: 'Skipped', cc: '' },
    'inmail sent':       { status: 'Done',    cc: '' }
  };

  var changed = false;
  for (var r = 0; r < statusVals.length; r++) {
    var cur = (statusVals[r][0] || '').toString().toLowerCase().trim();
    var m = map[cur];
    if (!m) continue;
    statusVals[r][0] = m.status;
    if (m.cc && !(ccVals[r][0] || '').toString().trim()) {
      ccVals[r][0] = m.cc;
    }
    changed = true;
  }

  if (changed) {
    statusRange.setValues(statusVals);
    ccRange.setValues(ccVals);
  }
}

function applyStatusFormatting(sheet, headers) {
  var statusIdx = headers.indexOf('Connection Request Status');
  if (statusIdx === -1) statusIdx = headers.indexOf('Connection Status'); // back-compat
  if (statusIdx === -1) statusIdx = headers.indexOf('Status'); // back-compat
  if (statusIdx === -1) return;
  var lastRow = Math.max(sheet.getLastRow(), 2);
  var range = sheet.getRange(2, statusIdx + 1, lastRow - 1, 1);

  // Remove existing rules that touch this column, then re-apply ours.
  var existing = sheet.getConditionalFormatRules();
  var others = existing.filter(function(rule) {
    var ranges = rule.getRanges();
    for (var i = 0; i < ranges.length; i++) {
      if (ranges[i].getColumn() === statusIdx + 1) return false;
    }
    return true;
  });

  // Light, unobtrusive colors — Status is informational now. CC carries
  // the loud gradient (yellow/green/red).
  var rules = [
    { val: 'Done',    bg: '#f0f9f1', fg: '#4a7a54' },
    { val: 'Skipped', bg: '#f5f5f5', fg: '#888888' }
  ].map(function(r) {
    return SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo(r.val)
      .setBackground(r.bg)
      .setFontColor(r.fg)
      .setRanges([range])
      .build();
  });

  sheet.setConditionalFormatRules(others.concat(rules));
}

function applyCCFormatting(sheet, headers) {
  var ccIdx = headers.indexOf('CC');
  if (ccIdx === -1) return;
  var lastRow = Math.max(sheet.getLastRow(), 2);
  var range = sheet.getRange(2, ccIdx + 1, lastRow - 1, 1);

  var existing = sheet.getConditionalFormatRules();
  var others = existing.filter(function(rule) {
    var ranges = rule.getRanges();
    for (var i = 0; i < ranges.length; i++) {
      if (ranges[i].getColumn() === ccIdx + 1) return false;
    }
    return true;
  });

  // Rules evaluate top-to-bottom; first match wins. We list the exact-text
  // status labels FIRST so they take precedence, then a formula-based rule
  // catches any other non-blank value (sender-name labels written by the
  // app since 2.8.10) and treats it as "invite pending" yellow.
  var ccColLetter = columnToLetter(ccIdx + 1);
  var firstCellA1 = ccColLetter + '2';

  var exactRules = [
    { val: 'Accepted',    bg: '#d9f1da', fg: '#0a6b27' }, // green  — connection confirmed
    { val: 'Declined',    bg: '#fce4e4', fg: '#a1252b' }, // red    — invite declined
    { val: 'Unreachable', bg: '#fce4e4', fg: '#a1252b' }, // red    — couldn't send invite
    { val: 'Sent',        bg: '#fff4d6', fg: '#8a5a00' }  // yellow — legacy "Sent" rows
  ].map(function(r) {
    return SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo(r.val)
      .setBackground(r.bg)
      .setFontColor(r.fg)
      .setRanges([range])
      .build();
  });

  // Catch-all: any non-blank value that wasn't matched by the exact rules
  // above (e.g. "matt.adcock@ortus.solutions") = invite pending = yellow.
  // The "—" placeholder rendered into untouched action cells is excluded.
  var pendingFormula = '=AND(' + firstCellA1 + '<>"", ' + firstCellA1 + '<>"—")';
  var pendingRule = SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied(pendingFormula)
    .setBackground('#fff4d6')
    .setFontColor('#8a5a00')
    .setRanges([range])
    .build();

  sheet.setConditionalFormatRules(others.concat(exactRules).concat([pendingRule]));
}

// Convert 1-based column index to A1 letter ("A", "B", … "AA", "AB" …).
function columnToLetter(n) {
  var s = '';
  while (n > 0) {
    var r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// ═══════════════════════════════════════════════════════════════════════════
// Action: Update a single row
// ═══════════════════════════════════════════════════════════════════════════

function handleUpdateRow(sheet, data) {
  if (!data.linkedinUrl) {
    return jsonResponse({ error: 'linkedinUrl is required' });
  }

  var headers = getHeaders(sheet);

  // If caller specified which column to search, use that directly
  var urlColIndex = -1;
  if (data.urlColumnName) {
    for (var i = 0; i < headers.length; i++) {
      if (headers[i] === data.urlColumnName) { urlColIndex = i; break; }
    }
  }
  // Fallback to auto-detection
  if (urlColIndex === -1) {
    urlColIndex = findUrlColumn(headers, sheet);
  }

  if (urlColIndex === -1) {
    return jsonResponse({ error: 'No LinkedIn URL column found in the sheet' });
  }

  // Try exact match first, then loose match (contains the linkedin.com/in/ slug)
  var targetRow = findRowByUrl(sheet, urlColIndex, data.linkedinUrl);

  if (targetRow === -1) {
    // Loose match: extract the slug from the search URL and match against cell values
    var slugMatch = data.linkedinUrl.match(/linkedin\.com\/in\/([^/?#]+)/i);
    if (slugMatch) {
      var slug = slugMatch[1].toLowerCase();
      var lastRow = sheet.getLastRow();
      if (lastRow >= 2) {
        var allVals = sheet.getRange(2, urlColIndex + 1, lastRow - 1, 1).getValues();
        for (var r = 0; r < allVals.length; r++) {
          var cellVal = (allVals[r][0] || '').toString().toLowerCase();
          if (cellVal.indexOf(slug) !== -1) { targetRow = r + 2; break; }
        }
      }
    }
  }

  if (targetRow === -1) {
    return jsonResponse({ error: 'Row not found for: ' + data.linkedinUrl });
  }

  var updated = writeFields(sheet, headers, targetRow, data);

  return jsonResponse({
    success: true,
    sheetId: data.sheetId,
    row: targetRow,
    updated: updated
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Action: Batch update multiple rows at once
// ═══════════════════════════════════════════════════════════════════════════
// Expects data.updates = [{ linkedinUrl, connectionStatus, ... }, ...]
// More efficient than individual calls — one sheet open, one URL column scan.

function handleBatchUpdate(sheet, data) {
  if (!data.updates || !data.updates.length) {
    return jsonResponse({ error: 'updates array is required' });
  }

  var headers = getHeaders(sheet);
  var urlColIndex = findUrlColumn(headers, sheet);

  if (urlColIndex === -1) {
    return jsonResponse({ error: 'No LinkedIn URL column found' });
  }

  // Load all URLs at once
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return jsonResponse({ error: 'Sheet has no data rows' });
  }

  var allUrls = sheet.getRange(2, urlColIndex + 1, lastRow - 1, 1).getValues();
  var urlMap = {};
  for (var i = 0; i < allUrls.length; i++) {
    var normalized = normalizeUrl(allUrls[i][0]);
    if (normalized) urlMap[normalized] = i + 2; // row number
  }

  var results = [];

  data.updates.forEach(function(update) {
    var normalized = normalizeUrl(update.linkedinUrl);
    var row = urlMap[normalized];

    if (!row) {
      results.push({ linkedinUrl: update.linkedinUrl, error: 'not found' });
      return;
    }

    var updated = writeFields(sheet, headers, row, update);
    results.push({ linkedinUrl: update.linkedinUrl, row: row, updated: updated });
  });

  return jsonResponse({
    success: true,
    sheetId: data.sheetId,
    processed: results.length,
    results: results
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Action: Get tracking status for a URL (or all URLs)
// ═══════════════════════════════════════════════════════════════════════════

function handleGetStatus(sheet, data) {
  var headers = getHeaders(sheet);
  var urlColIndex = findUrlColumn(headers, sheet);

  if (urlColIndex === -1) {
    return jsonResponse({ error: 'No LinkedIn URL column found' });
  }

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return jsonResponse({ rows: [] });
  }

  // Read all data at once (efficient)
  var allData = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  var rows = [];

  for (var i = 0; i < allData.length; i++) {
    var rowData = {};
    for (var j = 0; j < headers.length; j++) {
      rowData[headers[j]] = allData[i][j] || '';
    }

    // If a specific URL was requested, filter
    if (data.linkedinUrl) {
      var cellUrl = normalizeUrl(rowData[headers[urlColIndex]]);
      var searchUrl = normalizeUrl(data.linkedinUrl);
      if (cellUrl !== searchUrl) continue;
    }

    rows.push(rowData);
  }

  return jsonResponse({ rows: rows, total: rows.length });
}

// ═══════════════════════════════════════════════════════════════════════════
// Action: Get single row status (Phase 11.3 — Check DMs non-destructive write)
// Returns { success, row: { Reply, 'Reply At', 'Reply Preview', ... } } for
// the row whose LinkedIn URL matches `data.linkedinUrl`. Used by the check-dms
// orchestrator to avoid overwriting operator-edited Reply="yes" rows.
// ═══════════════════════════════════════════════════════════════════════════

function handleGetRowStatus(sheet, data) {
  if (!data.linkedinUrl) {
    return jsonResponse({ error: 'linkedinUrl is required' });
  }

  var headers = getHeaders(sheet);
  var urlColIndex = data.urlColumnName
    ? headers.indexOf(data.urlColumnName)
    : findUrlColumn(headers, sheet);

  if (urlColIndex === -1) {
    return jsonResponse({ error: 'No LinkedIn URL column found' });
  }

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return jsonResponse({ success: false, reason: 'empty-sheet' });
  }

  var allData = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  var searchUrl = normalizeUrl(data.linkedinUrl);

  for (var i = 0; i < allData.length; i++) {
    var cellUrl = normalizeUrl(allData[i][urlColIndex]);
    if (cellUrl !== searchUrl) continue;

    var rowData = {};
    for (var j = 0; j < headers.length; j++) {
      rowData[headers[j]] = allData[i][j] || '';
    }
    return jsonResponse({ success: true, row: rowData });
  }

  return jsonResponse({ success: false, reason: 'not-found' });
}

// ═══════════════════════════════════════════════════════════════════════════
// Utility functions
// ═══════════════════════════════════════════════════════════════════════════

function getHeaders(sheet) {
  var lastCol = sheet.getLastColumn();
  if (lastCol === 0) return [];
  return sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function(h) {
    return (h || '').toString().trim();
  });
}

function findUrlColumn(headers, sheet) {
  // Priority 1: exact match on known URL column names
  for (var i = 0; i < headers.length; i++) {
    if (URL_COLUMN_NAMES.indexOf(headers[i]) !== -1) return i;
  }

  // Priority 2: scan first data row to find a column containing "linkedin.com"
  if (sheet) {
    var lastRow = sheet.getLastRow();
    if (lastRow >= 2) {
      var firstRow = sheet.getRange(2, 1, 1, headers.length).getValues()[0];
      for (var j = 0; j < firstRow.length; j++) {
        var val = (firstRow[j] || '').toString().toLowerCase();
        if (val.indexOf('linkedin.com') !== -1) return j;
      }
    }
  }

  // Priority 3: header name contains 'url' or 'link' (but not just 'linkedin')
  for (var k = 0; k < headers.length; k++) {
    var h = headers[k].toLowerCase();
    if (h.indexOf('url') !== -1 || h.indexOf('profile link') !== -1) return k;
  }

  // Priority 4: any header with 'linkedin' AND 'url' or 'link' or 'bio' or 'profile'
  for (var l = 0; l < headers.length; l++) {
    var hl = headers[l].toLowerCase();
    if (hl.indexOf('linkedin') !== -1 && (hl.indexOf('url') !== -1 || hl.indexOf('link') !== -1 || hl.indexOf('bio') !== -1 || hl.indexOf('profile') !== -1)) return l;
  }

  return -1;
}

function findRowByUrl(sheet, urlColIndex, searchUrl) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;

  var urls = sheet.getRange(2, urlColIndex + 1, lastRow - 1, 1).getValues();
  var normalized = normalizeUrl(searchUrl);

  for (var r = 0; r < urls.length; r++) {
    if (normalizeUrl(urls[r][0]) === normalized) {
      return r + 2;
    }
  }
  return -1;
}

function normalizeUrl(url) {
  if (!url) return '';
  return url.toString().trim().toLowerCase().replace(/\/+$/, '');
}

// PERFORMANCE NOTE (v2.59.x): Apps Script buffers setValue() writes and
// commits them in one batch — BUT any getValue()/getValues() forces an
// immediate flush of that buffer (it must commit pending writes before it can
// read). So interleaving reads among writes turns one batched commit into
// several backend round-trips. (Verified: Google best-practices doc +
// SpreadsheetApp.flush reference.) The old writeFields read each action cell
// AFTER the FIELD_MAP writes (3 reads interleaved among ~10 writes) → multiple
// flushes per row. This version does the ONE read it needs up front (only when
// the sheet actually has action columns), then performs every write with no
// read interleaved, so the writes commit as a single batch. Behaviour is
// identical — same cells, same values, same dash-fill decision.
function writeFields(sheet, headers, row, data) {
  var updated = [];

  // ── READ FIRST (only if there are action columns to dash-fill) ──
  // The only read that previously interleaved with writes was the dash-fill's
  // per-cell getValue(). We do it once here, before any write, so it can't
  // flush a pending write buffer. We read the whole used row in one getValues()
  // and reuse it for every action-column check. Skipped entirely when no action
  // column exists (e.g. clean v2 sheets) so we never add a read the old code
  // didn't make. Reading returns computed values for any operator formula
  // cells, but we only READ from preVals — we never write the row back — so
  // operator formulas are never clobbered.
  var hasActionCols = false;
  for (var a = 0; a < ACTION_COLUMNS.length; a++) {
    if (headers.indexOf(ACTION_COLUMNS[a]) !== -1) { hasActionCols = true; break; }
  }
  var preVals = (hasActionCols && headers.length > 0)
    ? sheet.getRange(row, 1, 1, headers.length).getValues()[0]
    : null;

  // ── From here down: WRITES ONLY — no getValue()/getValues() interleaved ──

  // Split dateLastAction into separate 'Date' and 'Time' columns. Prefers
  // the per-operator tz the bot sends (v2.58.x — launcher's stored
  // timezone), so timestamps stamp in the launcher's local time. Falls
  // back to the script's project timezone when no tz is sent, matching
  // the legacy behaviour for old bot versions.
  if (data.dateLastAction !== undefined && data.dateLastAction !== null && data.dateLastAction !== '') {
    var nowDt = new Date();
    var tz = (data && data.tz) || Session.getScriptTimeZone();
    var dateStr = Utilities.formatDate(nowDt, tz, 'yyyy-MM-dd');
    var timeStr = Utilities.formatDate(nowDt, tz, 'HH:mm:ss');
    [['Date of Last Action', dateStr], ['Time of Last Action', timeStr]].forEach(function(pair) {
      var colName = pair[0], v = pair[1];
      var idx = headers.indexOf(colName);
      if (idx === -1) {
        idx = headers.length;
        sheet.getRange(1, idx + 1).setValue(colName);
        sheet.getRange(1, idx + 1).setFontWeight('bold');
        headers.push(colName);
      }
      sheet.getRange(row, idx + 1).setValue(v);
      updated.push(colName);
    });
  }

  // v2.84: "Needs Login" account flag. Special-cased (NOT in FIELD_MAP) for two
  // reasons: (1) the generic loop skips '' so it could never CLEAR a cell, and
  // we clear the flag on the account's next success; (2) a needsLogin-only write
  // must not trigger the action-column dash-fill below. Targeted by header name
  // so the column can move position. Writes only when the column already exists.
  var wroteNeedsLoginOnly = false;
  if (data.needsLogin !== undefined && data.needsLogin !== null) {
    var nlIdx = headers.indexOf('Needs Login');
    if (nlIdx !== -1) {
      sheet.getRange(row, nlIdx + 1).setValue(data.needsLogin);  // 'Y' to flag, '' to clear
      updated.push('Needs Login');
    }
    wroteNeedsLoginOnly = true;  // provisional — cleared below if any real field writes
  }

  // Track which column indices FIELD_MAP wrote this call, so the dash-fill can
  // tell "still blank?" from preVals + this set without re-reading each cell.
  var wroteIdx = {};

  for (var field in FIELD_MAP) {
    if (data[field] !== undefined && data[field] !== null && data[field] !== '') {
      var colName = FIELD_MAP[field];
      var colIndex = headers.indexOf(colName);
      // v2 fallback: when the legacy 'Connection Request Status' column
      // doesn't exist on this sheet but 'Last Action' does (a v2 prepareSheet
      // sheet), route `data.status` to 'Last Action' instead. Likewise the
      // v2-first field name `status` → 'Last Action' wins on v2 sheets when
      // both columns are present.
      if (field === 'status' && colIndex === -1) {
        var altIdx = headers.indexOf('Last Action');
        if (altIdx !== -1) {
          colIndex = altIdx;
          colName  = 'Last Action';
        }
      }
      // Skip writes for columns that don't exist on this sheet — keeps the
      // mode-specific column sets honest. ensureColumns is the source of
      // truth for which columns get added; writeFields no longer auto-
      // creates from incoming data.
      if (colIndex === -1) continue;

      var cell = sheet.getRange(row, colIndex + 1);
      var value = data[field];
      // Detect HYPERLINK formula so action cells render as clickable "sent"
      if (typeof value === 'string' && value.charAt(0) === '=') {
        cell.setFormula(value);
      } else {
        cell.setValue(value);
      }
      wroteIdx[colIndex] = true;
      wroteNeedsLoginOnly = false;  // a real field wrote → not a flag-only call
      updated.push(colName);
    }
  }

  // Dash-fill any action column still blank — decided from the up-front read
  // (preVals) plus the columns FIELD_MAP just wrote (wroteIdx). Equivalent to
  // the old post-write getValue() check: a cell ends blank iff it was blank
  // before AND FIELD_MAP didn't write it this call. No reads here → the writes
  // above stay batched. The `(x || '')` coercion matches the old check exactly.
  // v2.84: skip entirely for a needsLogin-only write — flagging an account's
  // rows must not stamp '—' into their OP/Message/InMail action cells.
  if (!wroteNeedsLoginOnly) ACTION_COLUMNS.forEach(function(col) {
    var idx = headers.indexOf(col);
    if (idx === -1) return;
    if (wroteIdx[idx]) return; // FIELD_MAP filled it this call
    var prev = (preVals && (preVals[idx] || '').toString().trim()) || '';
    if (prev === '') sheet.getRange(row, idx + 1).setValue('—');
  });

  // Append audit entry if this write represents an action (has accountUsed).
  if (data.accountUsed) {
    appendAuditLog(sheet.getParent(), {
      date: data.dateLastAction || new Date().toISOString(),
      linkedinUrl: data.linkedinUrl || '',
      action: data.auditAction || data.status || '',
      account: data.accountUsed,
      notes: data.auditNotes || ''
    });
  }

  return updated;
}

/*
 * ── ROLLBACK: original writeFields (pre-v2.59.x batching reorder) ──
 * If the optimized version above ever misbehaves after redeploy, delete it and
 * uncomment this one. It is behaviourally identical except it reads each action
 * cell after the writes (slower: interleaved reads force write-buffer flushes).
 *
 * function writeFields(sheet, headers, row, data) {
 *   var updated = [];
 *   if (data.dateLastAction !== undefined && data.dateLastAction !== null && data.dateLastAction !== '') {
 *     var nowDt = new Date();
 *     var tz = (data && data.tz) || Session.getScriptTimeZone();
 *     var dateStr = Utilities.formatDate(nowDt, tz, 'yyyy-MM-dd');
 *     var timeStr = Utilities.formatDate(nowDt, tz, 'HH:mm:ss');
 *     [['Date of Last Action', dateStr], ['Time of Last Action', timeStr]].forEach(function(pair) {
 *       var colName = pair[0], v = pair[1];
 *       var idx = headers.indexOf(colName);
 *       if (idx === -1) { idx = headers.length; sheet.getRange(1, idx + 1).setValue(colName); sheet.getRange(1, idx + 1).setFontWeight('bold'); headers.push(colName); }
 *       sheet.getRange(row, idx + 1).setValue(v);
 *       updated.push(colName);
 *     });
 *   }
 *   for (var field in FIELD_MAP) {
 *     if (data[field] !== undefined && data[field] !== null && data[field] !== '') {
 *       var colName = FIELD_MAP[field];
 *       var colIndex = headers.indexOf(colName);
 *       if (field === 'status' && colIndex === -1) { var altIdx = headers.indexOf('Last Action'); if (altIdx !== -1) { colIndex = altIdx; colName = 'Last Action'; } }
 *       if (colIndex === -1) continue;
 *       var cell = sheet.getRange(row, colIndex + 1);
 *       var value = data[field];
 *       if (typeof value === 'string' && value.charAt(0) === '=') { cell.setFormula(value); } else { cell.setValue(value); }
 *       updated.push(colName);
 *     }
 *   }
 *   ACTION_COLUMNS.forEach(function(col) {
 *     var idx = headers.indexOf(col);
 *     if (idx === -1) return;
 *     var cell = sheet.getRange(row, idx + 1);
 *     var cur = (cell.getValue() || '').toString().trim();
 *     if (cur === '') cell.setValue('—');
 *   });
 *   if (data.accountUsed) {
 *     appendAuditLog(sheet.getParent(), { date: data.dateLastAction || new Date().toISOString(), linkedinUrl: data.linkedinUrl || '', action: data.auditAction || data.status || '', account: data.accountUsed, notes: data.auditNotes || '' });
 *   }
 *   return updated;
 * }
 */

// ═══════════════════════════════════════════════════════════════════════════
// Audit Log — separate tab, full history
// ═══════════════════════════════════════════════════════════════════════════

var AUDIT_SHEET_NAME = 'Audit Log';
var AUDIT_HEADERS = ['Date', 'Lead URL', 'Action', 'Account', 'Notes'];

function getOrCreateAuditSheet(spreadsheet) {
  var sheet = spreadsheet.getSheetByName(AUDIT_SHEET_NAME);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(AUDIT_SHEET_NAME);
    sheet.getRange(1, 1, 1, AUDIT_HEADERS.length).setValues([AUDIT_HEADERS]);
    sheet.getRange(1, 1, 1, AUDIT_HEADERS.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function appendAuditLog(spreadsheet, entry) {
  try {
    var sheet = getOrCreateAuditSheet(spreadsheet);
    sheet.appendRow([
      entry.date || '',
      entry.linkedinUrl || '',
      entry.action || '',
      entry.account || '',
      entry.notes || ''
    ]);
  } catch (err) {
    // Silent — audit is best-effort, must never break the main write.
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Action: Get SoO (State of Operations) account statuses
// ═══════════════════════════════════════════════════════════════════════════
// Reads the SoO sheet and returns per-email status for LinkedIn, InMail, etc.
// data.sooSheetId = the SoO spreadsheet ID
// data.sooGid (optional) = specific tab gid

function handleGetSoO(data) {
  if (!data.sooSheetId) {
    return jsonResponse({ error: 'sooSheetId is required', errorCode: 'BAD_REQUEST' });
  }

  var spreadsheet = SpreadsheetApp.openById(data.sooSheetId);
  var sheet;

  // If gid provided, find the sheet by gid
  if (data.sooGid) {
    var sheets = spreadsheet.getSheets();
    for (var i = 0; i < sheets.length; i++) {
      if (sheets[i].getSheetId().toString() === data.sooGid.toString()) {
        sheet = sheets[i];
        break;
      }
    }
    if (!sheet) {
      return jsonResponse({
        error: 'Sheet tab with gid ' + data.sooGid + ' not found',
        errorCode: 'SHEET_NOT_FOUND'
      });
    }
  } else {
    sheet = spreadsheet.getActiveSheet();
  }

  var headers = getHeaders(sheet);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return jsonResponse({ accounts: [], headers: headers, total: 0 });
  }

  // ── Strict header-based column lookup ────────────────────────────────────
  // All columns are located by header name, case-insensitive. No fallback to
  // positional indexes — if a required header is missing, we return a clear
  // error rather than silently reading from the wrong column.
  function findHeader(predicate) {
    for (var i = 0; i < headers.length; i++) {
      var h = (headers[i] || '').toString().toLowerCase().trim();
      if (predicate(h)) return i;
    }
    return -1;
  }

  var emailCol         = findHeader(function(h) { return h === 'email'; });
  var firstNameCol     = findHeader(function(h) { return h === 'first name'; });
  var linkedinOpCol    = findHeader(function(h) { return h.indexOf('linkedin') !== -1 && h.indexOf('op credits') !== -1 && h.indexOf('sales') === -1; });
  var linkedinUserCol  = findHeader(function(h) { return h.indexOf('linkedin') !== -1 && h.indexOf('op user') !== -1; });
  var salesNavOpCol    = findHeader(function(h) { return h.indexOf('sales nav') !== -1 && h.indexOf('op credits') !== -1; });
  var salesNavUserCol  = findHeader(function(h) { return h.indexOf('sales nav') !== -1 && h.indexOf('user') !== -1; });
  var inmailCreditsCol = findHeader(function(h) { return h.indexOf('inmail') !== -1 && h.indexOf('credits') !== -1; });
  var inmailUserCol    = findHeader(function(h) { return h.indexOf('inmail') !== -1 && h.indexOf('user') !== -1; });
  var ccCreditsCol     = findHeader(function(h) { return h.indexOf('cc') !== -1 && h.indexOf('credits') !== -1; });

  if (emailCol === -1) {
    return jsonResponse({
      error: 'Required "Email" column header not found in SoO sheet',
      errorCode: 'MISSING_EMAIL_HEADER'
    });
  }

  var allData = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  var accounts = [];
  var currentSection = ''; // Track section headers like "Pool Accounts Unassigned"

  for (var r = 0; r < allData.length; r++) {
    var email = (allData[r][emailCol] || '').toString().trim();
    if (!email) continue;

    // Detect section headers (no @ sign = section label, not an email)
    if (email.indexOf('@') === -1) {
      currentSection = email;
      continue;
    }

    var account = { email: email, section: currentSection };

    // Return ALL columns as raw key-value pairs (keyed by header name)
    for (var c = 0; c < headers.length; c++) {
      if (c === emailCol) continue; // already have email
      var val = (allData[r][c] || '').toString().trim();
      if (val) account[headers[c]] = val;
    }

    // Structured fields for frontend consumption — header-based, not positional.
    if (linkedinOpCol !== -1)    account.linkedinCredits  = (allData[r][linkedinOpCol]    || '').toString().trim();
    if (linkedinUserCol !== -1)  account.linkedinUser     = (allData[r][linkedinUserCol]  || '').toString().trim();
    if (salesNavOpCol !== -1)    account.salesNavCredits  = (allData[r][salesNavOpCol]    || '').toString().trim();
    if (salesNavUserCol !== -1)  account.salesNavUser     = (allData[r][salesNavUserCol]  || '').toString().trim();
    if (inmailCreditsCol !== -1) account.inmailCredits    = (allData[r][inmailCreditsCol] || '').toString().trim();
    if (inmailUserCol !== -1)    account.inmailUser       = (allData[r][inmailUserCol]    || '').toString().trim();
    if (ccCreditsCol !== -1)     account.ccCredits        = (allData[r][ccCreditsCol]     || '').toString().trim();

    // First name — used as {senderFirstName} in templates. Header-based.
    // If the "First Name" column is missing, leave blank rather than grab the
    // wrong column by positional index.
    if (firstNameCol !== -1) {
      account.firstName = (allData[r][firstNameCol] || '').toString().trim();
    }

    accounts.push(account);
  }

  return jsonResponse({ accounts: accounts, headers: headers, total: accounts.length });
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ═══════════════════════════════════════════════════════════════════════════
// Action: writeRecentConnections — sidecar tab dump of Voyager's connections
// ═══════════════════════════════════════════════════════════════════════════
// The bot sends `data.connections` (array of {firstName, lastName, publicId,
// urn, memberId, connectedAt, profileSentBy}) and the sender's email. ONE
// shared "Recent Connections" tab holds all accounts' fetched connections,
// distinguished by the leading 'Account' column. Each call refreshes only
// the rows for THIS account (deletes existing rows where Account == sender,
// then appends the new rows) so multi-account sweeps don't fight each other.
var RECENT_TAB_NAME = 'Recent Connections';
// 'LinkedIn URN' carries the bare ACoAA… portion (no `urn:li:fsd_profile:`
// prefix) — same convention as the campaign tab. 'Member ID' is the
// numeric member number (urn:li:member:NNN), blank when Voyager's
// connections list didn't include the objectUrn for that entity.
var RECENT_HEADERS = ['Account', 'First Name', 'Last Name', 'Public ID', 'LinkedIn URN', 'Member ID', 'Connected At', 'Fetched At'];

function handleWriteRecentConnections(spreadsheet, data) {
  var connections = Array.isArray(data.connections) ? data.connections : [];
  var sender = (data.sender || '').toString().trim();
  // v2.62: client passes the set of accounts assigned to this campaign's
  // Sender column. Rows whose Account isn't in this set get dropped on
  // every refresh — the tab is now scoped strictly to the campaign's
  // active senders ("the Bible" the operator described). Empty array →
  // legacy behavior (keep everything except current sender).
  var activeSendersRaw = Array.isArray(data.activeSenders) ? data.activeSenders : [];
  var activeSendersLower = {};
  var hasActiveSenderScope = false;
  for (var i = 0; i < activeSendersRaw.length; i++) {
    var v = (activeSendersRaw[i] || '').toString().trim().toLowerCase();
    if (v) { activeSendersLower[v] = true; hasActiveSenderScope = true; }
  }

  var sheet = spreadsheet.getSheetByName(RECENT_TAB_NAME);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(RECENT_TAB_NAME);
  }

  // Header row — write/refresh defensively in case columns drift.
  var firstRow = sheet.getRange(1, 1, 1, RECENT_HEADERS.length).getValues()[0];
  var headerNeedsWrite = false;
  for (var h = 0; h < RECENT_HEADERS.length; h++) {
    if (firstRow[h] !== RECENT_HEADERS[h]) { headerNeedsWrite = true; break; }
  }
  if (headerNeedsWrite) {
    sheet.getRange(1, 1, 1, RECENT_HEADERS.length)
      .setValues([RECENT_HEADERS])
      .setFontWeight('bold')
      .setBackground('#f1f3f4');
    sheet.setFrozenRows(1);
  }

  // Read existing rows once.
  var lastRow = sheet.getLastRow();
  var existing = [];
  if (lastRow >= 2) {
    existing = sheet.getRange(2, 1, lastRow - 1, RECENT_HEADERS.length).getValues();
  }

  // Identity key for dedupe, scoped per account. URN (ACoAA…) wins, then
  // Public ID slug, then first+last name. Mirrors the Node matcher's keys.
  function _identityKey(account, urn, publicId, firstName, lastName) {
    var acct = (account || '').toString().trim().toLowerCase();
    var u = (urn || '').toString().trim().toLowerCase();
    if (u) return acct + '|urn:' + u;
    var p = (publicId || '').toString().trim().toLowerCase();
    if (p) return acct + '|pid:' + p;
    var n = ((firstName || '') + ' ' + (lastName || '')).toString().trim().toLowerCase();
    return acct + '|name:' + n;
  }

  // Keep rows from other campaign accounts (drop non-campaign accounts), and
  // keep THIS sender's existing rows too — we only ADD new people, never wipe.
  var keptRows = [];
  var seenKeys = {};
  for (var r = 0; r < existing.length; r++) {
    var rowSender = (existing[r][0] || '').toString().trim();
    if (hasActiveSenderScope && !activeSendersLower[rowSender.toLowerCase()]) continue;
    keptRows.push(existing[r]);
    // existing columns: [Account, First, Last, PublicId, URN, MemberId, ...]
    seenKeys[_identityKey(rowSender, existing[r][4], existing[r][3], existing[r][1], existing[r][2])] = true;
  }

  var fetchedAt = new Date().toISOString();
  var appended = 0;
  // Note: this append isn't gated by activeSendersLower. If `sender` isn't a
  // campaign Sender, its rows get written now and evicted on the next sweep's
  // kept-rows filter. Harmless — the bot's matcher (computeBulkCheckUpdates
  // Guard-1) returns empty for a non-active-sender caller, so nothing is ever
  // stamped from these rows; this is just transient write churn.
  for (var i = 0; i < connections.length; i++) {
    var c = connections[i];
    var acct = sender || (c.profileSentBy || '');
    var key = _identityKey(acct, c.urn, c.publicId, c.firstName, c.lastName);
    if (seenKeys[key]) continue;     // dedupe — already in the tab for this account
    seenKeys[key] = true;
    keptRows.push([
      acct,
      c.firstName || '',
      c.lastName || '',
      c.publicId || '',
      c.urn || '',
      c.memberNumber || '',
      c.connectedAt ? new Date(c.connectedAt).toISOString() : '',
      fetchedAt,
    ]);
    appended++;
  }

  // Rewrite the data area with the combined (kept + newly-appended) set.
  if (lastRow >= 2) {
    sheet.getRange(2, 1, lastRow - 1, RECENT_HEADERS.length).clearContent();
  }
  if (keptRows.length > 0) {
    sheet.getRange(2, 1, keptRows.length, RECENT_HEADERS.length).setValues(keptRows);
  }

  // Return the full accumulated set so the bot matches against the tab, not
  // the live 80-fetch. Shape mirrors the Node `conns` objects + `account`.
  var accumulated = keptRows.map(function (row) {
    return {
      account: row[0], firstName: row[1], lastName: row[2],
      publicId: row[3], urn: row[4], memberNumber: row[5],
    };
  });

  return jsonResponse({ ok: true, tab: RECENT_TAB_NAME, rows: appended, accumulated: accumulated });
}

// Action: clearRecentConnections — wipe the tab clean at campaign start.
// Keeps the header row; removes all data rows. Idempotent (no-op if absent).
function handleClearRecentConnections(spreadsheet, data) {
  var sheet = spreadsheet.getSheetByName(RECENT_TAB_NAME);
  if (!sheet) {
    return jsonResponse({ ok: true, tab: RECENT_TAB_NAME, cleared: 0 });
  }
  var lastRow = sheet.getLastRow();
  var cleared = 0;
  if (lastRow >= 2) {
    cleared = lastRow - 1;
    sheet.getRange(2, 1, lastRow - 1, RECENT_HEADERS.length).clearContent();
  }
  return jsonResponse({ ok: true, tab: RECENT_TAB_NAME, cleared: cleared });
}

// ═══════════════════════════════════════════════════════════════════════════
// Action: writeRecentMessages — sidecar tab dump of inbound replies (v2.72)
// ═══════════════════════════════════════════════════════════════════════════
// The reply-check counterpart of writeRecentConnections. The bot sends
// `data.messages` (array of {account, name, lastMessage, receivedAt, matched})
// — INBOUND replies only, from 1:1 conversations only (group threads are
// filtered out bot-side), last message only. ONE shared "Recent Messages" tab
// holds every account's replies, distinguished by the leading 'Account' column.
// Each call refreshes only THIS account's rows (so the latest last-message per
// person wins) and leaves other accounts' rows untouched.
var RECENT_MSG_TAB_NAME = 'Recent Messages';
var RECENT_MSG_HEADERS = ['Account', 'Name', 'Last Message', 'Received At', 'Matched Lead', 'Fetched At'];

function handleWriteRecentMessages(spreadsheet, data) {
  var messages = Array.isArray(data.messages) ? data.messages : [];
  var sender = (data.sender || '').toString().trim();
  var senderLower = sender.toLowerCase();

  var sheet = spreadsheet.getSheetByName(RECENT_MSG_TAB_NAME);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(RECENT_MSG_TAB_NAME);
  }

  // Header row — write/refresh defensively in case columns drift.
  var firstRow = sheet.getRange(1, 1, 1, RECENT_MSG_HEADERS.length).getValues()[0];
  var headerNeedsWrite = false;
  for (var h = 0; h < RECENT_MSG_HEADERS.length; h++) {
    if (firstRow[h] !== RECENT_MSG_HEADERS[h]) { headerNeedsWrite = true; break; }
  }
  if (headerNeedsWrite) {
    sheet.getRange(1, 1, 1, RECENT_MSG_HEADERS.length)
      .setValues([RECENT_MSG_HEADERS])
      .setFontWeight('bold')
      .setBackground('#f1f3f4');
    sheet.setFrozenRows(1);
  }

  // Read existing rows once.
  var lastRow = sheet.getLastRow();
  var existing = [];
  if (lastRow >= 2) {
    existing = sheet.getRange(2, 1, lastRow - 1, RECENT_MSG_HEADERS.length).getValues();
  }

  // Keep every OTHER account's rows; this account's rows are fully refreshed
  // from `messages` (the latest last-message per person).
  var keptRows = [];
  for (var r = 0; r < existing.length; r++) {
    var rowAccount = (existing[r][0] || '').toString().trim().toLowerCase();
    if (rowAccount !== senderLower) keptRows.push(existing[r]);
  }

  var fetchedAt = new Date().toISOString();
  var seenNames = {};
  var appended = 0;
  for (var i = 0; i < messages.length; i++) {
    var m = messages[i];
    var nm = (m.name || '').toString().trim();
    var dedupKey = nm.toLowerCase() + '|' + (m.lastMessage || '').toString().trim().toLowerCase();
    if (seenNames[dedupKey]) continue;       // same person + same last message
    seenNames[dedupKey] = true;
    keptRows.push([
      m.account || sender,
      nm,
      (m.lastMessage || '').toString(),
      m.receivedAt ? new Date(m.receivedAt).toISOString() : '',
      m.matched ? 'Yes' : 'No',
      fetchedAt,
    ]);
    appended++;
  }

  // Rewrite the data area with the combined set.
  if (lastRow >= 2) {
    sheet.getRange(2, 1, lastRow - 1, RECENT_MSG_HEADERS.length).clearContent();
  }
  if (keptRows.length > 0) {
    sheet.getRange(2, 1, keptRows.length, RECENT_MSG_HEADERS.length).setValues(keptRows);
  }

  return jsonResponse({ ok: true, tab: RECENT_MSG_TAB_NAME, rows: appended });
}
