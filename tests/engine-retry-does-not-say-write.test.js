import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withWriteRetry } from '../src/sheets-writer.js';
import { engineRetryLine } from '../src/campaigns-client.js';

// requestWithRetry in campaigns-client wraps IDEMPOTENT engine calls (list /
// status / stop) in the sheet writer's retry helper, and inherited its wording:
// "transient write error". Nothing is written by those calls, and an operator
// reading "write error" goes looking for data that was never at risk (Sam's
// log, 1 Sep). engineRetryLine is the exact function campaigns-client hands to
// the helper, imported rather than restated so this test breaks if it changes.

test('the retry line names the engine, not a write', async () => {
  const lines = [];
  await withWriteRetry(
    async () => ({ error: 'The operation was aborted due to timeout' }),
    { maxAttempts: 2, baseDelayMs: 1, log: (m) => lines.push(engineRetryLine(m)) },
  );
  assert.ok(lines.length, 'a failed attempt must say something');
  for (const line of lines) {
    assert.doesNotMatch(line, /write/i, 'these calls write nothing');
    assert.match(line, /the engine did not answer \(attempt \d+\/\d+\)/);
    assert.match(line, /aborted due to timeout/, 'the real reason must survive');
  }
});

test('a call that succeeds says nothing at all', async () => {
  const lines = [];
  const r = await withWriteRetry(
    async () => ({ ok: true }),
    { maxAttempts: 3, baseDelayMs: 1, log: (m) => lines.push(m) },
  );
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(lines, []);
});
