import test from 'node:test';
import assert from 'node:assert/strict';
import { decideLeadSource } from '../src/campaign.js';

// A row set that looks like a real lead list (First Name + a LinkedIn URL column).
const LEAD_ROWS = [
  { 'First Name': 'Ryan', 'Last Name': 'Rooijen', 'LinkedIn URL': 'https://www.linkedin.com/in/ACwAAADy' },
];

test('aborts on a multi-tab workbook with no tab chosen', () => {
  const r = decideLeadSource({ tabCount: 4, gid: '', tabName: '', rows: LEAD_ROWS });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'multiple tabs, no tab chosen');
});

test('aborts when the resolved tab is a known system tab', () => {
  const r = decideLeadSource({ tabCount: 1, gid: '1249624821', tabName: 'Recent Connections', rows: LEAD_ROWS });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'system tab, not leads: Recent Connections');
});

test('aborts when the rows do not look like a lead list', () => {
  // System-board shape: has First Name but NO LinkedIn URL column.
  const sysRows = [{ Account: 'a@x.com', 'First Name': 'Adriano', 'Last Name': 'Lucchesi', 'Public ID': 'adriano', 'Connected At': '2026-01-01' }];
  const r = decideLeadSource({ tabCount: 1, gid: '42', tabName: 'mystery', rows: sysRows });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'tab does not look like a lead list');
});

test('passes a valid lead set on a chosen tab', () => {
  const r = decideLeadSource({ tabCount: 4, gid: '1249624821', tabName: 'HTECHxDELLxINT leads', rows: LEAD_ROWS });
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'ok');
});

test('single-tab workbook with no gid still passes on valid leads (legacy)', () => {
  const r = decideLeadSource({ tabCount: 1, gid: '', tabName: '', rows: LEAD_ROWS });
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'ok');
});
