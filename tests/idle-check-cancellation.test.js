import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { preparePrimarySession } from '../src/primary-session-control.js';

const source = readFileSync(new URL('../src/campaign.js', import.meta.url), 'utf8');
const start = source.indexOf('    async function runIdleBulkCheck(');
const end = source.indexOf('\n    let leadIndex', start);
assert.ok(start >= 0 && end > start);

function fixture(stopAt) {
  const controller = new AbortController();
  let checks = 0, sends = 0, closed = 0, released = 0;
  const campaign = { _abort: false, _abortController: controller };
  const run = vm.runInNewContext(source.slice(start, end) + '\nrunIdleBulkCheck;', {
    campaign, log() {}, token: 'fixture', mode: 'connect_and_introduce',
    preparePrimarySession,
    taskOwner: { campaignId: 'fixture', campaignRunId: 'run' },
    tpl: { primaryName: 'fixture', primaryIntroBody: 'fixture' }, templates: {}, senderFirstNames: {},
    sheetUrl: 'fixture-sheet', linkedinColumn: 'profile', _primaryIntroAllowed: () => true,
    activeBulkChecks: new Set(),
    browserSemaphore: { acquire: async () => {}, release: () => { released++; } },
    launchProfile: async (_id, _token, options) => {
      assert.equal(options.signal.aborted, false);
      if (stopAt === 'launch') controller.abort();
      return { page: {} };
    },
    closeProfile: async () => { closed++; return { browserClosed: true }; }, closeLocalBrowser: async () => { closed++; return { browserClosed: true }; },
    bulkCheckConnections: async () => {
      checks++;
      if (stopAt === 'check') controller.abort();
      return { connectedUrls: ['fixture-lead'] };
    },
    runAutoIntros: async options => { assert.equal(options.shouldAbort(), false); sends++; },
    runAutoDms: async () => assert.fail('wrong mode'),
    _extractSheetIdFromUrl: () => 'fixture', readBulkCheckCooldown: async () => ({}),
    bulkCheckKey: () => 'fixture', writeBulkCheckCooldown: async () => {},
  });
  return { run, result: () => ({ checks, sends, closed, released }) };
}
test('idle-check late launch observes its captured cancellation signal', async () => {
  const f = fixture('launch'); await f.run('fixture-account', 'fixture');
  assert.deepEqual(f.result(), { checks: 0, sends: 0, closed: 1, released: 1 });
});
test('idle check cancelled during reading does not start introductions', async () => {
  const f = fixture('check'); await f.run('fixture-account', 'fixture');
  assert.deepEqual(f.result(), { checks: 1, sends: 0, closed: 1, released: 1 });
});
test('uninterrupted idle check retains its introduction behavior', async () => {
  const f = fixture(); await f.run('fixture-account', 'fixture');
  assert.deepEqual(f.result(), { checks: 1, sends: 1, closed: 1, released: 1 });
});
