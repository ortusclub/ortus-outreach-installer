import test from 'node:test';
import assert from 'node:assert/strict';
import { requestStandaloneStop, standaloneStopStatus } from '../src/standalone-stop-control.js';

test('standalone Stop interrupts immediately and waits for both browser proof and runner exit', async () => {
  let close;
  const runner = { running: true, startedAt: 1, taskOwner: { campaignId: 'post-amplification', campaignRunId: 'run' }, _abortController: new AbortController() };
  requestStandaloneStop(runner, { interrupt: () => new Promise(resolve => { close = resolve; }) });
  assert.equal(runner._abortController.signal.aborted, true);
  assert.equal(standaloneStopStatus(runner).stopConfirmed, false);
  close({ stopped: true }); await runner._stopReceipt.done;
  assert.equal(standaloneStopStatus(runner).stopConfirmed, false);
  runner.running = false;
  assert.equal(standaloneStopStatus(runner).stopConfirmed, true);
});

test('failed standalone closure stays visible after the loop exits', async () => {
  const runner = { running: true, startedAt: 1, _abortController: new AbortController() };
  requestStandaloneStop(runner, { interrupt: async () => ({ stopped: false, error: 'fixture closer failed' }) });
  await runner._stopReceipt.done;
  runner.running = false;
  assert.equal(standaloneStopStatus(runner).stopping, true);
  assert.equal(standaloneStopStatus(runner).stopError, 'fixture closer failed');
});
