// fg-apps-script.js — Central Follower Growth sheet (SEPARATE deployment from
// google-apps-script.js). Owns three tabs: "FG Invites", "FG Budgets",
// "FG Funnel". Deploy: new Apps Script project → paste → Deploy as Web app,
// execute as me, access "Anyone with the link". Put the /exec URL in
// src/sheets-webapp-url.js (FG_WEBAPP_URL).

var FG_HEADER = [
  'Target Name', 'LinkedIn URL', 'Member ID', 'Company', 'Job Title',
  'Function Match', 'Geo', 'Invited By', 'Account', 'Status',
  'Invited At', 'FG Note', 'Month',
  'Run ID', 'Run At', 'Reason'
];
// Model: credits are a 30-slot pool that refills monthly AND early on accept/
// withdraw, so a stable "remaining" can't be tracked between runs. We track the
// FACTUAL "Sent" this month (monotonic, from app sends) and a "Credits Available"
// SNAPSHOT read live from the invite modal (stamped with "Observed At").
var BUDGET_HEADER = ['Account','Operator','Month','Sent','Credits Available','Observed At','Refill'];
// Fallback when an account has no budget row yet. LinkedIn's Invite-to-follow
// pool is 30/month (shown live in the invite modal; refills monthly). Per-account
// overrides live in the Allowance column. Keep in sync with FG_DEFAULT_MONTHLY_ALLOWANCE.
var DEFAULT_ALLOWANCE = 30;

// KEEP IN SYNC with FG_MASTER_HEADER in src/connections/fg-master.js.
var FG_MASTER_HEADER = [
  'First Name', 'Last Name', 'Job Title', 'Company', 'Geo',
  'LinkedIn URL', 'Member ID', 'Connected Accounts',
  'Invited', 'Invited At', 'Invited By'
];
var FG_MASTER_TAB = 'FG Master';

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000); // serialize concurrent operators
  try {
    var data = JSON.parse(e.postData.contents || '{}');
    var out;
    if (data.action === 'fgState') out = fgState_();
    else if (data.action === 'fgQueue') out = fgQueue_(data.rows || []);
    else if (data.action === 'fgMarkInvited') out = fgMarkInvited_(data);
    else if (data.action === 'fgMarkFailed') out = fgMarkFailed_(data);
    else if (data.action === 'fgObserveCredits') out = fgObserveCredits_(data);
    else if (data.action === 'fgWriteList') out = fgWriteList_(data);
    else if (data.action === 'fgReadList') out = fgReadList_(data);
    else if (data.action === 'fgUpdateListLedger') out = fgUpdateListLedger_(data);
    else if (data.action === 'fgWriteMaster') out = fgWriteMaster_(data);
    else if (data.action === 'getSheetUrl') out = { url: SpreadsheetApp.getActiveSpreadsheet().getUrl() };
    else if (data.action === 'listTabs') out = { tabs: SpreadsheetApp.getActiveSpreadsheet().getSheets().map(function (s) { return s.getName(); }) };
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
  if (fresh.length) {
    fresh.forEach(function (r) { if (r[14]) r[14] = new Date(r[14]); }); // Run At -> Date
    var startRow = sh.getLastRow() + 1;
    sh.getRange(startRow, 1, fresh.length, FG_HEADER.length).setValues(fresh);
    sh.getRange(startRow, 15, fresh.length, 1).setNumberFormat('dd mmm yyyy, HH:mm'); // Run At col (15th)
  }
  return { queued: fresh.length, skippedDuplicates: rows.length - fresh.length };
}

// ── Per-run invite-list tabs (fg-list.js) ──────────────────────────────────
// A per-run tab (named "FG YYYY-MM-DD") is BOTH the editable intent list and
// the ledger. fgWriteList creates/replaces it (the auto "Generate" path);
// fgReadList reads it back at fire time (auto + a BYO tab living in this sheet).

