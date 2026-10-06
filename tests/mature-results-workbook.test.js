import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { matureSheetsWebappUrl } from '../src/sheets-webapp-url.js';

test('development uses the released maturing bridge unless explicitly overridden', () => {
  const original = process.env.MATURE_SHEETS_WEBAPP_URL;
  try {
    delete process.env.MATURE_SHEETS_WEBAPP_URL;
    const bundled = fs.readFileSync(new URL('../build/release.env', import.meta.url), 'utf8').match(/^MATURE_SHEETS_WEBAPP_URL=(.+)$/m)[1].trim();
    assert.equal(matureSheetsWebappUrl(), bundled);
    process.env.MATURE_SHEETS_WEBAPP_URL = ' https://example.test/exec ';
    assert.equal(matureSheetsWebappUrl(), 'https://example.test/exec');
  } finally {
    if (original === undefined) delete process.env.MATURE_SHEETS_WEBAPP_URL;
    else process.env.MATURE_SHEETS_WEBAPP_URL = original;
  }
});

test('a failed workbook write stops instead of creating a separate spreadsheet', async () => {
  const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const start = source.indexOf('    let tab = null;', source.indexOf("Writing the plan to this account's tab") - 400);
  const end = source.indexOf('    if (warmOn) {', start);
  assert.ok(start > 0 && end > start);
  const calls = [];
  const writeMatureTab = () => {};
  const context = vm.createContext({
    createWarmSheet: async (payload, retry, writer) => { calls.push({ payload, writer }); throw new Error('workbook unavailable'); },
    writeMatureTab, MATURE_RESULTS_SHEET_ID: 'existing-workbook', name: 'Pauline', MATURE_TAB_HEADER: [],
    buildMatureTabRows: () => [], startDate: '2026-10-06', pool: { targets: [] }, warmAmounts: [], coldLeads: [], cold: null,
    step() {}, console: { warn() {}, log() {} },
  });
  await assert.rejects(vm.runInContext(`(async () => {${source.slice(start, end)}})()`, context), /No campaign was started/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].payload.spreadsheetId, 'existing-workbook');
  assert.equal(calls[0].payload.tabName, 'Pauline');
  assert.equal(calls[0].writer, writeMatureTab);
});
