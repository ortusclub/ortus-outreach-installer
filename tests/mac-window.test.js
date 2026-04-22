import { test } from 'node:test';
import assert from 'node:assert/strict';
import { minimizeByPid, unminimizeByPids, _setExecFile } from '../src/mac-window.js';

// Each test that uses the mock MUST reset it at end so later tests are isolated.
// All tests bypass the `isDarwin` guard by relying on the fact that we only run
// execFile when platform is darwin. For non-darwin tests, assert the mock was
// NOT called.

const isDarwin = process.platform === 'darwin';

test('minimizeByPid: invokes osascript with expected argv on darwin', { skip: !isDarwin }, async () => {
  const calls = [];
  _setExecFile(async (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { stdout: '', stderr: '' }; });
  try {
    await minimizeByPid(12345);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, '/usr/bin/osascript');
    assert.equal(calls[0].args[0], '-e');
    const script = calls[0].args[1];
    assert.match(script, /first process whose unix id is 12345/);
    assert.match(script, /AXMinimized/);
    assert.match(script, /repeat 30 times/);
    assert.ok(typeof calls[0].opts.timeout === 'number' && calls[0].opts.timeout >= 2000);
  } finally {
    _setExecFile(null);
  }
});

test('minimizeByPid: no-op on non-darwin (execFile never called)', { skip: isDarwin }, async () => {
  let called = false;
  _setExecFile(async () => { called = true; return { stdout: '', stderr: '' }; });
  try {
    await minimizeByPid(12345);
    assert.equal(called, false);
  } finally { _setExecFile(null); }
});

for (const bogus of [null, undefined, 0, NaN, 'abc', Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
  test(`minimizeByPid: bogus pid ${String(bogus)} is a no-op on darwin`, { skip: !isDarwin }, async () => {
    let called = false;
    _setExecFile(async () => { called = true; return { stdout: '', stderr: '' }; });
    try {
      await minimizeByPid(bogus);
      assert.equal(called, false, `expected no execFile call for pid=${String(bogus)}`);
    } finally { _setExecFile(null); }
  });
}

test('minimizeByPid: swallows execFile errors on darwin', { skip: !isDarwin }, async () => {
  _setExecFile(async () => { throw new Error('osascript died'); });
  try {
    await minimizeByPid(99999);  // must NOT throw
  } finally { _setExecFile(null); }
});

test('unminimizeByPids: empty array returns zero counts', async () => {
  const result = await unminimizeByPids([]);
  assert.deepEqual(result, { minimized: 0, skipped: 0 });
});

test('unminimizeByPids: counts successes and skips bogus pids on darwin', { skip: !isDarwin }, async () => {
  const calls = [];
  _setExecFile(async (cmd, args) => { calls.push(args[1]); return { stdout: '', stderr: '' }; });
  try {
    const result = await unminimizeByPids([100, 'bad', Infinity, 200]);
    assert.equal(result.minimized, 2, 'two valid pids should succeed');
    assert.equal(result.skipped, 2, 'two invalid pids should be skipped');
    assert.equal(calls.length, 2);
    assert.match(calls[0], /unix id is 100/);
    assert.match(calls[0], /to false/);
    assert.match(calls[1], /unix id is 200/);
  } finally { _setExecFile(null); }
});

test('unminimizeByPids: counts execFile failures as skipped', { skip: !isDarwin }, async () => {
  _setExecFile(async () => { throw new Error('boom'); });
  try {
    const result = await unminimizeByPids([1, 2, 3]);
    assert.equal(result.minimized, 0);
    assert.equal(result.skipped, 3);
  } finally { _setExecFile(null); }
});

test('unminimizeByPids: no-op on non-darwin', { skip: isDarwin }, async () => {
  let called = false;
  _setExecFile(async () => { called = true; return { stdout: '', stderr: '' }; });
  try {
    const result = await unminimizeByPids([100, 200]);
    assert.deepEqual(result, { minimized: 0, skipped: 0 });
    assert.equal(called, false);
  } finally { _setExecFile(null); }
});

// Sanity check: the endpoint wiring in server.js imports from mac-window.
// We don't boot Express; we just verify the contract shape is stable.
test('unminimizeByPids contract matches endpoint expectations', async () => {
  const result = await unminimizeByPids([]);
  // Endpoint returns { ok, minimized, skipped, platform } — the helper must
  // provide { minimized, skipped } which the endpoint then spreads.
  assert.ok(typeof result.minimized === 'number');
  assert.ok(typeof result.skipped === 'number');
});