// Create (or fully replace) a per-run invite-list tab and write header + rows.
// Idempotent: re-generating overwrites the tab so a list never doubles up.
function fgWriteList_(data) {
  var name = String(data.tab || '').trim();
  if (!name) return { error: 'fgWriteList: missing tab name' };
  var header = data.header || [];
  var rows = data.rows || [];
  var width = header.length || (rows[0] ? rows[0].length : 0);
  if (!width) return { error: 'fgWriteList: nothing to write' };
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  else sh.clear();
  if (header.length) {
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  if (rows.length) {
    sh.getRange(2, 1, rows.length, width).setValues(rows);
  }
  return { tab: name, written: rows.length };
}

// Read a per-run invite-list tab back as raw values (header row first). A
// missing tab or a header-only tab returns { rows: [] } so the fire path skips
// cleanly (and, for a missing tab, alerts the operator).
function fgReadList_(data) {
  var name = String(data.tab || '').trim();
  if (!name) return { error: 'fgReadList: missing tab name' };
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) return { rows: [], missing: true };
  var values = sh.getDataRange().getValues();
  if (values.length < 2) return { rows: values.length ? values : [] };
  return { rows: values };
}

// Write the ledger columns (Status / Invited At / Note / Member ID) back into a
// per-run invite-list tab, matching rows by LinkedIn URL. The tab IS the ledger:
// as the cloud run sends invites, this stamps each row so an operator can see,
// in the same sheet they built, what actually went out. Only the rows named in
// `updates` are touched; everything else (their edits, other columns) is left
// alone. updates: [{ url, status, invitedAt, note, memberId }].
function fgUpdateListLedger_(data) {
  var name = String(data.tab || '').trim();
  if (!name) return { error: 'fgUpdateListLedger: missing tab name' };
  var updates = data.updates || [];
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) return { error: 'fgUpdateListLedger: tab not found: ' + name };
  if (!updates.length) return { tab: name, updated: 0 };
  var values = sh.getDataRange().getValues();
  if (values.length < 2) return { tab: name, updated: 0 };

  var header = values[0].map(function (h) { return String(h).trim().toLowerCase(); });
  function col(cands) { for (var k = 0; k < cands.length; k++) { var idx = header.indexOf(cands[k]); if (idx >= 0) return idx; } return -1; }
  var iUrl = col(['linkedin url', 'profile url', 'url', 'linkedin']);
  var iStatus = col(['status']);
  var iWhen = col(['invited at', 'invited', 'date invited']);
  var iNote = col(['note', 'notes']);
  var iMember = col(['member id', 'memberid', 'member', 'linkedin id', 'urn']);
  if (iUrl < 0) return { error: 'fgUpdateListLedger: no LinkedIn URL column in "' + name + '"' };

  function nu(u) {
    u = String(u == null ? '' : u).trim().toLowerCase();
    u = u.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[?#].*$/, '').replace(/\/+$/, '');
    return u;
  }
  var rowByUrl = {};
  for (var i = 1; i < values.length; i++) { var key = nu(values[i][iUrl]); if (key && !(key in rowByUrl)) rowByUrl[key] = i; }

  // Mutate the in-memory grid, then write each touched column back in ONE range
  // call (setValues over the full column) — far fewer Sheets ops than per-cell.
  var touched = false, n = 0;
  for (var j = 0; j < updates.length; j++) {
    var up = updates[j]; var ri = rowByUrl[nu(up.url)];
    if (ri == null) continue;
    if (iStatus >= 0 && up.status != null) values[ri][iStatus] = up.status;
    if (iWhen >= 0 && up.invitedAt != null) values[ri][iWhen] = up.invitedAt;
    if (iNote >= 0 && up.note != null) values[ri][iNote] = up.note;
    if (iMember >= 0 && up.memberId != null && up.memberId !== '') values[ri][iMember] = up.memberId;
    touched = true; n++;
  }
  if (touched) {
    var last = values.length - 1;
    function writeCol(idx) { if (idx < 0) return; var colVals = []; for (var k = 1; k < values.length; k++) colVals.push([values[k][idx]]); sh.getRange(2, idx + 1, last, 1).setValues(colVals); }
    writeCol(iStatus); writeCol(iWhen); writeCol(iNote); writeCol(iMember);
  }
  return { tab: name, updated: n };
}

