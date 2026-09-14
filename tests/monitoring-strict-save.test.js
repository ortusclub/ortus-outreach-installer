import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/monitoring-persistence.js', import.meta.url), 'utf8');
const start = source.indexOf('export async function writeMonitoringState(');
const end = source.indexOf('export async function readMonitoringState(', start);
function writer(atomic) {
  return vm.runInNewContext(source.slice(start, end).replace('export ', '') + '\nwriteMonitoringState;', {
    MONITORING_FILE: 'fixture-only', pendingPersistence: 0, extractMonitoringSlice: x => x,
    writeJsonAtomic: atomic,
    writeFile: () => assert.fail('strict save must not use a non-atomic write'),
    clearMonitoringState: () => assert.fail('strict save must not erase existing state'),
  });
}
test('strict save waits for atomic persistence before acknowledging', async () => {
  let finish, acknowledged = false;
  const save = writer(() => new Promise(resolve => { finish = resolve; }));
  const pending = save({ state: 'monitoring' }, { strict: true }).then(() => { acknowledged = true; });
  await Promise.resolve(); assert.equal(acknowledged, false);
  finish(); await pending; assert.equal(acknowledged, true);
});
test('strict save propagates disk failure and rejects non-monitoring snapshots', async () => {
  const save = writer(async () => { throw new Error('disk unavailable'); });
  await assert.rejects(save({ state: 'monitoring' }, { strict: true }), /disk unavailable/);
  await assert.rejects(save({ state: 'idle' }, { strict: true }), /requires a monitoring snapshot/);
});
test('atomic activation cannot overwrite a still-pending legacy save or Stop clear', () => {
  const begin = source.indexOf('export function commitMonitoringState(');
  const end = source.indexOf('\n}\n', begin) + 2;
  const commit = vm.runInNewContext(source.slice(begin, end).replace('export ', '') + '\ncommitMonitoringState;', {
    pendingPersistence: 1,
    writeFileSync: () => assert.fail('no write while another persistence operation is pending'),
  });
  assert.throws(() => commit({ state: 'monitoring' }), /still finishing/);
});
