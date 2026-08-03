// ensureColumns must never delete a column whose data it didn't move.
//
// 2026-08-03: an operator launched a second campaign against a sheet a previous
// run had already filled in. ensureColumns deleted the 'Sender' column (it was
// listed in OLD_COLUMNS_TO_REMOVE) and prepareSheet immediately re-created it
// empty (it's in ALWAYS_PROVISIONED_V2) — so 50 rows of sender history vanished.
// The audit that followed found two more lossy paths in the same function:
//   • a rename whose destination already existed bailed out of the migration,
//     then the delete pass destroyed the source anyway
//   • 'Date Last Action' was in the removal list with no rename entry at all
//
// google-apps-script.js is Apps Script, not a module — it's evaluated in a vm
// with the SpreadsheetApp surface stubbed by a fake sheet.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(__dirname, '..', 'google-apps-script.js'), 'utf8');

// Minimal 2-D sheet: grid[row][col], row 0 = headers. Only the surface
// handleEnsureColumns actually touches.
function fakeSheet(headers, rows) {
  const grid = [headers.slice(), ...rows.map((r) => r.slice())];
  const pad = () => grid.forEach((r) => { while (r.length < grid[0].length) r.push(''); });
  return {
    grid,
    getLastRow: () => grid.length,
    getLastColumn: () => grid[0].length,
    getMaxRows: () => grid.length,
    getRange(row, col, numRows = 1, numCols = 1) {
      return {
        getValues: () => Array.from({ length: numRows }, (_, r) =>
          Array.from({ length: numCols }, (_, c) => (grid[row - 1 + r] || [])[col - 1 + c] ?? '')),
        setValues(vals) {
          vals.forEach((rv, r) => rv.forEach((v, c) => {
            if (!grid[row - 1 + r]) grid[row - 1 + r] = [];
            grid[row - 1 + r][col - 1 + c] = v;
          }));
          return this;
        },
        setValue(v) { if (!grid[row - 1]) grid[row - 1] = []; grid[row - 1][col - 1] = v; return this; },
        setFontWeight() { return this; },
        setFormula(v) { grid[row - 1][col - 1] = v; return this; },
      };
    },
    deleteColumn(col) { grid.forEach((r) => r.splice(col - 1, 1)); },
    insertColumnAfter(col) { grid.forEach((r) => r.splice(col, 0, '')); pad(); },
    moveColumns() { /* reorder is data-preserving; irrelevant here */ },
    getParent: () => ({}),
    setColumnWidth() {}, hideColumns() {}, showColumns() {},
    getFilter: () => null, getRangeList: () => ({ setBackground() {} }),
    clearConditionalFormatRules() {}, setConditionalFormatRules() {},
    getConditionalFormatRules: () => [],
  };
}

function runEnsureColumns(sheet, mode) {
  const ctx = {
    console,
    SpreadsheetApp: { flush() {}, newConditionalFormatRule: () => { throw new Error('unused'); } },
    ContentService: {
      createTextOutput: (t) => ({ setMimeType: () => ({ _body: t }) }),
      MimeType: { JSON: 'json' },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  // Formatting/migration helpers touch APIs the fake sheet doesn't model and are
  // irrelevant to the delete decision — neutralise them.
  ctx.applyStatusFormatting = () => {};
  ctx.applyCCFormatting = () => {};
  ctx.migrateOldStatusValues = () => {};
  ctx.jsonResponse = (o) => o;
  return ctx.handleEnsureColumns(sheet, { mode });
}

const headerRow = (s) => s.grid[0];
const colValues = (s, name) => {
  const i = s.grid[0].indexOf(name);
  return i === -1 ? null : s.grid.slice(1).map((r) => r[i]);
};

test('Sender survives a relaunch on an already-used sheet', () => {
  const s = fakeSheet(
    ['First Name', 'LinkedIn Bio', 'Connection Request Status', 'Sender'],
    [['Ash', 'https://x/1', 'Connection Request Sent', 'trixia.aguilera@ortus.solutions'],
     ['Bach', 'https://x/2', 'Connection Request Sent', 'trixia.aguilera@ortus.solutions']]
  );
  runEnsureColumns(s, 'connect_and_introduce');

  assert.ok(headerRow(s).includes('Sender'), 'Sender column still exists');
  assert.deepEqual(colValues(s, 'Sender'),
    ['trixia.aguilera@ortus.solutions', 'trixia.aguilera@ortus.solutions'],
    'and every historical sender is still in it');
});

test('a legacy column is kept, not destroyed, when its replacement already exists', () => {
  // The real-world shape: prepareSheet provisioned 'Date of Last Action', and an
  // old 'Date' column still carries history. The rename can't run (destination
  // exists) — the values must be backfilled, never dropped.
  const s = fakeSheet(
    ['First Name', 'Date', 'Date of Last Action'],
    [['Ash', '2026-07-01', ''],
     ['Bach', '2026-07-02', '2026-08-03']]
  );
  runEnsureColumns(s, 'connect_only');

  assert.deepEqual(colValues(s, 'Date of Last Action'), ['2026-07-01', '2026-08-03'],
    'blank destination cells are backfilled; a newer value is never clobbered');
  assert.ok(!headerRow(s).includes('Date'),
    'and only then is the migrated source column removed');
});

test('a listed column with data and nowhere to go is kept and reported', () => {
  // 'Date Last Action' is in OLD_COLUMNS_TO_REMOVE with no COLUMN_RENAMES entry,
  // so nothing moves its values. Deleting it would be pure loss.
  const s = fakeSheet(
    ['First Name', 'Date Last Action'],
    [['Ash', '2026-07-01 10:00'], ['Bach', '2026-07-02 11:00']]
  );
  const res = runEnsureColumns(s, 'connect_only');

  assert.ok(headerRow(s).includes('Date Last Action'), 'kept rather than deleted');
  assert.ok((res.keptWithData || []).includes('Date Last Action'),
    'and named in keptWithData so the operator can clear it deliberately');
});

test('an empty legacy column is still cleaned up', () => {
  const s = fakeSheet(
    ['First Name', 'InMail Credits Left', 'Connection Request Status'],
    [['Ash', '', 'Connection Request Sent']]
  );
  const res = runEnsureColumns(s, 'connect_only');

  assert.ok(!headerRow(s).includes('InMail Credits Left'),
    'header-only leftovers are disposable — the cleanup still works');
  assert.ok((res.removed || []).includes('InMail Credits Left'));
});

test('relaunching twice is stable — the second run changes nothing', () => {
  const s = fakeSheet(
    ['First Name', 'Connection Request Status', 'Sender'],
    [['Ash', 'Connection Request Sent', 'trixia.aguilera@ortus.solutions']]
  );
  runEnsureColumns(s, 'connect_and_introduce');
  const after1 = JSON.stringify(s.grid);
  runEnsureColumns(s, 'connect_and_introduce');
  assert.equal(JSON.stringify(s.grid), after1, 'idempotent across launches');
});