// Chunked build of the FG Master tab. mode 'replace' clears the tab and writes
// the header; mode 'append' adds a chunk at the bottom. The app posts ~5k rows
// per call because one setValues cannot hold the whole network.
function fgWriteMaster_(data) {
  var name = String(data.tab || FG_MASTER_TAB).trim();
  var header = data.header || FG_MASTER_HEADER;
  var rows = data.rows || [];
  var mode = String(data.mode || 'append');
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (mode === 'replace') {
    sh.clear();
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  if (rows.length) {
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, header.length).setValues(rows);
  }
  return { tab: name, written: rows.length, mode: mode };
}

// Normalised LinkedIn URL — mirror of normUrl() in src/connections/fg-list.js.
function fgNormUrl_(url) {
  var s = String(url == null ? '' : url).trim().toLowerCase();
  if (!s) return '';
  s = s.split('?')[0].split('#')[0];
  s = s.replace(/^https?:\/\//, '').replace(/^www\./, '');
  return s.replace(/\/+$/, '');
}

// Stamp Invited / Invited At / Invited By onto FG Master rows.
// `people` is [{ memberId, url }]. Reads ONLY the two key columns (not the whole
// ~3M-cell grid) so this stays far inside the 6-minute execution limit. A missing
// tab is a no-op: a deployment that has not built the master yet is fine.
function fgStampMaster_(people, invitedBy, whenText) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(FG_MASTER_TAB);
  if (!sh) return 0;
  var last = sh.getLastRow();
  if (last < 2) return 0;
  var iUrl = FG_MASTER_HEADER.indexOf('LinkedIn URL');
  var iMember = FG_MASTER_HEADER.indexOf('Member ID');
  var iInvited = FG_MASTER_HEADER.indexOf('Invited');
  var urls = sh.getRange(2, iUrl + 1, last - 1, 1).getValues();
  var members = sh.getRange(2, iMember + 1, last - 1, 1).getValues();
  var byKey = {};
  for (var i = 0; i < urls.length; i++) {
    var mid = String(members[i][0] || '').trim();
    var key = mid || fgNormUrl_(urls[i][0]);
    if (key && !(key in byKey)) byKey[key] = i + 2; // sheet row number
    var uKey = fgNormUrl_(urls[i][0]);
    if (uKey && !(uKey in byKey)) byKey[uKey] = i + 2; // also findable by URL alone
  }
  var n = 0;
  for (var j = 0; j < people.length; j++) {
    var p = people[j] || {};
    var k = String(p.memberId || '').trim() || fgNormUrl_(p.url);
    var row = byKey[k];
    if (!row) row = byKey[fgNormUrl_(p.url)];
    if (!row) continue;
    sh.getRange(row, iInvited + 1, 1, 3).setValues([['Invited', whenText, invitedBy]]);
    n++;
  }
  return n;
}

