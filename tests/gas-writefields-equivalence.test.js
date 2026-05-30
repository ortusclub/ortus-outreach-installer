import { test } from 'node:test';
import assert from 'node:assert/strict';

// ─────────────────────────────────────────────────────────────────────────────
// Equivalence harness for the Apps Script writeFields() batching reorder.
//
// google-apps-script.js runs on Google's servers — we can't execute it here.
// So we port BOTH the OLD (pre-reorder) and NEW (batched) writeFields verbatim,
// run them against an identical fake SpreadsheetApp that records every cell
// operation, and assert:
//   (1) final cell state is byte-identical,
//   (2) the `updated` return array is identical,
//   (3) the audit-log call is identical,
//   (4) the NEW version performs <= the reads of the OLD (the whole point).
// If (1)-(3) ever diverge, the reorder changed behaviour and must not ship.
// ─────────────────────────────────────────────────────────────────────────────

// --- constants copied verbatim from google-apps-script.js ---
const ACTION_COLUMNS = ['OP', 'Message', 'InMail'];
const FIELD_MAP = {
  status: 'Connection Request Status',
  cc: 'Connection Accepted Status',
  op: 'OP',
  message: 'Message',
  inmail: 'InMail',
  accountUsed: 'Account Used',
  linkedinUrn: 'LinkedIn URN',
  linkedinMemberId: 'LinkedIn Membership ID',
  openProfile: 'Open Profile',
  connectedAlready: 'Connected',
  stage: 'Stage',
  sender: 'Sender',
  connectionStatus: 'Connection Request Status',
  dmStatus: 'DM Status',
  opStatus: 'OP Status',
  inmStatus: 'InM Status',
  introStatus: 'Intro Status',
  checkStatus: 'Connection Accepted Status',
  introductionStatus: 'Introduction Status',
  Reply: 'Reply',
  ReplyAt: 'Reply At',
  ReplyPreview: 'Reply Preview',
};

// --- deterministic stand-ins for the Apps Script globals ---
const Session = { getScriptTimeZone: () => 'UTC' };
const Utilities = {
  formatDate: (_d, _tz, fmt) => (fmt === 'yyyy-MM-dd' ? '2026-05-29' : '12:34:56'),
};
let _auditCalls = [];
function appendAuditLog(_parent, entry) { _auditCalls.push(entry); }

// --- fake sheet that records reads/writes; cells are {v} (value) or {f} (formula) ---
class FakeSheet {
  constructor(headers, row2 = {}) {
    this.headers = headers.slice();
    this.cells = {};
    this.reads = 0;
    headers.forEach((h, i) => { this.cells[`1,${i + 1}`] = { v: h }; });
    Object.keys(row2).forEach((colName) => {
      const idx = headers.indexOf(colName);
      if (idx !== -1) this.cells[`2,${idx + 1}`] = { v: row2[colName] };
    });
  }
  _raw(r, c) {
    const e = this.cells[`${r},${c}`];
    if (!e) return '';
    return ('f' in e) ? e.f : e.v;
  }
  getRange(r, c, numRows, numCols) {
    const self = this;
    if (numRows === undefined) {
      return {
        setValue(v) { self.cells[`${r},${c}`] = { v }; return this; },
        setFormula(f) { self.cells[`${r},${c}`] = { f }; return this; },
        setFontWeight() { return this; },
        getValue() { self.reads++; return self._raw(r, c); },
      };
    }
    return {
      getValues() {
        self.reads++;
        const out = [];
        for (let i = 0; i < numRows; i++) {
          const arr = [];
          for (let j = 0; j < numCols; j++) arr.push(self._raw(r + i, c + j));
          out.push(arr);
        }
        return out;
      },
    };
  }
  getParent() { return { __fake: true }; }
  snapshot() { return JSON.stringify(this.cells); }
}

