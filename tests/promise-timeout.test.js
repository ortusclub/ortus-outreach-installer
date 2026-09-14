import test from 'node:test';
import assert from 'node:assert/strict';
import { withTimeout } from '../src/promise-timeout.js';

test('returns a fast operation result', async () => {
  assert.equal(await withTimeout(Promise.resolve('ok'), { ms: 50 }), 'ok');
});

test('rejects a hung operation and runs cleanup', async () => {
  let cleaned = false;
  await assert.rejects(
    withTimeout(new Promise(() => {}), { ms: 5, label: 'GoLogin launch', onTimeout: () => { cleaned = true; } }),
    /GoLogin launch timed out/,
  );
  assert.equal(cleaned, true);
});
