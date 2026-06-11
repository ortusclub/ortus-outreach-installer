/**
 * Ortus Operations Log — Apps Script bridge (v2 — single Events tab).
 *
 * Container-bound to the spreadsheet:
 *   "OPS AND LOGS - ORTUS OUTREACH - DO NOT DELETE"
 *   https://docs.google.com/spreadsheets/d/1AC0xM8EfjHNApa_PnedrC1t5hw6UWMnuUI1Ox2edmzI/
 *
 * v2 replaces the old "one tab per campaign" design (which created an
 * insertSheet() per run and hit Google's 10M-cell ceiling — the log froze
 * on 2026-06-10). Now every event from every operator/account appends to a
 * single, overflow-proof `Events` tab, and three QUERY-driven view tabs sit
 * on top:
 *   - Attribution        — who did what, per Ortus account
 *   - Where it's leaking — failures grouped by reason
 *   - Account health     — per-account outcome breakdown (pivot)
 *
 * Deployment:
 *   1. Open the "OPS AND LOGS - ORTUS OUTREACH - DO NOT DELETE" sheet.
 *   2. Extensions → Apps Script. Paste this over Code.gs.
 *   3. (One-time migration) run  Ortus Logs → Delete all log tabs  to remove
 *      the old per-campaign tabs and free the overflowed cells.
 *   4. Deploy → Manage deployments → edit the existing deployment →
 *      Version: New version → Deploy. The /exec URL stays the same.
 *
 * Actions accepted via doPost:
 *   - appendEvents: { events: [{ ts, operator, account, campaign, phase,
 *       outcome, reason, leadUrl, severity, event, details }] }
 *       (phase/outcome/reason are v2.93+; older fields are derived if absent.)
 *   - deleteAllTabs: removes every tab except the structural ones.
 */

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

var EVENTS_SHEET_NAME = 'Events';
var EVENT_HEADERS = [
  'Timestamp', 'Operator', 'Ortus Account', 'Campaign',
  'Phase', 'Outcome', 'Reason', 'Lead URL', 'Severity'
];

var ATTRIBUTION_TAB = 'Attribution';
var LEAKS_TAB = "Where it's leaking";
var HEALTH_TAB = 'Account health';
var STRUCTURAL_TABS = [EVENTS_SHEET_NAME, ATTRIBUTION_TAB, LEAKS_TAB, HEALTH_TAB];

// ═══════════════════════════════════════════════════════════════════════════
// HTTP entry point
// ═══════════════════════════════════════════════════════════════════════════

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    switch (data.action) {
      case 'appendEvents': return handleAppendEvents(data);
      case 'deleteAllTabs': return handleDeleteAllTabs();
      default: return jsonResponse({ error: 'Unknown action: ' + data.action });
    }
  } catch (err) {
    return jsonResponse({ error: err.message, stack: err.stack });
  }
}

