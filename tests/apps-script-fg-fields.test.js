// Follower Growth stamps its results into the operator's OWN sheet through the
// main Apps Script's updateRow action. writeFields drops unknown fields
// SILENTLY, so a missing FIELD_MAP entry does not fail — it just never writes.
// These tests are the only thing standing between that and a run that reports
// success while stamping nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(__dirname, '..', 'google-apps-script.js'), 'utf8');

function load() {
  const ctx = { console, Session: { getScriptTimeZone: () => 'UTC' }, Utilities: { formatDate: () => '' } };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return ctx;
}

test('the four FG ledger fields map to their own columns', () => {
  const { FIELD_MAP } = load();
  assert.equal(FIELD_MAP.fgStatus, 'Status');
  assert.equal(FIELD_MAP.fgInvitedAt, 'Invited At');
  assert.equal(FIELD_MAP.fgNote, 'Note');
  assert.equal(FIELD_MAP.fgMemberId, 'Member ID');
});

test('FG fields do not collide with the CC fields that already exist', () => {
  const { FIELD_MAP } = load();
  // `status` is Connection Request Status and must stay that way; Member ID is
  // NOT LinkedIn Membership ID. Crossing these would stamp CC columns on an FG
  // run and vice versa.
  assert.equal(FIELD_MAP.status, 'Connection Request Status');
  assert.equal(FIELD_MAP.linkedinMemberId, 'LinkedIn Membership ID');
  assert.notEqual(FIELD_MAP.fgStatus, FIELD_MAP.status);
  assert.notEqual(FIELD_MAP.fgMemberId, FIELD_MAP.linkedinMemberId);
});

test('the FG columns are provisioned for the follower_growth mode only', () => {
  const { MODE_COLUMNS_V2, ALL_MODE_COLUMNS_V2 } = load();
  // Spread the vm-realm array into a plain one first — Node's strict
  // deepEqual treats an Array from a different vm context as a different
  // realm and refuses reference-equality on its elements otherwise.
  assert.deepEqual([...MODE_COLUMNS_V2.follower_growth], ['Status', 'Invited At', 'Note', 'Member ID']);
  for (const col of ['Status', 'Invited At', 'Note', 'Member ID']) {
    assert.ok(ALL_MODE_COLUMNS_V2.includes(col), `${col} must be in ALL_MODE_COLUMNS_V2`);
  }
});

test('no other mode gained or lost a column', () => {
  const { MODE_COLUMNS_V2 } = load();
  // Pin the CC modes so an edit here cannot quietly change what a CC run
  // provisions on an operator's sheet.
  assert.deepEqual([...MODE_COLUMNS_V2.connect_only], ['Connection Request Status']);
  assert.deepEqual([...MODE_COLUMNS_V2.connect_and_introduce],
    ['Connection Request Status', 'Connection Accepted Status', 'Introduction Status']);
  assert.deepEqual([...MODE_COLUMNS_V2.connect_and_message],
    ['Connection Request Status', 'Connection Accepted Status', 'DM Status']);
});
