/**
 * Ortus Operations Log — Apps Script bridge.
 *
 * Container-bound to the spreadsheet:
 *   "OPS AND LOGS - ORTUS OUTREACH - DO NOT DELETE"
 *   https://docs.google.com/spreadsheets/d/1AC0xM8EfjHNApa_PnedrC1t5hw6UWMnuUI1Ox2edmzI/
 *
 * Receives batched event POSTs from the Ortus Outreach bot and writes them
 * to a per-campaign tab. Maintains an Index tab that lists every campaign
 * tab with totals (events, errors, warnings) via spreadsheet formulas.
 *
 * Deployment:
 *   1. Open the "OPS AND LOGS - ORTUS OUTREACH - DO NOT DELETE" sheet.
 *   2. Extensions → Apps Script.
 *   3. Paste this file's contents over the default Code.gs.
 *   4. Deploy → New deployment → Web app → Execute as: Me, Access: Anyone
 *      with the link.
 *   5. Copy the deployment URL into the bot's .env as OPS_LOG_WEBAPP_URL.
 *
 * Actions accepted via doPost:
 *   - appendEvents: { events: [{ ts, operator, severity, campaign,
 *       campaignStartedAt, account, event, leadUrl, details }] }
 *   - deleteAllTabs: removes every tab except 'Index'. Triggered by the
 *       custom Ortus Logs menu, NOT directly from the bot.
 *
 * The Ortus Logs menu (added by onOpen) provides two operator actions:
 *   - Delete all log tabs (with confirmation dialog)
 *   - Copy diagnostic snippet for Claude (active tab's WARN/ERROR rows
 *     plus context, formatted as Markdown and copied to clipboard)
 */

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

var INDEX_SHEET_NAME = 'Index';
var INDEX_HEADERS = [
  'Tab name', 'Started', 'Operator', 'Total events',
  'Errors', 'Warnings', 'Last event at', 'Link'
];
var EVENT_HEADERS = [
  'Timestamp', 'Operator', 'Severity',
  'Ortus Account', 'Event', 'Lead URL', 'Details'
];

// ═══════════════════════════════════════════════════════════════════════════
// HTTP entry point
// ═══════════════════════════════════════════════════════════════════════════

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    switch (data.action) {
      case 'appendEvents':
        return handleAppendEvents(data);
      case 'deleteAllTabs':
        return handleDeleteAllTabs();
      default:
        return jsonResponse({ error: 'Unknown action: ' + data.action });
    }
  } catch (err) {
    return jsonResponse({ error: err.message, stack: err.stack });
  }
}

