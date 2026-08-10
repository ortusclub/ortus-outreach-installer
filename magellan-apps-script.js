// magellan-apps-script.js — Operation Magellan's own sheet (a SEPARATE
// deployment from google-apps-script.js and fg-apps-script.js).
//
// Deploy:
//   1. Create a new Google Sheet, name it "Operation Magellan".
//   2. Extensions → Apps Script → paste this file over Code.gs → Save.
//   3. Deploy → New deployment → Web app
//        Execute as: Me
//        Who has access: Anyone with the link
//   4. Copy the /exec URL into src/sheets-webapp-url.js (MAGELLAN_WEBAPP_URL).
//
// It owns four tabs, all written by the app:
//   Connections  the collected people in the cleaned LinkedHelper layout
//   Accounts     one row per Ortus account: counts, or the failure and its fix
//   Log          the run's timestamped events
//   Import       what went into HubSpot, per account
//
// No formatting work happens on the write path — dressing a 400k-row tab takes
// minutes and would hold the script lock long enough to fail every other call
// (the mistake fg-apps-script.js documents). Run mgFormat() by hand if wanted.

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var data = JSON.parse(e.postData.contents || '{}');
    var out;
    if (data.action === 'writeTab') out = mgWriteTab_(data);
    else if (data.action === 'readTab') out = mgReadTab_(data);
    else if (data.action === 'getSheetUrl') out = { url: SpreadsheetApp.getActiveSpreadsheet().getUrl() };
    else if (data.action === 'listTabs') {
      out = { tabs: SpreadsheetApp.getActiveSpreadsheet().getSheets().map(function (s) { return s.getName(); }) };
    } else out = { error: 'Unknown action: ' + data.action };
    return json_(out);
  } catch (err) {
    return json_({ error: String((err && err.message) || err) });
  } finally {
    lock.releaseLock();
  }
}

function doGet() {
  return json_({ ok: true, script: 'magellan' });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── writeTab ───────────────────────────────────────────────────────────────
// { tab, header: [...], rows: [[...]], append?: false }
// Create-or-replace by default, so re-writing a tab never doubles its rows.
function mgWriteTab_(data) {
  var name = (data.tab || '').toString().trim().substring(0, 95);
  if (!name) return { error: 'writeTab: missing tab name' };

  var header = data.header || [];
  var rows = data.rows || [];
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name) || ss.insertSheet(name);

  if (!data.append) sheet.clear();

  var width = header.length || (rows.length && rows[0] ? rows[0].length : 0);
  if (!width) return { ok: true, tab: name, written: 0, url: ss.getUrl() };

  var startRow = data.append ? Math.max(sheet.getLastRow() + 1, 1) : 1;
  if (!data.append && header.length) {
    sheet.getRange(1, 1, 1, header.length).setValues([header])
      .setFontWeight('bold').setBackground('#f1f3f4');
    sheet.setFrozenRows(1);
    startRow = 2;
  }

  // setValues rejects ragged arrays — pad every row to the full width.
  var padded = [];
  for (var i = 0; i < rows.length; i++) {
    var r = (rows[i] || []).slice(0, width);
    while (r.length < width) r.push('');
    padded.push(r);
  }
  if (padded.length) sheet.getRange(startRow, 1, padded.length, width).setValues(padded);

  return { ok: true, tab: name, written: padded.length, url: ss.getUrl() };
}

// ── readTab ────────────────────────────────────────────────────────────────
// Raw values, header row first. Lets the app read back what it wrote — the
// only way to be sure a write landed.
function mgReadTab_(data) {
  var name = (data.tab || '').toString().trim();
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sheet) return { error: 'readTab: no tab named ' + name };
  var last = sheet.getLastRow();
  if (last < 1) return { rows: [] };
  return { rows: sheet.getRange(1, 1, last, sheet.getLastColumn()).getValues() };
}

// ── Formatting (manual) ────────────────────────────────────────────────────
// Run from the editor when the sheet needs tidying. Never called from doPost.
function mgFormat() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    var s = sheets[i];
    if (s.getLastColumn() > 0) s.autoResizeColumns(1, s.getLastColumn());
  }
}
