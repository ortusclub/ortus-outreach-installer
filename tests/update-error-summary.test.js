import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeUpdateError } from '../public/js/update-error.mjs';

test('download error takes priority and includes the cause', () => {
  const s = summarizeUpdateError({ downloadError: 'download failed: HTTP 404' });
  assert.match(s, /download failed/i);
  assert.match(s, /404/);
});

test('install error is reported when there is no download error', () => {
  assert.match(summarizeUpdateError({ installError: 'mount failed' }), /install failed/i);
});

test('fallback (manual drag) produces a non-error guidance line', () => {
  assert.match(summarizeUpdateError({ fallback: true }), /drag/i);
});

test('no signals → empty string', () => {
  assert.equal(summarizeUpdateError({}), '');
  assert.equal(summarizeUpdateError(), '');
});
