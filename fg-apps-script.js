// fg-apps-script.js — Central Follower Growth sheet (SEPARATE deployment from
// google-apps-script.js). Owns three tabs: "FG Invites", "FG Budgets",
// "FG Funnel". Deploy: new Apps Script project → paste → Deploy as Web app,
// execute as me, access "Anyone with the link". Put the /exec URL in
// src/sheets-webapp-url.js (FG_WEBAPP_URL).

var FG_HEADER = ['Target Name','LinkedIn URL','Member ID','Company','Job Title',
  'Function Match','Geo','Invited By','Account','Status','Invited At','FG Note','Month'];
var BUDGET_HEADER = ['Account','Operator','Month','Allowance','Sent','Remaining'];
// Fallback when an account has no budget row yet. LinkedIn's Invite-to-follow
// pool is 30/month (shown live in the invite modal; refills monthly). Per-account
// overrides live in the Allowance column. Keep in sync with FG_DEFAULT_MONTHLY_ALLOWANCE.
var DEFAULT_ALLOWANCE = 30;

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000); // serialize concurrent operators
  try {
    var data = JSON.parse(e.postData.contents || '{}');
    var out;
    if (data.action === 'fgState') out = fgState_();
    else if (data.action === 'fgQueue') out = fgQueue_(data.rows || []);
    else if (data.action === 'fgMarkInvited') out = fgMarkInvited_(data);
    else out = { error: 'Unknown action: ' + data.action };
    return json_(out);
  } catch (err) {
    return json_({ error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}
function doGet() { return json_({ ok: true, service: 'fg' }); }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

function sheet_(name, header) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}
function rows_(sh) {
  var rng = sh.getDataRange().getValues();
  if (rng.length < 2) return { header: rng[0] || [], data: [] };
  return { header: rng[0], data: rng.slice(1) };
}
function asObjects_(sh) {
  var r = rows_(sh);
  return r.data.map(function (row) {
    var o = {}; r.header.forEach(function (h, i) { o[h] = row[i]; }); return o;
  });
}
function keyOf_(memberId, url) { return String(memberId || '') || String(url || ''); }

// Coerce a Month cell (a Date object from getValues, a tz-shifted ISO string, or
// a plain "YYYY-MM") to a plain "YYYY-MM". Sheets turns a "2026-06" string into a
// Date at midnight on the 1st in the sheet timezone, which over UTC reads back as
// the last day of the previous month — nudge +12h before taking the UTC
// year-month so any ±12h offset rounds back to the intended month. Keep in sync
// with normMonth() in src/connections/fg-export.js.
function normMonth_(value) {
  if (value === null || value === undefined || value === '') return '';
  var ms;
  if (Object.prototype.toString.call(value) === '[object Date]') {
    ms = value.getTime();
  } else {
    var s = String(value);
    if (/^\d{4}-\d{2}$/.test(s)) return s;
    ms = Date.parse(s);
    if (isNaN(ms)) return s;
  }
  var d = new Date(ms + 12 * 60 * 60 * 1000);
  return d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2);
}

function fgState_() {
  var inv = sheet_('FG Invites', FG_HEADER);
  var bud = sheet_('FG Budgets', BUDGET_HEADER);
  var budgets = asObjects_(bud).map(function (o) { o['Month'] = normMonth_(o['Month']); return o; });
  return { invites: asObjects_(inv), budgets: budgets, funnel: fgFunnel_() };
}

// Append rows that aren't already present (by Member-ID-or-URL).
function fgQueue_(rows) {
  var sh = sheet_('FG Invites', FG_HEADER);
  var existing = {};
  asObjects_(sh).forEach(function (o) { existing[keyOf_(o['Member ID'], o['LinkedIn URL'])] = true; });
  var fresh = rows.filter(function (r) { return !existing[keyOf_(r[2], r[1])]; }); // r[2]=Member ID, r[1]=URL
  if (fresh.length) sh.getRange(sh.getLastRow() + 1, 1, fresh.length, FG_HEADER.length).setValues(fresh);
  return { queued: fresh.length, skippedDuplicates: rows.length - fresh.length };
}

// Flip Queued -> Invited for the given Member IDs, stamp Invited At, bump budget.
function fgMarkInvited_(data) {
  var ids = {}; (data.memberIds || []).forEach(function (id) { ids[String(id)] = true; });
  var sh = sheet_('FG Invites', FG_HEADER);
  var r = rows_(sh);
  var iMember = FG_HEADER.indexOf('Member ID');
  var iStatus = FG_HEADER.indexOf('Status');
  var iWhen = FG_HEADER.indexOf('Invited At');
  var now = new Date().toISOString();
  var n = 0;
  for (var i = 0; i < r.data.length; i++) {
    var row = r.data[i];
    if (ids[String(row[iMember])] && row[iStatus] !== 'Invited') {
      sh.getRange(i + 2, iStatus + 1).setValue('Invited');
      sh.getRange(i + 2, iWhen + 1).setValue(now);
      n++;
    }
  }
  var remaining = bumpBudget_(data.account, data.operator, data.month, n);
  return { invited: n, remaining: remaining };
}

function bumpBudget_(account, operator, month, sentDelta) {
  var sh = sheet_('FG Budgets', BUDGET_HEADER);
  var r = rows_(sh);
  for (var i = 0; i < r.data.length; i++) {
    if (r.data[i][0] === account && normMonth_(r.data[i][2]) === month) {
      var allowance = Number(r.data[i][3]) || DEFAULT_ALLOWANCE;
      var sent = (Number(r.data[i][4]) || 0) + sentDelta;
      sh.getRange(i + 2, 3).setNumberFormat('@').setValue(month); // self-heal Month -> plain text
      sh.getRange(i + 2, 5).setValue(sent);             // Sent
      sh.getRange(i + 2, 6).setValue(allowance - sent); // Remaining
      return allowance - sent;
    }
  }
  // No row yet -> create one. Force the Month cell to plain text so Sheets never
  // coerces "2026-06" into a tz-shifted Date that breaks future matching.
  var allowance = DEFAULT_ALLOWANCE;
  var newRow = sh.getLastRow() + 1;
  sh.getRange(newRow, 1, 1, BUDGET_HEADER.length)
    .setValues([[account, operator || '', month, allowance, sentDelta, allowance - sentDelta]]);
  sh.getRange(newRow, 3).setNumberFormat('@').setValue(month);
  return allowance - sentDelta;
}

// Funnel rollup per operator: eligible-pool isn't known here (lives in the app),
// so the funnel reports Invited counts per operator + total from FG Invites.
function fgFunnel_() {
  var sh = sheet_('FG Invites', FG_HEADER);
  var byOp = {}; var total = 0;
  asObjects_(sh).forEach(function (o) {
    if (o['Status'] === 'Invited') { var k = o['Invited By'] || '—'; byOp[k] = (byOp[k] || 0) + 1; total++; }
  });
  var out = Object.keys(byOp).map(function (k) { return { operator: k, invited: byOp[k] }; });
  out.push({ operator: 'TOTAL', invited: total });
  return out;
}