// Flip Queued -> Invited for the given Member IDs, stamp Invited At, bump budget.
function fgMarkInvited_(data) {
  var ids = {}; (data.memberIds || []).forEach(function (id) { ids[String(id)] = true; });
  var sh = sheet_('FG Invites', FG_HEADER);
  var r = rows_(sh);
  var iMember = FG_HEADER.indexOf('Member ID');
  var iStatus = FG_HEADER.indexOf('Status');
  var iWhen = FG_HEADER.indexOf('Invited At');
  var iUrl = FG_HEADER.indexOf('LinkedIn URL');
  var now = new Date();
  var n = 0;
  var people = [];  // [{ memberId, url }] for the FG Master stamp
  for (var i = 0; i < r.data.length; i++) {
    var row = r.data[i];
    if (ids[String(row[iMember])] && row[iStatus] !== 'Invited') {
      sh.getRange(i + 2, iStatus + 1).setValue('Invited');
      sh.getRange(i + 2, iWhen + 1).setValue(now).setNumberFormat('dd mmm yyyy, HH:mm');
      people.push({ memberId: String(row[iMember] || ''), url: String(row[iUrl] || '') });
      n++;
    }
  }
  // Callers that know the URL (cloud + list runs) pass `invited` so people whose
  // Member ID is blank — a large share of the DB — still stamp on the master.
  (data.invited || []).forEach(function (p) {
    if (p && (p.memberId || p.url)) people.push({ memberId: String(p.memberId || ''), url: String(p.url || '') });
  });
  var sent = bumpBudget_(data.account, data.operator, data.month, n);
  var master = 0;
  try {
    if (people.length) {
      master = fgStampMaster_(people, String(data.account || ''), Utilities.formatDate(now, 'UTC', "yyyy-MM-dd HH:mm 'UTC'"));
    }
  } catch (err) {
    // A reporting tab must never cost us an invite record.
    master = 0;
  }
  return { invited: n, sent: sent, master: master };
}

// Flip still-'Queued' rows for a run to 'Failed' + reason. Runs post-reconcile,
// so whatever is still Queued for this Run ID was genuinely never sent.
function fgMarkFailed_(data) {
  var runId = String(data.runId || '');
  var fallback = String(data.reason || 'not sent');
  var reasons = data.reasons || {}; // { memberId: text } — per-lead reason, optional
  if (!runId) return { error: 'fgMarkFailed: runId required' };
  var sh = sheet_('FG Invites', FG_HEADER);
  var r = rows_(sh);
  var iStatus = FG_HEADER.indexOf('Status');
  var iRun = FG_HEADER.indexOf('Run ID');
  var iReason = FG_HEADER.indexOf('Reason');
  var iMember = FG_HEADER.indexOf('Member ID');
  var n = 0;
  for (var i = 0; i < r.data.length; i++) {
    if (String(r.data[i][iRun]) === runId && r.data[i][iStatus] === 'Queued') {
      var why = reasons[String(r.data[i][iMember])] || fallback; // per-lead reason, else fallback
      sh.getRange(i + 2, iStatus + 1).setValue('Failed');
      sh.getRange(i + 2, iReason + 1).setValue(why);
      n++;
    }
  }
  return { failed: n };
}

// Header-driven column index (1-based) for the FG Budgets tab; appends the column
// if it doesn't exist yet, so schema changes self-heal and column order is free.
function budgetCol_(sh, name) {
  var width = Math.max(1, sh.getLastColumn());
  var header = sh.getRange(1, 1, 1, width).getValues()[0];
  for (var i = 0; i < header.length; i++) {
    if (String(header[i] || '').trim().toLowerCase() === name.toLowerCase()) return i + 1;
  }
  var col = sh.getLastColumn() + 1;
  sh.getRange(1, col).setValue(name).setFontWeight('bold');
  return col;
}

// Bump the FACTUAL count of invites sent this account this month (monotonic).
function bumpBudget_(account, operator, month, sentDelta) {
  var sh = sheet_('FG Budgets', BUDGET_HEADER);
  var cA = budgetCol_(sh, 'Account'), cO = budgetCol_(sh, 'Operator'), cM = budgetCol_(sh, 'Month'), cS = budgetCol_(sh, 'Sent');
  var r = rows_(sh);
  for (var i = 0; i < r.data.length; i++) {
    if (r.data[i][cA - 1] === account && normMonth_(r.data[i][cM - 1]) === month) {
      var sent = (Number(r.data[i][cS - 1]) || 0) + sentDelta;
      sh.getRange(i + 2, cM).setNumberFormat('@').setValue(month); // self-heal Month -> plain text
      sh.getRange(i + 2, cS).setValue(sent);
      return sent;
    }
  }
  var newRow = sh.getLastRow() + 1;
  sh.getRange(newRow, cA).setValue(account);
  sh.getRange(newRow, cO).setValue(operator || '');
  sh.getRange(newRow, cM).setNumberFormat('@').setValue(month);
  sh.getRange(newRow, cS).setValue(sentDelta);
  return sentDelta;
}

