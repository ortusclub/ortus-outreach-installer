import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { setTimeout as handshakeDelay } from 'node:timers/promises';
import { planAccountsNeedingConnect, handshakeProgress, shouldProceed } from '../src/preflight-handshake.js';
import { inspectPrimarySession, waitForPrimaryRecovery } from '../src/primary-browser-session.js';

// Execute the actual nested orchestrator with inert browser dependencies.
// This catches fall-through after await, not just the helper's decision logic.
const source = readFileSync(new URL('../src/campaign.js', import.meta.url), 'utf8');
const start = source.indexOf('    async function runPreflightHandshake() {');
const end = source.indexOf('\n    // #8: seed connection-to-primary', start);
assert.ok(start > 0 && end > start);
function fixture(overrides = {}) {
  const logs = [], actions = [], closed = [];
  const campaign = { _abortController: new AbortController(), _primaryConn: new Map(), _primaryConnSource: new Map() };
  const context = {
    campaign, mode: 'connect_and_introduce', profileIds: ['one', 'two'],
    tpl: { primaryUrl: 'https://www.linkedin.com/in/primary', autoAcceptPrimary: true },
    isOrphan: () => false, planAccountsNeedingConnect, handshakeProgress, shouldProceed,
    log: s => logs.push(s), setAction: s => actions.push(s),
    ensureOpen: async () => null, closeSession: async id => closed.push(id),
    handshakeDelay, inspectPrimarySession, waitForPrimaryRecovery, Date, ...overrides,
  };
  const run = vm.runInNewContext(`(${source.slice(start, end).trim()})`, context);
  return { context, campaign, logs, actions, closed, run };
}

for (const lateSession of [null, { pName: 'one', page: {} }]) {
  test(`Stop during sender preparation cannot report ready or advance (session=${!!lateSession})`, async () => {
    const f = fixture(); let opens = 0;
    f.context.ensureOpen = async () => {
      opens++;
      f.campaign._abort = true;
      f.campaign._abortController.abort();
      return lateSession;
    };
    await f.run();
    assert.equal(opens, 1);
    assert.deepEqual(f.closed, lateSession ? ['one'] : []);
    assert.doesNotMatch(f.logs.join('\n'), /connections ready|starting outreach|background/i);
    assert.deepEqual(f.actions, ['Preparing introductions']);
  });
}

test('unavailable senders report incomplete preparation, never ready', async () => {
  const f = fixture();
  await f.run();
  assert.match(f.logs.join('\n'), /preparation incomplete.*2 account/);
  assert.doesNotMatch(f.logs.join('\n'), /connections ready/i);
  assert.equal(f.actions.at(-1), 'Primary preparation incomplete');
});

test('Stop during primary preparation closes its session without readiness or fallback', async () => {
  const f = fixture({ taskOwner: {}, browserSemaphore: { release() {} } });
  f.context.tpl.autoAcceptAllPending = true;
  let closed = 0;
  f.context.preparePrimarySession = async () => {
    f.campaign._abortController.abort();
    return { page: {}, close: async () => closed++ };
  };
  await f.run();
  assert.equal(closed, 1);
  assert.doesNotMatch(f.logs.join('\n'), /connections ready|starting outreach|queuing/i);
});

test('all confirmed primary links still report ready', async () => {
  const f = fixture({ taskOwner: {}, browserSemaphore: { release() {} },
    preparePrimarySession: async () => ({ page: {}, close: async () => {} }),
    acceptAllPendingInvitations: async () => {},
  });
  f.context.tpl.autoAcceptAllPending = true;
  f.campaign._primaryConn.set('one', 'connected');
  f.campaign._primaryConn.set('two', 'connected');
  await f.run();
  assert.match(f.logs.join('\n'), /Primary connections ready/);
});

test('logged-out primary waits after closing; retry does not repeat sender preparation', async () => {
  let opens = 0, closes = 0, inspections = 0, waits = 0;
  const f = fixture({ taskOwner: {}, browserSemaphore: { release() {} },
    ensureOpen: async () => { opens++; return null; },
    preparePrimarySession: async () => ({ page: {}, close: async () => closes++ }),
    inspectPrimarySession: async () => ++inspections <= 2 ? { state: 'logged-out', reason: 'Primary logged out.' } : null,
    acceptAllPendingInvitations: async () => {},
    waitForPrimaryRecovery: async () => { waits++; assert.equal(closes, waits); return true; },
  });
  f.context.tpl.autoAcceptAllPending = true;
  await f.run();
  assert.equal(opens, 2, 'each sender prepared only once, not once per retry');
  assert.equal(waits, 2);
  assert.equal(inspections, 3);
  assert.doesNotMatch(f.logs.join('\n'), /queuing for the idle runner/);
  assert.match(f.logs.join('\n'), /Sending is waiting/);
});

test('Stop while waiting for primary login exits without outreach readiness', async () => {
  const f = fixture({ taskOwner: {}, browserSemaphore: { release() {} },
    preparePrimarySession: async () => ({ page: {}, close: async () => {} }),
    inspectPrimarySession: async () => ({ state: 'logged-out', reason: 'Primary logged out.' }),
    waitForPrimaryRecovery: async () => { f.campaign._abortController.abort(); return false; },
  });
  f.context.tpl.autoAcceptAllPending = true;
  await f.run();
  assert.doesNotMatch(f.logs.join('\n'), /connections ready|outreach starting|preparation incomplete/);
});
