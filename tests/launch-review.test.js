import test from 'node:test';
import assert from 'node:assert/strict';
import { launchReviewRows } from '../public/js/launch-review.mjs';

const body = { name: 'Test_a', mode: 'connect_and_introduce', runTarget: 'cloud',
  vmWorkerNumber: 7,
  sheetUrl: 'https://docs.google.com/spreadsheets/d/test/edit#gid=12', sheetGid: '12',
  profileIds: ['b'], templates: { primaryName: 'Primary B', primaryUrl: 'https://linkedin.com/in/b' }, dailyLimit: 20 };
const labels = { engine: { scraperEngineVersion: 'preview-pr-19-dfd2d4e7e099', scraperEngineUrl: 'http://127.0.0.1:3119' }, accountName: id => `Account ${id}`, tabName: 'Test leads' };
test('review identifies dispatch accounts, primary, sheet/tab and exact preview engine', () => {
  const rows = Object.fromEntries(launchReviewRows(body, labels));
  assert.equal(rows.Accounts, 'Account b');
  assert.equal(rows.Primary, 'Primary B · https://linkedin.com/in/b');
  assert.equal(rows.Sheet, body.sheetUrl);
  assert.equal(rows.Tab, 'Test leads');
  assert.equal(rows.Engine, 'preview-pr-19-dfd2d4e7e099');
  assert.equal(rows['Runs on'], 'Cloud VM 07');
  assert.equal(rows.Campaign, 'Test_a');
});
test('local review distinguishes execution location and does not invent an ETA', () => {
  const rows = Object.fromEntries(launchReviewRows({ ...body, runTarget: 'local' }, labels));
  assert.equal(rows['Runs on'], 'This Mac');
  assert.equal(rows.Duration, undefined);
  assert.equal(rows.Finishes, undefined);
});
test('multiple tabs and auto-routed accounts are stated explicitly', () => {
  const rows = Object.fromEntries(launchReviewRows({ ...body, profileIds: [], multiTab: true }, labels));
  assert.equal(rows.Tab, 'Multiple selected tabs');
  assert.equal(rows.Accounts, 'Auto-routed from sheet');
});