// ── OLD writeFields (verbatim from the ROLLBACK block) ──
function writeFieldsOld(sheet, headers, row, data) {
  var updated = [];
  if (data.dateLastAction !== undefined && data.dateLastAction !== null && data.dateLastAction !== '') {
    var nowDt = new Date();
    var tz = (data && data.tz) || Session.getScriptTimeZone();
    var dateStr = Utilities.formatDate(nowDt, tz, 'yyyy-MM-dd');
    var timeStr = Utilities.formatDate(nowDt, tz, 'HH:mm:ss');
    [['Date of Last Action', dateStr], ['Time of Last Action', timeStr]].forEach(function (pair) {
      var colName = pair[0], v = pair[1];
      var idx = headers.indexOf(colName);
      if (idx === -1) { idx = headers.length; sheet.getRange(1, idx + 1).setValue(colName); sheet.getRange(1, idx + 1).setFontWeight('bold'); headers.push(colName); }
      sheet.getRange(row, idx + 1).setValue(v);
      updated.push(colName);
    });
  }
  for (var field in FIELD_MAP) {
    if (data[field] !== undefined && data[field] !== null && data[field] !== '') {
      var colName = FIELD_MAP[field];
      var colIndex = headers.indexOf(colName);
      if (field === 'status' && colIndex === -1) { var altIdx = headers.indexOf('Last Action'); if (altIdx !== -1) { colIndex = altIdx; colName = 'Last Action'; } }
      if (colIndex === -1) continue;
      var cell = sheet.getRange(row, colIndex + 1);
      var value = data[field];
      if (typeof value === 'string' && value.charAt(0) === '=') { cell.setFormula(value); } else { cell.setValue(value); }
      updated.push(colName);
    }
  }
  ACTION_COLUMNS.forEach(function (col) {
    var idx = headers.indexOf(col);
    if (idx === -1) return;
    var cell = sheet.getRange(row, idx + 1);
    var cur = (cell.getValue() || '').toString().trim();
    if (cur === '') cell.setValue('—');
  });
  if (data.accountUsed) {
    appendAuditLog(sheet.getParent(), { date: data.dateLastAction || new Date().toISOString(), linkedinUrl: data.linkedinUrl || '', action: data.auditAction || data.status || '', account: data.accountUsed, notes: data.auditNotes || '' });
  }
  return updated;
}

// ── NEW writeFields (verbatim from the shipped optimized version) ──
function writeFieldsNew(sheet, headers, row, data) {
  var updated = [];
  var hasActionCols = false;
  for (var a = 0; a < ACTION_COLUMNS.length; a++) {
    if (headers.indexOf(ACTION_COLUMNS[a]) !== -1) { hasActionCols = true; break; }
  }
  var preVals = (hasActionCols && headers.length > 0)
    ? sheet.getRange(row, 1, 1, headers.length).getValues()[0]
    : null;
  if (data.dateLastAction !== undefined && data.dateLastAction !== null && data.dateLastAction !== '') {
    var nowDt = new Date();
    var tz = (data && data.tz) || Session.getScriptTimeZone();
    var dateStr = Utilities.formatDate(nowDt, tz, 'yyyy-MM-dd');
    var timeStr = Utilities.formatDate(nowDt, tz, 'HH:mm:ss');
    [['Date of Last Action', dateStr], ['Time of Last Action', timeStr]].forEach(function (pair) {
      var colName = pair[0], v = pair[1];
      var idx = headers.indexOf(colName);
      if (idx === -1) { idx = headers.length; sheet.getRange(1, idx + 1).setValue(colName); sheet.getRange(1, idx + 1).setFontWeight('bold'); headers.push(colName); }
      sheet.getRange(row, idx + 1).setValue(v);
      updated.push(colName);
    });
  }
  var wroteIdx = {};
  for (var field in FIELD_MAP) {
    if (data[field] !== undefined && data[field] !== null && data[field] !== '') {
      var colName = FIELD_MAP[field];
      var colIndex = headers.indexOf(colName);
      if (field === 'status' && colIndex === -1) { var altIdx = headers.indexOf('Last Action'); if (altIdx !== -1) { colIndex = altIdx; colName = 'Last Action'; } }
      if (colIndex === -1) continue;
      var cell = sheet.getRange(row, colIndex + 1);
      var value = data[field];
      if (typeof value === 'string' && value.charAt(0) === '=') { cell.setFormula(value); } else { cell.setValue(value); }
      wroteIdx[colIndex] = true;
      updated.push(colName);
    }
  }
  ACTION_COLUMNS.forEach(function (col) {
    var idx = headers.indexOf(col);
    if (idx === -1) return;
    if (wroteIdx[idx]) return;
    var prev = (preVals && (preVals[idx] || '').toString().trim()) || '';
    if (prev === '') sheet.getRange(row, idx + 1).setValue('—');
  });
  if (data.accountUsed) {
    appendAuditLog(sheet.getParent(), { date: data.dateLastAction || new Date().toISOString(), linkedinUrl: data.linkedinUrl || '', action: data.auditAction || data.status || '', account: data.accountUsed, notes: data.auditNotes || '' });
  }
  return updated;
}

