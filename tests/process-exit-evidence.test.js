import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmOwnedProcessExit } from '../src/process-exit-evidence.js';

test('a signal sent to a process is not proof that it exited', async () => {
  let signals = 0;
  const evidence = await confirmOwnedProcessExit({ pid: 123, killed: true, kill: () => signals++ },
    { probe() {}, timeoutMs: 10, forceAfterMs: 0, pollMs: 1 });
  assert.equal(evidence.browserClosed, false);
  assert.equal(signals, 1);
});
test('only explicit exit or ESRCH is confirmation, not permission errors or missing handles', async () => {
  assert.equal((await confirmOwnedProcessExit(null)).browserClosed, false);
  assert.equal((await confirmOwnedProcessExit({ pid: 123, exitCode: 0 })).browserClosed, true);
  for (const code of ['ESRCH', 'EPERM', 'UNKNOWN']) {
    const evidence = await confirmOwnedProcessExit({ pid: 123 }, { probe() { throw { code }; } });
    assert.equal(evidence.browserClosed, code === 'ESRCH');
  }
});