function doGet(e) {
  return jsonResponse({ status: 'ok', service: 'Ortus Operations Log', deployed: new Date().toISOString() });
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ═══════════════════════════════════════════════════════════════════════════
// Action: appendEvents — append every event to the single Events tab
// ═══════════════════════════════════════════════════════════════════════════

function handleAppendEvents(data) {
  var events = Array.isArray(data.events) ? data.events : [];
  if (events.length === 0) return jsonResponse({ success: true, appended: 0 });

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ensureEventsTab(ss);

  var rows = events.map(function (evt) {
    var outcome = evt.outcome || evt.event || '';
    var sev = evt.severity || (outcome === 'error' ? 'ERROR'
      : (outcome === 'skipped' || outcome === 'rate_limited' || outcome === 'parked') ? 'WARN'
      : 'INFO');
    return [
      evt.ts || '',
      evt.operator || '',
      evt.account || '',
      evt.campaign || '',
      evt.phase || '',
      outcome,
      evt.reason || evt.details || '',
      evt.leadUrl || '',
      sev
    ];
  });

  var startRow = sheet.getLastRow() + 1;
  sheet.getRange(startRow, 1, rows.length, EVENT_HEADERS.length).setValues(rows);
  ensureViewTabs(ss);
  return jsonResponse({ success: true, appended: rows.length });
}

function ensureEventsTab(ss) {
  var sheet = ss.getSheetByName(EVENTS_SHEET_NAME);
  if (sheet) return sheet;
  sheet = ss.insertSheet(EVENTS_SHEET_NAME, 0);
  sheet.getRange(1, 1, 1, EVENT_HEADERS.length).setValues([EVENT_HEADERS])
    .setFontWeight('bold').setBackground('#f1f3f4');
  sheet.setFrozenRows(1);
  var widths = [150, 150, 170, 160, 90, 110, 280, 200, 80];
  for (var i = 0; i < widths.length; i++) sheet.setColumnWidth(i + 1, widths[i]);

  // Outcome-tinted conditional formatting (column F) across the data range.
  var rng = sheet.getRange(2, 1, Math.max(sheet.getMaxRows() - 1, 1000), EVENT_HEADERS.length);
  function rule(val, bg, fg) {
    return SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=$F2="' + val + '"').setBackground(bg).setFontColor(fg).setRanges([rng]).build();
  }
  sheet.setConditionalFormatRules([
    rule('error', '#fce4e4', '#a1252b'),
    rule('parked', '#f4d3d5', '#a1252b'),
    rule('rate_limited', '#fbe8cf', '#8a5a00'),
    rule('skipped', '#fff4d6', '#8a5a00'),
    rule('accepted', '#d6ecdf', '#1f6b3e'),
    rule('sent', '#e6f4ea', '#2f7d4f')
  ]);
  return sheet;
}

// ═══════════════════════════════════════════════════════════════════════════
// View tabs — live QUERY formulas over the Events tab
// ═══════════════════════════════════════════════════════════════════════════

function ensureViewTabs(ss) {
  // Attribution — who did what, per account (Account, Operator, events, last).
  ensureFormulaTab(ss, ATTRIBUTION_TAB,
    "=IFERROR(QUERY(Events!A:I,\"select C, B, count(A), max(A) where C is not null and C<>'' group by C, B order by count(A) desc label C 'Ortus Account', B 'Operator', count(A) 'Events', max(A) 'Last activity'\",1),\"no data yet\")");

  // Where it's leaking — failures grouped by reason, costliest first.
  ensureFormulaTab(ss, LEAKS_TAB,
    "=IFERROR(QUERY(Events!A:I,\"select G, count(A) where F='skipped' or F='rate_limited' or F='parked' or F='error' group by G order by count(A) desc label G 'Reason', count(A) 'Count'\",1),\"no leaks yet\")");

  // Account health — per-account breakdown, one column per outcome (pivot).
  ensureFormulaTab(ss, HEALTH_TAB,
    "=IFERROR(QUERY(Events!A:I,\"select C, count(A) where C is not null and C<>'' group by C pivot F\",1),\"no data yet\")");
}

// Create a view tab once with its QUERY in A1. Idempotent: if the tab exists,
// leave it (the operator may have re-sorted or tweaked it).
function ensureFormulaTab(ss, name, formulaA1) {
  if (ss.getSheetByName(name)) return;
  var sheet = ss.insertSheet(name);
  sheet.getRange(1, 1).setFormula(formulaA1);
  sheet.setFrozenRows(1);
}

// ═══════════════════════════════════════════════════════════════════════════
// Action: deleteAllTabs — clean up old per-campaign tabs (migration + reset)
// ═══════════════════════════════════════════════════════════════════════════

function handleDeleteAllTabs() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureEventsTab(ss); // guarantee at least one sheet survives the delete loop
  var sheets = ss.getSheets();
  var deleted = 0;
  for (var i = 0; i < sheets.length; i++) {
    if (STRUCTURAL_TABS.indexOf(sheets[i].getName()) !== -1) continue;
    ss.deleteSheet(sheets[i]);
    deleted++;
  }
  return jsonResponse({ success: true, deleted: deleted });
}

