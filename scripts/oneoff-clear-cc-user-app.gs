/**
 * ONE-OFF SoO maintenance (run from the Ortus tracker Apps Script project,
 * which already has openById access to the SoO sheet). Two functions:
 *
 *   1) scanSoOForSharedEmails()      — DISCOVERY. Logs every column on the
 *      'LinkedIn Accounts' tab that contains antonio@/ortus@, with the column
 *      letter, header, and count. Read-only. Run this FIRST to find where the
 *      stray shared-login stamps actually live (column AJ "CC App User" came
 *      back empty, so they're in some other column).
 *
 *   2) clearSharedStampsFromColumn() — CLEANUP. Blanks antonio@/ortus@ in ONE
 *      column you choose (set TARGET_COL to the column number the scan reports).
 *      DRY_RUN by default. The real operator for those historical rows is
 *      unrecoverable (every run came in as the shared login), so blanking is the
 *      only honest fix — each account re-stamps with the real operator on next use.
 */

var SOO_SS_ID = '1t49JaZppDZZNIUuOv2QQw7j1MCZC8vMMy1uZe_AkLwI';
var SOO_GID   = 992076199;                 // the "LinkedIn Accounts" tab
var SHARED    = ['antonio@ortusclub.com', 'ortus@ortusclub.com'];

function _sooSheet_() {
  var ss = SpreadsheetApp.openById(SOO_SS_ID), all = ss.getSheets();
  for (var i = 0; i < all.length; i++) if (all[i].getSheetId() === SOO_GID) return all[i];
  throw new Error('Tab gid ' + SOO_GID + ' not found in ' + SOO_SS_ID);
}
function _colLetter_(n) { var s = ''; while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }

// ── 1) DISCOVERY — where do the shared-login emails live? (read-only) ──
function scanSoOForSharedEmails() {
  var sheet = _sooSheet_();
  var lastRow = sheet.getLastRow(), lastCol = sheet.getLastColumn();
  Logger.log('Tab "%s": %s rows x %s cols', sheet.getName(), lastRow, lastCol);
  if (lastRow < 2) { Logger.log('No data rows.'); return; }

  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var grid = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  var hits = [];
  for (var c = 0; c < lastCol; c++) {
    var n = 0;
    for (var r = 0; r < grid.length; r++) {
      var v = String(grid[r][c] || '').toLowerCase().trim();
      if (SHARED.indexOf(v) !== -1) n++;
    }
    if (n > 0) hits.push('col ' + (c + 1) + ' (' + _colLetter_(c + 1) + ') "' + headers[c] + '": ' + n);
  }
  Logger.log(hits.length ? ('Shared-login stamps found in:\n' + hits.join('\n')) : 'No antonio@/ortus@ stamps found in ANY column.');
}

// ── 1b) DEEP DISCOVERY — substring match + show real sample values (read-only) ──
// Catches values with surrounding text (e.g. "antonio@ortusclub.com (manual)")
// that the exact-match scan above misses, and prints what's actually in the cells.
function scanSoODeep() {
  var sheet = _sooSheet_();
  var lastRow = sheet.getLastRow(), lastCol = sheet.getLastColumn();
  if (lastRow < 2) { Logger.log('No data rows.'); return; }
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var grid = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  var NEEDLES = ['antonio', 'ortus@ortusclub.com', '@ortusclub.com'];
  var out = [];
  for (var c = 0; c < lastCol; c++) {
    var n = 0, samples = [];
    for (var r = 0; r < grid.length; r++) {
      var raw = String(grid[r][c] || '').trim();
      var lc = raw.toLowerCase();
      var hit = false;
      for (var k = 0; k < NEEDLES.length; k++) if (lc.indexOf(NEEDLES[k]) !== -1) { hit = true; break; }
      if (hit) { n++; if (samples.length < 3 && samples.indexOf(raw) === -1) samples.push(raw); }
    }
    if (n > 0) out.push('col ' + (c + 1) + ' (' + _colLetter_(c + 1) + ') "' + headers[c] + '": ' + n + ' — e.g. ' + samples.join(' | '));
  }
  Logger.log(out.length ? ('@ortusclub.com / antonio matches:\n' + out.join('\n')) : 'No @ortusclub.com / antonio values found in ANY column.');
}

// ── 2) CLEANUP — blank antonio@/ortus@ in ONE column (set TARGET_COL) ──
function clearSharedStampsFromColumn() {
  var DRY_RUN    = true;   // ← leave true to preview; set false to apply
  var TARGET_COL = 36;     // ← set to the column number the scan above reported

  var sheet = _sooSheet_();
  var header = String(sheet.getRange(1, TARGET_COL).getValue() || '');
  var lastRow = sheet.getLastRow();
  Logger.log('Target: column %s (%s) header = "%s"', TARGET_COL, _colLetter_(TARGET_COL), header);
  if (lastRow < 2) { Logger.log('No data rows.'); return; }

  var rng = sheet.getRange(2, TARGET_COL, lastRow - 1, 1), vals = rng.getValues();
  var cleared = 0, sampleRows = [];
  for (var r = 0; r < vals.length; r++) {
    var v = String(vals[r][0] || '').toLowerCase().trim();
    if (SHARED.indexOf(v) !== -1) { cleared++; if (sampleRows.length < 8) sampleRows.push(r + 2); vals[r][0] = ''; }
  }
  if (DRY_RUN) { Logger.log('DRY RUN — would clear %s cell(s). Sample rows: [%s]. No changes. Set DRY_RUN=false to apply.', cleared, sampleRows.join(', ')); return; }
  if (cleared > 0) rng.setValues(vals);
  Logger.log('DONE — cleared %s shared-login stamp(s) from %s ("%s").', cleared, _colLetter_(TARGET_COL), header);
}