// Run both implementations against identical sheets; assert equivalence.
function runBoth(headers, row2, data) {
  _auditCalls = [];
  const oldSheet = new FakeSheet(headers, row2);
  const oldUpdated = writeFieldsOld(oldSheet, headers.slice(), 2, { ...data });
  const oldAudit = _auditCalls.slice();

  _auditCalls = [];
  const newSheet = new FakeSheet(headers, row2);
  const newUpdated = writeFieldsNew(newSheet, headers.slice(), 2, { ...data });
  const newAudit = _auditCalls.slice();

  return { oldSheet, newSheet, oldUpdated, newUpdated, oldAudit, newAudit };
}

const DATA_BASE = { dateLastAction: '2026-05-29T16:00:00Z', tz: 'Europe/London', linkedinUrl: 'https://www.linkedin.com/in/x' };

test('scenario 1 — v2 CC+DM connection_sent, no action columns: identical state, no extra reads', () => {
  const headers = ['First Name', 'Last Name', 'linkedin url', 'Stage', 'Last Action', 'Sender',
    'Date of Last Action', 'Time of Last Action', 'LinkedIn URN', 'LinkedIn Membership ID',
    'Connection Request Status', 'Connection Accepted Status', 'DM Status'];
  const data = { ...DATA_BASE, sender: 'justine', accountUsed: 'justine', status: 'Connection Request Sent',
    connectionStatus: 'Connection Request Sent', stage: 'Connect Pending', linkedinUrn: 'ACoAA1',
    linkedinMemberId: '12345', auditAction: 'Connection sent' };
  const r = runBoth(headers, {}, data);
  assert.equal(r.newSheet.snapshot(), r.oldSheet.snapshot());
  assert.deepEqual(r.newUpdated, r.oldUpdated);
  assert.deepEqual(r.newAudit, r.oldAudit);
  assert.equal(r.oldSheet.reads, 0, 'old does no reads when no action columns');
  assert.equal(r.newSheet.reads, 0, 'new must not add a read when no action columns');
});

test('scenario 2 — message_sent with HYPERLINK + action columns (blank/prefilled): identical, new reads fewer', () => {
  const headers = ['First Name', 'linkedin url', 'Stage', 'Sender', 'OP', 'Message', 'InMail',
    'Date of Last Action', 'Time of Last Action', 'Connection Request Status', 'DM Status'];
  const row2 = { InMail: 'prior-value' }; // OP + Message blank, InMail pre-filled
  const data = { ...DATA_BASE, sender: 'justine', accountUsed: 'justine', status: 'DM Sent', dmStatus: 'DM Sent',
    stage: 'DM Sent', message: '=HYPERLINK("https://x","Sent")', auditAction: 'Message sent' };
  const r = runBoth(headers, row2, data);
  assert.equal(r.newSheet.snapshot(), r.oldSheet.snapshot());
  assert.deepEqual(r.newUpdated, r.oldUpdated);
  assert.deepEqual(r.newAudit, r.oldAudit);
  // Message must be a formula; OP must be dash; InMail must keep its prior value.
  const mIdx = headers.indexOf('Message') + 1;
  const opIdx = headers.indexOf('OP') + 1;
  const inIdx = headers.indexOf('InMail') + 1;
  assert.deepEqual(r.newSheet.cells[`2,${mIdx}`], { f: '=HYPERLINK("https://x","Sent")' });
  assert.deepEqual(r.newSheet.cells[`2,${opIdx}`], { v: '—' });
  assert.deepEqual(r.newSheet.cells[`2,${inIdx}`], { v: 'prior-value' });
  assert.equal(r.oldSheet.reads, 3, 'old reads each of 3 action cells (interleaved)');
  assert.equal(r.newSheet.reads, 1, 'new reads the row once, up front');
});