// Write-back of the modal's observed live credit count as a SNAPSHOT (does NOT
// touch Sent — that's the factual monotonic count). Stamps Observed At + Refill.
function fgObserveCredits_(data) {
  var account = data.account, operator = data.operator, month = normMonth_(data.month);
  var available = Number(data.available);
  if (!account || !month || !isFinite(available)) return { error: 'fgObserveCredits: account, month, available required' };
  var sh = sheet_('FG Budgets', BUDGET_HEADER);
  var cA = budgetCol_(sh, 'Account'), cO = budgetCol_(sh, 'Operator'), cM = budgetCol_(sh, 'Month');
  var cAv = budgetCol_(sh, 'Credits Available'), cOb = budgetCol_(sh, 'Observed At'), cRf = budgetCol_(sh, 'Refill');
  var nowIso = new Date().toISOString();
  var refill = String(data.refill || '');
  var r = rows_(sh);
  for (var i = 0; i < r.data.length; i++) {
    if (r.data[i][cA - 1] === account && normMonth_(r.data[i][cM - 1]) === month) {
      sh.getRange(i + 2, cM).setNumberFormat('@').setValue(month);
      sh.getRange(i + 2, cAv).setValue(available);
      sh.getRange(i + 2, cOb).setValue(nowIso);
      if (refill) sh.getRange(i + 2, cRf).setValue(refill);
      return { observed: true, available: available };
    }
  }
  var newRow = sh.getLastRow() + 1;
  sh.getRange(newRow, cA).setValue(account);
  sh.getRange(newRow, cO).setValue(operator || '');
  sh.getRange(newRow, cM).setNumberFormat('@').setValue(month);
  sh.getRange(newRow, cAv).setValue(available);
  sh.getRange(newRow, cOb).setValue(nowIso);
  if (refill) sh.getRange(newRow, cRf).setValue(refill);
  return { observed: true, available: available };
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

// One-time migration: run once from the Apps Script editor. Backfills the
// Run ID/Run At/Reason schema onto pre-existing rows, relabels stuck legacy
// Queued rows as Failed, adds Sent/Stuck helper flag columns, and (re)builds
// the Run Health tab (QUERY + Result/Credits left/Note formulas).
function fgMigrateRunHealth() { // no trailing "_" — Apps Script hides _-suffixed fns from the Run picker
  var ss = SpreadsheetApp.getActive();
  var sh = sheet_('FG Invites', FG_HEADER); // ensures the 3 new headers exist
  var last = sh.getLastRow();
  if (last > 1) {
    var iWhen = FG_HEADER.indexOf('Invited At');   // 10
    var iRun = FG_HEADER.indexOf('Run ID');        // 13
    var iRunAt = FG_HEADER.indexOf('Run At');      // 14
    var iStatus = FG_HEADER.indexOf('Status');     // 9
    var rng = sh.getRange(2, 1, last - 1, FG_HEADER.length);
    var vals = rng.getValues();
    for (var i = 0; i < vals.length; i++) {
      if (!vals[i][iRun]) vals[i][iRun] = 'legacy';
      if (!vals[i][iRunAt] && vals[i][iWhen]) vals[i][iRunAt] = new Date(vals[i][iWhen]);
      // Old Invited At was written as an ISO *string*; a number-format on text is a
      // no-op, so coerce each to a real Date value here — THEN the format renders it.
      if (vals[i][iWhen] && !(vals[i][iWhen] instanceof Date)) vals[i][iWhen] = new Date(vals[i][iWhen]);
      if (vals[i][iStatus] === 'Queued') { vals[i][iStatus] = 'Failed'; vals[i][FG_HEADER.indexOf('Reason')] = 'legacy — never confirmed'; }
    }
    rng.setValues(vals);
    sh.getRange(2, iRunAt + 1, last - 1, 1).setNumberFormat('dd mmm yyyy, HH:mm');
    sh.getRange(2, iWhen + 1, last - 1, 1).setNumberFormat('dd mmm yyyy, HH:mm');
  }
  // Sent/Stuck flag helper columns (Q, R) as whole-column array formulas.
  sh.getRange('Q1').setValue('Sent1');
  sh.getRange('R1').setValue('Stuck1');
  sh.getRange('Q2').setFormula('=ARRAYFORMULA(IF(J2:J="Invited",1,0))');
  sh.getRange('R2').setFormula('=ARRAYFORMULA(IF(J2:J="Failed",1,0))');

  // Hide machine keys + helper flags from the human view — still written by the app
  // and read by the Run Health QUERY, just off-screen. Leaves the calm visible set:
  // Target Name · Company · Job Title · Invited By · Account · Status · Invited At · Reason · Month.
  // B=LinkedIn URL, C=Member ID, F=Function Match, G=Geo, L=FG Note, N=Run ID, O=Run At, Q=Sent1, R=Stuck1.
  [2, 3, 6, 7, 12, 14, 15, 17, 18].forEach(function (c) { sh.hideColumns(c); });

  // Run Health tab.
  var rh = ss.getSheetByName('Run Health') || ss.insertSheet('Run Health', 0);
  rh.clear();
  rh.getRange('A1').setValue('Run Health · one row per account × run · newest first').setFontWeight('bold');
  // The QUERY: group by Run At, Account, Operator; count targeted; sum sent/stuck.
  rh.getRange('A3').setFormula(
    "=QUERY('FG Invites'!A2:R, \"select O, I, H, count(A), sum(Q), sum(R) " +
    "where N is not null group by O, I, H order by O desc " +
    "label O 'Run At', I 'Account', H 'Operator', count(A) 'Targeted', sum(Q) 'Sent', sum(R) 'Stuck'\", 0)"
  );
  // Derived Result / Credits left / Note next to the QUERY block.
  rh.getRange('G3').setValue('Result');
  rh.getRange('H3').setValue('Credits left');
  rh.getRange('I3').setValue('Note');
  rh.getRange('G4').setFormula(
    '=ARRAYFORMULA(IF(LEN(A4:A)=0,,IF(E4:E>=D4:D,"✓ All sent",IF(E4:E=0,"✗ Nothing sent","◑ Partial"))))'
  );
  rh.getRange('H4').setFormula('=ARRAYFORMULA(IF(LEN(A4:A)=0,,MAX(0,30-E4:E)&" / 30"))');
  rh.getRange('I4').setFormula(
    "=MAP(A4:A,B4:B,LAMBDA(ra,acc,IF(ra=\"\",\"\"," +
    "IFERROR(INDEX(FILTER('FG Invites'!P:P,('FG Invites'!I:I=acc)*('FG Invites'!O:O=ra)*('FG Invites'!J:J=\"Failed\")),1),\"\"))))"
  );
  // Conditional formatting on Result (col G).
  var mk = function (text, bg, fg) {
    return SpreadsheetApp.newConditionalFormatRule()
      .whenTextContains(text).setBackground(bg).setFontColor(fg)
      .setRanges([rh.getRange('G4:G1000')]).build();
  };
  rh.setConditionalFormatRules([
    mk('✓', '#e6f4ea', '#137333'),
    mk('◑', '#fef7e0', '#b06000'),
    mk('✗', '#fce8e6', '#c5221f'),
  ]);
  rh.setFrozenRows(3);
  return 'migrated';
}
