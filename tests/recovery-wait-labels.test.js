import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
const start = source.indexOf('function _stageOverview(');
const end = source.indexOf('function renderLiveStage(', start);
const ctx = { _stageNumberFromMilestones: () => null, profileLabel: s => s,
  _stageNextCheckView: () => ({ countdown: '20 min', clock: '18:00' }) };
vm.runInNewContext(source.slice(start, end), ctx);
for (const cloud of [false, true]) {
  for (const state of ['logged-out', 'checkpoint']) {
    test(`${cloud ? 'VM launch' : 'local'} ${state} has operator instructions, not a startup estimate`, () => {
      const status = { totalTargets: 2, totalProcessed: 0,
        [cloud ? 'recoveryWait' : 'primaryRecovery']: { state, cloudHandshake: cloud } };
      const view = ctx._stageOverview(status, {}, {}, 'starting');
      assert.equal(view.side[1], 'Waiting for you');
      assert.match(view.next[1], state === 'checkpoint' ? /verification/ : /Sign in/);
      assert.doesNotMatch(JSON.stringify(view), /about 2 minutes|First sender browser opens|Workers sleep/i);
      assert.equal(view.metricValues[2], 'Waiting');
    });
  }
}
test('real VM startup keeps its existing startup estimate', () => {
  const view = ctx._stageOverview({ launchPhase: 'accepted' }, {}, {}, 'starting');
  assert.equal(view.side[1], 'about 2 minutes');
});
test('follow-up login trouble does not overwrite a running sender or active monitoring schedule', () => {
  const sending = ctx._stageOverview({ batchDone: 1, batchSize: 8, followupBlocked: 2 }, {}, {}, 'sending');
  assert.equal(sending.side[0], 'This account batch');
  const monitoring = ctx._stageOverview({ followupBlocked: 2 }, {}, {}, 'monitoring');
  assert.equal(monitoring.side[1], '20 min');
});
