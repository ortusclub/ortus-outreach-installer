// The Magellan sheet client must survive Apps Script's flap.
//
// Measured 13 Aug, ten consecutive getSheetUrl calls against the live
// deployment: four came back as Google's "Pagina non trovata" HTML instead of
// the reply, at both 404 and 200. The same URL answered correctly seconds
// later — a Google-side flap, not a broken deployment.
//
// FG has retried this since it was first hit. Magellan did not, so a single
// flap threw away the whole sheet write after a 429-person import and reported
// "Could not update the sheet — Unexpected non-JSON response from the Apps
// Script", which reads like the deployment is dead.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sheetUrl } from '../../src/connections/magellan-sheet.js';

const html = (status, body) => ({ status, text: async () => body });
const json = (o) => ({ status: 200, text: async () => JSON.stringify(o) });
const FLAP = '<!DOCTYPE html><html lang="it"><head><title>Pagina non trovata</title></head></html>';

test('a flapped reply is retried, and the next one is taken', async () => {
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return calls < 3 ? html(404, FLAP) : json({ url: 'https://docs.google.com/spreadsheets/d/abc/edit' });
  };
  try {
    assert.equal(await sheetUrl(), 'https://docs.google.com/spreadsheets/d/abc/edit');
    assert.equal(calls, 3, 'should have retried twice before succeeding');
  } finally { globalThis.fetch = orig; }
});

test('a login page is a deployment problem — never retried', async () => {
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return html(200, '<html>Sign in to continue to accounts.google.com</html>');
  };
  try {
    await assert.rejects(sheetUrl(), /redeploy it/i);
    assert.equal(calls, 1, 'retrying a login page only wastes the operator\'s time');
  } finally { globalThis.fetch = orig; }
});

test('giving up says the status and the size, not just "not JSON"', async () => {
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return html(404, FLAP); };
  try {
    await assert.rejects(sheetUrl(), /answered 404 with \d+ bytes that are not JSON/);
    assert.ok(calls > 1, 'should have used its attempt budget');
  } finally { globalThis.fetch = orig; }
});