test('scenario 3 — status routes to Last Action when Connection Request Status absent', () => {
  const headers = ['linkedin url', 'Stage', 'Last Action', 'Sender', 'DM Status'];
  const data = { ...DATA_BASE, sender: 'justine', accountUsed: 'justine', status: 'DM Sent', dmStatus: 'DM Sent', stage: 'DM Sent' };
  const r = runBoth(headers, {}, data);
  assert.equal(r.newSheet.snapshot(), r.oldSheet.snapshot());
  assert.deepEqual(r.newUpdated, r.oldUpdated);
  const laIdx = headers.indexOf('Last Action') + 1;
  assert.deepEqual(r.newSheet.cells[`2,${laIdx}`], { v: 'DM Sent' }, 'status fell back to Last Action');
});

test('scenario 4 — missing target column is silently skipped (both)', () => {
  const headers = ['linkedin url', 'Stage', 'Sender']; // no DM Status column
  const data = { ...DATA_BASE, sender: 'justine', accountUsed: 'justine', dmStatus: 'DM Sent', stage: 'DM Sent' };
  const r = runBoth(headers, {}, data);
  assert.equal(r.newSheet.snapshot(), r.oldSheet.snapshot());
  assert.deepEqual(r.newUpdated, r.oldUpdated);
  assert.ok(!r.newUpdated.includes('DM Status'), 'DM Status not written (column absent)');
});

test('scenario 5 — dateLastAction create-on-demand: both append Date/Time columns identically', () => {
  const headers = ['linkedin url', 'Stage', 'Sender']; // no Date/Time columns yet
  const data = { ...DATA_BASE, sender: 'justine', accountUsed: 'justine', stage: 'Connect Pending' };
  const r = runBoth(headers, {}, data);
  assert.equal(r.newSheet.snapshot(), r.oldSheet.snapshot());
  assert.deepEqual(r.newUpdated, r.oldUpdated);
  assert.ok(r.newUpdated.includes('Date of Last Action') && r.newUpdated.includes('Time of Last Action'));
});

test('scenario 6 — action cell holding 0 (falsy): both treat it as blank → dash (exact || coercion match)', () => {
  const headers = ['linkedin url', 'Stage', 'Sender', 'OP'];
  const row2 = { OP: 0 }; // numeric zero — the old `(getValue()||'')` coerces to blank
  const data = { ...DATA_BASE, sender: 'justine', accountUsed: 'justine', stage: 'Connect Pending' };
  const r = runBoth(headers, row2, data);
  assert.equal(r.newSheet.snapshot(), r.oldSheet.snapshot());
  const opIdx = headers.indexOf('OP') + 1;
  assert.deepEqual(r.newSheet.cells[`2,${opIdx}`], { v: '—' }, 'both overwrite falsy-0 with dash');
});

test('scenario 7 — no accountUsed → no audit append (both)', () => {
  const headers = ['linkedin url', 'Stage', 'Sender', 'Connection Accepted Status'];
  const data = { ...DATA_BASE, checkStatus: 'Still Pending' }; // status_pending shape: no accountUsed
  const r = runBoth(headers, {}, data);
  assert.equal(r.newSheet.snapshot(), r.oldSheet.snapshot());
  assert.deepEqual(r.newAudit, r.oldAudit);
  assert.equal(r.newAudit.length, 0, 'no audit entry without accountUsed');
});