// ═══════════════════════════════════════════════════════════════════════════
// Custom menu: Ortus Logs
// ═══════════════════════════════════════════════════════════════════════════

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Ortus Logs')
    .addItem('Delete all log tabs', 'menuDeleteAllTabs')
    .addItem('Copy diagnostic snippet for Claude', 'menuCopyDiagnosticSnippet')
    .addToUi();
}

function menuDeleteAllTabs() {
  var ui = SpreadsheetApp.getUi();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tabs = ss.getSheets().filter(function (s) { return STRUCTURAL_TABS.indexOf(s.getName()) === -1; });
  var count = tabs.length;
  if (count === 0) { ui.alert('Nothing to delete', 'No legacy per-campaign tabs found.', ui.ButtonSet.OK); return; }

  var msg = 'This will remove ' + count + ' legacy per-campaign tab' + (count === 1 ? '' : 's') + '.\n\n'
    + 'The Events / Attribution / leak / health tabs are kept. Deleted tabs cannot be recovered.';
  if (ui.alert('Delete all legacy log tabs?', msg, ui.ButtonSet.OK_CANCEL) !== ui.Button.OK) return;
  handleDeleteAllTabs();
  ui.alert('Done', 'Deleted ' + count + ' tab' + (count === 1 ? '' : 's') + '.', ui.ButtonSet.OK);
}

// Markdown table of all WARN/ERROR rows in the Events tab (+/- 3 rows of
// context), shown in a copyable dialog.
function menuCopyDiagnosticSnippet() {
  var ui = SpreadsheetApp.getUi();
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(EVENTS_SHEET_NAME);
  if (!sheet) { ui.alert('No Events tab yet', 'Nothing has been logged.', ui.ButtonSet.OK); return; }
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) { ui.alert('Empty', 'No events yet.', ui.ButtonSet.OK); return; }

  var all = sheet.getRange(2, 1, lastRow - 1, EVENT_HEADERS.length).getValues();
  var flagged = [];
  for (var i = 0; i < all.length; i++) {
    var oc = (all[i][5] || '').toString().toLowerCase(); // column F = Outcome
    var sev = (all[i][8] || '').toString().toUpperCase(); // column I = Severity
    if (oc === 'error' || oc === 'parked' || sev === 'ERROR' || sev === 'WARN') flagged.push(i);
  }
  if (flagged.length === 0) { ui.alert('No issues', 'No error/parked/warn rows.', ui.ButtonSet.OK); return; }

  var keep = {};
  flagged.forEach(function (idx) { for (var d = -3; d <= 3; d++) { var j = idx + d; if (j >= 0 && j < all.length) keep[j] = true; } });
  var keptIdxs = Object.keys(keep).map(Number).sort(function (a, b) { return a - b; });

  var md = '# Ortus Operations Log — flagged events\n\n';
  md += 'Flagged: ' + flagged.length + ' (' + keptIdxs.length + ' rows incl. context)\n\n';
  md += '| ' + EVENT_HEADERS.join(' | ') + ' |\n';
  md += '|' + EVENT_HEADERS.map(function () { return '---'; }).join('|') + '|\n';
  keptIdxs.forEach(function (i) {
    md += '| ' + all[i].map(function (c) { return (c == null ? '' : c.toString()).replace(/\|/g, '\\|').replace(/\n/g, ' '); }).join(' | ') + ' |\n';
  });

  var html = HtmlService.createHtmlOutput(
    '<p style="font-family:Arial,sans-serif;font-size:13px;margin:0 0 12px;">Select all (Ctrl/Cmd+A), copy (Ctrl/Cmd+C), paste into Claude.</p>'
    + '<textarea style="width:100%;height:480px;font-family:monospace;font-size:12px;" onclick="this.select()">'
    + md.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    + '</textarea>'
  ).setWidth(820).setHeight(560);
  ui.showModalDialog(html, 'Diagnostic snippet · Events');
}
