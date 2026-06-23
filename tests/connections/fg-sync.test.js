import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fgSync from '../../src/connections/fg-sync.js';
import { FG_WEBAPP_URL } from '../../src/sheets-webapp-url.js';

test('exports the three sheet I/O functions + default allowance', () => {
  assert.equal(typeof fgSync.getFgState, 'function');
  assert.equal(typeof fgSync.queueFgInvites, 'function');
  assert.equal(typeof fgSync.markFgInvited, 'function');
  assert.equal(typeof fgSync.FG_DEFAULT_MONTHLY_ALLOWANCE, 'number');
});

test('getFgState throws a friendly error when the URL is not configured', async () => {
  if (FG_WEBAPP_URL) return; // skip once the real URL is wired
  await assert.rejects(() => fgSync.getFgState(), /not configured/i);
});
