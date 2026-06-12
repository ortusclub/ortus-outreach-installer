import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFlipPayload,
  buildNeedsLoginPayload,
  sooWritebackEnabled,
} from '../src/soo-writer.js';
import { SOO_SHEET_ID, SOO_SHEET_GID } from '../src/sheets-webapp-url.js';

test('flip payload: In Use + user cell + guard on the credit header', () => {
  const p = buildFlipPayload({
    email: 'a@ortus.solutions',
    creditHeader: 'CC (Credits)',
    userHeader: 'CC User',
    operatorEmail: 'op@ortusclub.com',
  });
  assert.equal(p.action, 'setSoO');
  assert.equal(p.sheetId, SOO_SHEET_ID);
  assert.equal(p.gid, SOO_SHEET_GID);
  assert.equal(p.email, 'a@ortus.solutions');
  assert.deepEqual(p.fields, { 'CC (Credits)': 'In Use', 'CC User': 'op@ortusclub.com' });
  assert.deepEqual(p.guardAvailableFor, ['CC (Credits)']);
});

test('flip payload omits the user cell when operator email is blank', () => {
  const p = buildFlipPayload({
    email: 'a@x', creditHeader: 'CC (Credits)', userHeader: 'CC User', operatorEmail: '',
  });
  assert.deepEqual(p.fields, { 'CC (Credits)': 'In Use' });
});

test('needs-login payload: Needs Login = Y, no guard', () => {
  const p = buildNeedsLoginPayload({ email: 'a@x' });
  assert.equal(p.action, 'setSoO');
  assert.deepEqual(p.fields, { 'Needs Login': 'Y' });
  assert.deepEqual(p.guardAvailableFor, []);
});

test('kill-switch: off/0/false disable (case-insensitive); anything else enables', () => {
  const orig = process.env.ORTUS_SOO_WRITEBACK;
  try {
    for (const v of ['off', '0', 'false', 'OFF', 'False']) {
      process.env.ORTUS_SOO_WRITEBACK = v;
      assert.equal(sooWritebackEnabled(), false, v);
    }
    for (const v of ['', 'on', '1', 'true', 'yes']) {
      process.env.ORTUS_SOO_WRITEBACK = v;
      assert.equal(sooWritebackEnabled(), true, v);
    }
    delete process.env.ORTUS_SOO_WRITEBACK;
    assert.equal(sooWritebackEnabled(), true);
  } finally {
    if (orig === undefined) delete process.env.ORTUS_SOO_WRITEBACK;
    else process.env.ORTUS_SOO_WRITEBACK = orig;
  }
});