function doGet(e) {
  return jsonResponse({
    status: 'ok',
    service: 'Ortus Operations Log',
    deployed: new Date().toISOString()
  });
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ═══════════════════════════════════════════════════════════════════════════
// Action: appendEvents
// ═══════════════════════════════════════════════════════════════════════════
// Groups events by their {campaign, campaignStartedAt} key and appends each
// group to its corresponding tab. Creates the tab on first sight. Refreshes
// the Index tab to reflect any new tabs.

function handleAppendEvents(data) {
  var events = Array.isArray(data.events) ? data.events : [];
  if (events.length === 0) {
    return jsonResponse({ success: true, appended: 0 });
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureIndexTab(ss);

  // Group by tab name (campaign + startedAt). One key, one tab.
  var groups = {};
  events.forEach(function(evt) {
    var key = buildTabName(evt.campaign, evt.campaignStartedAt);
    if (!groups[key]) {
      groups[key] = {
        tabName: key,
        campaign: evt.campaign || '',
        startedAt: evt.campaignStartedAt || '',
        operator: evt.operator || '',
        rows: []
      };
    }
    groups[key].rows.push([
      evt.ts || '',
      evt.operator || '',
      evt.severity || 'INFO',
      evt.account || '',
      evt.event || '',
      evt.leadUrl || '',
      evt.details || ''
    ]);
  });

  // For each group: find-or-create tab, append rows in one range write.
  var appendedTotal = 0;
  Object.keys(groups).forEach(function(key) {
    var g = groups[key];
    var sheet = ensureCampaignTab(ss, g.tabName);
    if (g.rows.length > 0) {
      var startRow = sheet.getLastRow() + 1;
      sheet.getRange(startRow, 1, g.rows.length, EVENT_HEADERS.length)
        .setValues(g.rows);
      appendedTotal += g.rows.length;
    }
    upsertIndexRow(ss, g.tabName, g.startedAt, g.operator, sheet.getSheetId());
  });

  return jsonResponse({ success: true, appended: appendedTotal });
}

// Build the tab name from campaign name + start timestamp. Sheets caps
// tab names at 100 chars; if the campaign name is too long it gets
// truncated. The startedAt timestamp disambiguates same-name campaigns.
function buildTabName(campaign, startedAt) {
  var name = (campaign || 'Unnamed').toString().trim();
  var ts = (startedAt || '').toString().trim();
  var dt = ts ? formatStartedAt(ts) : '';
  // Sheets disallows : in tab names — replace with .
  var safeName = name.replace(/[:\\/?*\[\]]/g, '-');
  var combined = dt ? (safeName + ' · ' + dt) : safeName;
  if (combined.length > 95) {
    combined = combined.substring(0, 92) + '...';
  }
  return combined;
}

function formatStartedAt(iso) {
  try {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    var pad = function(n) { return n < 10 ? '0' + n : '' + n; };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
      + ' ' + pad(d.getHours()) + '.' + pad(d.getMinutes());
  } catch (_) {
    return iso;
  }
}

// Find-or-create a per-campaign tab. New tabs get the header row written
// + frozen, plus column widths tuned to fit the event values.
function ensureCampaignTab(ss, tabName) {
  var sheet = ss.getSheetByName(tabName);
  if (sheet) return sheet;

  sheet = ss.insertSheet(tabName);
  sheet.getRange(1, 1, 1, EVENT_HEADERS.length)
    .setValues([EVENT_HEADERS])
    .setFontWeight('bold')
    .setBackground('#f1f3f4');
  sheet.setFrozenRows(1);

  // Column widths — match the sheet-no-truncation variant 1 picks.
  var widths = [150, 200, 80, 230, 240, 280, 320];
  for (var i = 0; i < widths.length; i++) {
    sheet.setColumnWidth(i + 1, widths[i]);
  }

  // Conditional formatting: tint WARN rows yellow, ERROR rows red.
  applySeverityFormatting(sheet);

  return sheet;
}

function applySeverityFormatting(sheet) {
  var lastRow = Math.max(sheet.getMaxRows(), 1000);
  var range = sheet.getRange(2, 1, lastRow - 1, EVENT_HEADERS.length);
  var existing = sheet.getConditionalFormatRules() || [];

  var warnRule = SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=$C2="WARN"')
    .setBackground('#fff4d6')
    .setFontColor('#8a5a00')
    .setBold(true)
    .setRanges([range])
    .build();

  var errorRule = SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=$C2="ERROR"')
    .setBackground('#fce4e4')
    .setFontColor('#a1252b')
    .setBold(true)
    .setRanges([range])
    .build();

  sheet.setConditionalFormatRules(existing.concat([warnRule, errorRule]));
}

// ═══════════════════════════════════════════════════════════════════════════
// Index tab — overview of every campaign tab with live formula counts
// ═══════════════════════════════════════════════════════════════════════════

function ensureIndexTab(ss) {
  var sheet = ss.getSheetByName(INDEX_SHEET_NAME);
  if (sheet) return sheet;

  sheet = ss.insertSheet(INDEX_SHEET_NAME, 0); // first position
  sheet.getRange(1, 1, 1, INDEX_HEADERS.length)
    .setValues([INDEX_HEADERS])
    .setFontWeight('bold')
    .setBackground('#fffbe6');
  sheet.setFrozenRows(1);

  var widths = [320, 150, 200, 100, 80, 90, 150, 90];
  for (var i = 0; i < widths.length; i++) {
    sheet.setColumnWidth(i + 1, widths[i]);
  }
  return sheet;
}

// Insert or refresh the Index row for a given tab. Uses formulas to
// keep totals live — they auto-update as new rows append to that tab.
// gid must be the numeric sheet ID from sheet.getSheetId() so the
// HYPERLINK target resolves to a real in-sheet anchor.
function upsertIndexRow(ss, tabName, startedAt, operator, gid) {
  var index = ensureIndexTab(ss);
  var lastRow = index.getLastRow();

  // Look up existing row by exact tab-name match in column A.
  var existingRowNum = -1;
  if (lastRow >= 2) {
    var existing = index.getRange(2, 1, lastRow - 1, 1).getValues();
    for (var i = 0; i < existing.length; i++) {
      if (existing[i][0] === tabName) {
        existingRowNum = i + 2;
        break;
      }
    }
  }

  var quotedName = "'" + tabName.replace(/'/g, "''") + "'";
  var linkFormula = (gid || gid === 0)
    ? '=HYPERLINK("#gid=' + gid + '", "Open")'
    : '"—"';
  var values = [
    tabName,
    startedAt || '',
    operator || '',
    '=IFERROR(COUNTA(' + quotedName + '!A2:A), 0)',
    '=IFERROR(COUNTIF(' + quotedName + '!C:C, "ERROR"), 0)',
    '=IFERROR(COUNTIF(' + quotedName + '!C:C, "WARN"), 0)',
    '=IFERROR(INDEX(' + quotedName + '!A:A, COUNTA(' + quotedName + '!A:A)), "")',
    linkFormula
  ];

  if (existingRowNum === -1) {
    var newRow = Math.max(lastRow + 1, 2);
    index.getRange(newRow, 1, 1, values.length).setValues([values]);
  } else {
    index.getRange(existingRowNum, 1, 1, values.length).setValues([values]);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Action: deleteAllTabs (operator menu-triggered, also exposed via HTTP)
// ═══════════════════════════════════════════════════════════════════════════
// Deletes every tab except 'Index'. The Index tab's data rows get cleared.
// Apps Script disallows deleting the last sheet — Index is always retained.

function handleDeleteAllTabs() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var index = ensureIndexTab(ss);
  var sheets = ss.getSheets();
  var deleted = 0;

  for (var i = 0; i < sheets.length; i++) {
    var s = sheets[i];
    if (s.getName() === INDEX_SHEET_NAME) continue;
    ss.deleteSheet(s);
    deleted++;
  }

  // Clear Index data rows (keep header).
  var lastRow = index.getLastRow();
  if (lastRow >= 2) {
    index.getRange(2, 1, lastRow - 1, INDEX_HEADERS.length).clearContent();
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
  var tabs = ss.getSheets().filter(function(s) {
    return s.getName() !== INDEX_SHEET_NAME;
  });
  var count = tabs.length;

  if (count === 0) {
    ui.alert('Nothing to delete', 'No per-campaign log tabs found.', ui.ButtonSet.OK);
    return;
  }

  var oldest = tabs[0].getName();
  var newest = tabs[tabs.length - 1].getName();
  var msg = 'This will remove ' + count + ' per-campaign tab' + (count === 1 ? '' : 's') + '.\n\n'
    + 'Oldest: ' + oldest + '\n'
    + 'Newest: ' + newest + '\n\n'
    + 'The Index tab will be kept. Deleted tabs cannot be recovered.';
  var resp = ui.alert('Delete all log tabs?', msg, ui.ButtonSet.OK_CANCEL);
  if (resp !== ui.Button.OK) return;

  handleDeleteAllTabs();
  ui.alert('Done', 'Deleted ' + count + ' tab' + (count === 1 ? '' : 's') + '.', ui.ButtonSet.OK);
}

// Builds a Markdown table of all WARN/ERROR rows in the active tab, plus
// up to 3 INFO rows of context around each flagged row. Shows the result
// in a dialog the operator can copy with Ctrl+A → Ctrl+C.
function menuCopyDiagnosticSnippet() {
  var ui = SpreadsheetApp.getUi();
  var sheet = SpreadsheetApp.getActiveSheet();
  var name = sheet.getName();

  if (name === INDEX_SHEET_NAME) {
    ui.alert('Open a campaign tab first', 'The diagnostic snippet helper reads the currently-active campaign tab.', ui.ButtonSet.OK);
    return;
  }

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    ui.alert('Empty tab', 'No events on this tab yet.', ui.ButtonSet.OK);
    return;
  }

  var all = sheet.getRange(2, 1, lastRow - 1, EVENT_HEADERS.length).getValues();
  var flagged = [];
  for (var i = 0; i < all.length; i++) {
    var sev = (all[i][2] || '').toString().toUpperCase();
    if (sev === 'WARN' || sev === 'ERROR') flagged.push(i);
  }

  if (flagged.length === 0) {
    ui.alert('No issues found', 'This tab has no WARN or ERROR rows.', ui.ButtonSet.OK);
    return;
  }

  // Build a kept-row set: every flagged row + 3 INFO rows of context around each.
  var keep = {};
  flagged.forEach(function(idx) {
    for (var d = -3; d <= 3; d++) {
      var j = idx + d;
      if (j >= 0 && j < all.length) keep[j] = true;
    }
  });

  var keptIdxs = Object.keys(keep).map(Number).sort(function(a, b) { return a - b; });

  var md = '# Ortus Operations Log — ' + name + '\n\n';
  md += 'Flagged events: ' + flagged.length + ' (' + keptIdxs.length + ' rows incl. context)\n\n';
  md += '| ' + EVENT_HEADERS.join(' | ') + ' |\n';
  md += '|' + EVENT_HEADERS.map(function() { return '---'; }).join('|') + '|\n';

  keptIdxs.forEach(function(i) {
    var r = all[i];
    md += '| ' + r.map(function(c) {
      return (c == null ? '' : c.toString()).replace(/\|/g, '\\|').replace(/\n/g, ' ');
    }).join(' | ') + ' |\n';
  });

  // Render in a dialog the operator can copy from. HTML escape the markdown.
  var html = HtmlService.createHtmlOutput(
    '<p style="font-family: Arial, sans-serif; font-size: 13px; margin: 0 0 12px;">'
    + 'Select all (Ctrl/Cmd + A) and copy (Ctrl/Cmd + C), then paste into Claude.</p>'
    + '<textarea style="width: 100%; height: 480px; font-family: monospace; font-size: 12px;" onclick="this.select()">'
    + md.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    + '</textarea>'
  ).setWidth(820).setHeight(560);
  ui.showModalDialog(html, 'Diagnostic snippet · ' + name);
}
