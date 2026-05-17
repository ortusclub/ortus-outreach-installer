/**
 * Ortus Campaign Activity — Apps Script bridge.
 *
 * Container-bound to the spreadsheet:
 *   "CAMPAIGN ACTIVITY - ORTUS OUTREACH - DO NOT DELETE"
 *   https://docs.google.com/spreadsheets/d/1NZtZdhwqoYMHzk0nC5sQWlsOg3ij0sZpWYUZMO79dOQ/
 *
 * Receives one POST per completed campaign run from the Ortus Outreach
 * bot and appends a row with the campaign metadata + template preview.
 *
 * Deployment:
 *   1. Open the "CAMPAIGN ACTIVITY - ORTUS OUTREACH - DO NOT DELETE" sheet.
 *   2. Extensions → Apps Script.
 *   3. Paste this file's contents over the default Code.gs.
 *   4. Deploy → New deployment → Web app → Execute as: Me, Access: Anyone
 *      with the link.
 *   5. Copy the deployment URL into the bot's .env as
 *      CAMPAIGN_LOG_WEBAPP_URL.
 *
 * Actions accepted via doPost:
 *   - appendRun: { entry: { ts, name, mode, profiles, operator,
 *       totalLeads, processed, errors, durationSec, endReason,
 *       templatePreview, sheetUrl } }
 *
 * The sheet has one tab ('Campaigns'). Header row is provisioned on first
 * append. Subsequent calls append at the bottom — no in-place updates.
 */

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

var TAB_NAME = 'Campaigns';
var HEADERS = [
  'Started', 'Operator', 'Campaign Name', 'Mode', 'Profiles Used',
  'Total Leads', 'Processed', 'Errors', 'Duration', 'End Reason',
  'Templates Used', 'Sheet URL'
];

// ═══════════════════════════════════════════════════════════════════════════
// HTTP entry point
// ═══════════════════════════════════════════════════════════════════════════

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    switch (data.action) {
      case 'appendRun':
        return handleAppendRun(data);
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
    service: 'Ortus Campaign Activity',
    deployed: new Date().toISOString()
  });
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ═══════════════════════════════════════════════════════════════════════════
// Action: appendRun
// ═══════════════════════════════════════════════════════════════════════════

function handleAppendRun(data) {
  var entry = data.entry || {};
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ensureTab(ss);

  var row = [
    entry.ts || '',
    entry.operator || '',
    entry.name || '',
    entry.mode || '',
    Array.isArray(entry.profiles) ? entry.profiles.join(', ') : (entry.profiles || ''),
    Number(entry.totalLeads || 0),
    Number(entry.processed || 0),
    Number(entry.errors || 0),
    formatDuration(entry.durationSec || 0),
    entry.endReason || '',
    entry.templatePreview || '',
    entry.sheetUrl || ''
  ];

  var nextRow = sheet.getLastRow() + 1;
  sheet.getRange(nextRow, 1, 1, HEADERS.length).setValues([row]);

  return jsonResponse({ success: true, row: nextRow });
}

function formatDuration(sec) {
  var s = Math.max(0, Math.round(Number(sec) || 0));
  var h = Math.floor(s / 3600);
  var m = Math.floor((s % 3600) / 60);
  var pad = function(n) { return n < 10 ? '0' + n : '' + n; };
  return pad(h) + 'h ' + pad(m) + 'm';
}

function ensureTab(ss) {
  var sheet = ss.getSheetByName(TAB_NAME);
  if (sheet) return sheet;

  // First-time setup. If the only sheet is the default 'Sheet1', rename
  // it; otherwise insert a new one.
  var sheets = ss.getSheets();
  if (sheets.length === 1 && sheets[0].getName() === 'Sheet1') {
    sheet = sheets[0];
    sheet.setName(TAB_NAME);
  } else {
    sheet = ss.insertSheet(TAB_NAME);
  }

  sheet.getRange(1, 1, 1, HEADERS.length)
    .setValues([HEADERS])
    .setFontWeight('bold')
    .setBackground('#f1f3f4');
  sheet.setFrozenRows(1);

  // Column widths matched to the central-logs sketch.
  var widths = [120, 170, 180, 170, 200, 100, 100, 90, 100, 120, 300, 220];
  for (var i = 0; i < widths.length; i++) {
    sheet.setColumnWidth(i + 1, widths[i]);
  }
  return sheet;
}
