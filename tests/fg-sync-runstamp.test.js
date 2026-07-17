import { test } from 'node:test';
import assert from 'node:assert/strict';

test('queueFgInvites stamps runId/runAt and pads rows to 16', async () => {
  const calls = [];
  const fg = await import('../src/connections/fg-sync.js');
  // Inject a fake poster by monkeypatching global fetch is heavy; instead test the
  // pure row-shaping helper the module exports.
  const rows = [['Jane', 'https://x/jane', '111', 'Acme', 'CMO', '', '', 'Op', 'a@x', 'Queued', '', '', '2026-07']];
  const out = fg.stampRunCells(rows, { runId: 'cmp_1', runAt: '2026-07-17T11:40:00.000Z' });
  assert.equal(out[0].length, 16);
  assert.equal(out[0][13], 'cmp_1');
  assert.equal(out[0][14], '2026-07-17T11:40:00.000Z');
  assert.equal(out[0][15], '');
});
