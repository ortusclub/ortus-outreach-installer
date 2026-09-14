import test from 'node:test';
import assert from 'node:assert/strict';
import { terminalPresentation } from '../public/js/campaign-terminal.mjs';

test('an incomplete run is stopped early, never finished', () => {
  const view = terminalPresentation({ totalProcessed: 30, totalTargets: 148 });
  assert.deepEqual(view, { label: 'Stopped early', activity: '118 pending', pending: 118, complete: false });
});

test('operator stop remains stopped even at zero targets', () => {
  const view = terminalPresentation({ totalProcessed: 0, totalTargets: 0, endNotice: { reason: 'operator_stopped' } });
  assert.equal(view.label, 'Stopped');
});

test('only an exhausted target set is finished', () => {
  const view = terminalPresentation({ totalProcessed: 148, totalTargets: 148 });
  assert.equal(view.label, 'Finished');
  assert.equal(view.complete, true);
});

test('errors are reported as failed', () => {
  assert.equal(terminalPresentation({ endNotice: { reason: 'error' } }).label, 'Failed');
});
