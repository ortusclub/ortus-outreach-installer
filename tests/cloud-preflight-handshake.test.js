import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  needsCloudHandshake,
  primaryBrowserProblemFromUrl,
  runCloudPreflightHandshake,
} from '../src/cloud-preflight-handshake.js';

// ── needsCloudHandshake: the trigger matrix ──
test('needsCloudHandshake: CC+IC + auto-accept + local-browser primary → true', () => {
  assert.equal(needsCloudHandshake({ mode: 'connect_and_introduce', autoAcceptPrimary: true, primarySource: 'local-browser' }), true);
});
test('needsCloudHandshake: defaults primarySource to local-browser', () => {
  assert.equal(needsCloudHandshake({ mode: 'connect_and_introduce', autoAcceptPrimary: true }), true);
});
test('needsCloudHandshake: GoLogin primary → false (VM can accept itself)', () => {
  assert.equal(needsCloudHandshake({ mode: 'connect_and_introduce', autoAcceptPrimary: true, primarySource: 'gl-profile-123' }), false);
});
test('needsCloudHandshake: auto-accept off → false', () => {
  assert.equal(needsCloudHandshake({ mode: 'connect_and_introduce', autoAcceptPrimary: false, primarySource: 'local-browser' }), false);
});
test('needsCloudHandshake: non-CC+IC modes → false', () => {
  for (const mode of ['connect_only', 'connect_and_message', 'open_profile_only', 'message_only']) {
    assert.equal(needsCloudHandshake({ mode, autoAcceptPrimary: true, primarySource: 'local-browser' }), false, mode);
  }
});

test('primary browser login and checkpoint redirects are operator actions', () => {
  assert.equal(primaryBrowserProblemFromUrl('https://www.linkedin.com/uas/login').state, 'logged-out');
  assert.equal(primaryBrowserProblemFromUrl('https://www.linkedin.com/authwall').state, 'logged-out');
  assert.equal(primaryBrowserProblemFromUrl('https://www.linkedin.com/checkpoint/challenge/').state, 'checkpoint');
  assert.equal(primaryBrowserProblemFromUrl('https://www.linkedin.com/mynetwork/invitation-manager/received/'), null);
});

// ── injectable deps for runCloudPreflightHandshake ──
function makeDeps(overrides = {}) {
  const calls = { launchProfile: [], closeProfile: [], launchLocalBrowser: 0, closeLocalBrowser: 0, accept: [], enqueue: [], saved: null };
  const deps = {
    async loadPrimaryStatus() { return overrides.store || {}; },
    async savePrimaryStatus(_file, map) { calls.saved = map; },
    async launchProfile(id) { calls.launchProfile.push(id); return { page: { __id: id } }; },
    async closeProfile(id) { calls.closeProfile.push(id); },
    async launchLocalBrowser() { calls.launchLocalBrowser++; return { page: { __primary: true } }; },
    async closeLocalBrowser() { calls.closeLocalBrowser++; },
    async checkAndConnectPrimary() { return { connected: false, connectAttempted: true, connectResult: 'sent' }; },
    async readSelfIdentity(page) { return { name: `self-${page.__id}`, profileUrl: `https://linkedin.com/in/${page.__id}` }; },
    async acceptInvitationFrom(_page, account) { calls.accept.push(account); return { accepted: true }; },
    async acceptAllPendingInvitations() { return { cleared: 0, remaining: 1 }; },
    async enqueuePrimaryTask(t) { calls.enqueue.push(t); return t; },
    sleep: async () => {},
    now: () => 1_000,
    ...overrides.deps,
  };
  return { deps, calls };
}

test('self-eliminates when every sender is already connected (launches nothing)', async () => {
  // Seed the store so both senders resolve to connected via seedConnectedIds.
  // seedConnectedIds keys on storeKey(profileId, primaryKey); use a store whose
  // entries mark them connected. Simpler: make planAccountsNeedingConnect see them
  // connected by pre-seeding through the store contract.
  const primaryUrl = 'https://www.linkedin.com/in/pat-primary/';
  // Build a store that seedConnectedIds will read as connected for our key.
  const { primaryKeyFromUrl, storeKey } = await import('../src/primary-status-store.js');
  const key = primaryKeyFromUrl(primaryUrl);
  // Freshly verified: a connected stamp older than a week is re-checked, not trusted.
  const verifiedAt = new Date().toISOString();
  const store = {
    [storeKey('a', key)]: { state: 'connected', primaryUrl, verifiedAt },
    [storeKey('b', key)]: { state: 'connected', primaryUrl, verifiedAt },
  };
  const { deps, calls } = makeDeps({ store });
  const r = await runCloudPreflightHandshake({
    senderProfileIds: ['a', 'b'], primaryUrl, autoAcceptAllPending: false, deps,
  });
  assert.equal(r.ok, true);
  assert.equal(calls.launchProfile.length, 0, 'no sender launched');
  assert.equal(calls.launchLocalBrowser, 0, 'primary not launched');
  assert.equal(r.connected, 2);
});

test('GoLogin provider refusal does not trigger a second whole-browser launch', async () => {
  const { deps, calls } = makeDeps();
  deps.launchProfile = async id => {
    calls.launchProfile.push(id);
    throw Object.assign(new Error('GoLogin requests are limited'), {
      provider: 'gologin', retryable: false, code: 'GOLOGIN_RATE_LIMIT',
    });
  };
  const logs = [];
  await runCloudPreflightHandshake({ senderProfileIds: ['a'],
    primaryUrl: 'https://www.linkedin.com/in/fixture-primary/',
    autoAcceptAllPending: false, deps, log: line => logs.push(line),
  });
  assert.deepEqual(calls.launchProfile, ['a']);
  assert.equal(calls.accept.length, 0);
  assert.ok(logs.some(line => /after 1 attempt/.test(line)));
});

test('happy path: N senders connect then get accepted by the primary', async () => {
  const { deps, calls } = makeDeps();
  const r = await runCloudPreflightHandshake({
    senderProfileIds: ['a', 'b'], primaryUrl: 'https://linkedin.com/in/pat', deps,
  });
  assert.equal(r.ok, true);
  assert.equal(calls.launchProfile.length, 2, 'both senders launched to connect');
  assert.deepEqual(calls.closeProfile, ['a', 'b'], 'both sender sessions closed');
  assert.equal(calls.launchLocalBrowser, 1, 'primary launched once to accept');
  assert.equal(calls.closeLocalBrowser, 1, 'primary closed');
  assert.equal(calls.accept.length, 2, 'both invitations accepted');
  assert.equal(r.connected, 2);
  assert.equal(r.accepted, 2);
  assert.equal(r.pending, 0);
  assert.equal(calls.enqueue.length, 0, 'nothing left for the idle runner');
});

test('a logged-out primary is reported explicitly and no accept is attempted', async () => {
  let accepts = 0;
  const { deps, calls } = makeDeps({
    deps: {
      async inspectPrimarySession() {
        return { state: 'logged-out', reason: 'The primary browser is logged out of LinkedIn.' };
      },
      async acceptInvitationFrom() { accepts++; return { accepted: true }; },
    },
  });
  const r = await runCloudPreflightHandshake({
    senderProfileIds: ['a'], primaryUrl: 'https://linkedin.com/in/pat', deps,
  });
  assert.equal(accepts, 0, 'a sign-in page is not an invitation inbox');
  assert.equal(r.primary.state, 'logged-out');
  assert.equal(r.primary.source, 'local-browser');
  assert.equal(r.pending, 1);
  assert.equal(calls.enqueue.length, 1, 'the sent invitation remains recoverable');
});

test('accept timeout: unaccepted invites are enqueued for the idle runner', async () => {
  let t = 0;
  const { deps, calls } = makeDeps({
    deps: {
      async acceptInvitationFrom() { return { accepted: false }; }, // never accepts
      // advance time past the cap so shouldProceed breaks after one pass
      now: () => (t += 200_000),
    },
  });
  const r = await runCloudPreflightHandshake({
    senderProfileIds: ['a', 'b'], primaryUrl: 'https://linkedin.com/in/pat', deps,
  });
  assert.equal(r.ok, true, 'never blocks the launch');
  assert.equal(r.pending, 2, 'both left pending');
  assert.equal(calls.enqueue.length, 2, 'both queued for the idle primary runner');
  assert.equal(r.accepted, 0);
});

test('no senders / no primaryUrl → ok:true, no work', async () => {
  const { deps, calls } = makeDeps();
  const r1 = await runCloudPreflightHandshake({ senderProfileIds: [], primaryUrl: 'https://linkedin.com/in/pat', deps });
  assert.equal(r1.ok, true);
  const r2 = await runCloudPreflightHandshake({ senderProfileIds: ['a'], primaryUrl: '', deps });
  assert.equal(r2.ok, true);
  assert.equal(calls.launchProfile.length, 0);
});

test('self-eliminate still streams progress so the wizard shows connected, not stuck Waiting', async () => {
  const primaryUrl = 'https://linkedin.com/in/pat';
  const { primaryKeyFromUrl, storeKey } = await import('../src/primary-status-store.js');
  const key = primaryKeyFromUrl(primaryUrl);
  const store = { [storeKey('a', key)]: { state: 'connected', primaryUrl }, [storeKey('b', key)]: { state: 'connected', primaryUrl } };
  const seen = [];
  const { deps } = makeDeps({ store });
  await runCloudPreflightHandshake({
    senderProfileIds: ['a', 'b'], primaryUrl, deps, onProgress: (e) => seen.push(e),
  });
  const connected = [...new Set(seen.filter((e) => e.state === 'connected').map((e) => e.profileId))];
  assert.deepEqual(connected.sort(), ['a', 'b'], 'both already-connected senders emitted connected');
});

test('accept-all sweep runs when autoAcceptAllPending even if senders already connected', async () => {
  const primaryUrl = 'https://linkedin.com/in/pat';
  const { primaryKeyFromUrl, storeKey } = await import('../src/primary-status-store.js');
  const key = primaryKeyFromUrl(primaryUrl);
  const store = { [storeKey('a', key)]: { state: 'connected', primaryUrl } };
  let sweeps = 0;
  const { deps } = makeDeps({ store, deps: { async acceptAllPendingInvitations() { sweeps++; return { cleared: 3, remaining: 1 }; } } });
  const r = await runCloudPreflightHandshake({
    senderProfileIds: ['a'], primaryUrl, autoAcceptAllPending: true, deps,
  });
  assert.equal(r.ok, true);
  assert.equal(sweeps, 1, 'accept-all sweep ran even though the sender was already connected');
});

// ── Phase-1 → Phase-2 settle: give sent requests time to land before accepting ──
test('waits a 20s settle AFTER sending requests, BEFORE opening the primary to accept (retries untouched)', async () => {
  const primaryUrl = 'https://www.linkedin.com/in/pat-primary/';
  const events = [];
  const deps = {
    async loadPrimaryStatus() { return {}; },
    async savePrimaryStatus() {},
    async launchProfile(id) { return { page: { __id: id } }; },
    async closeProfile() {},
    async launchLocalBrowser() { events.push('open-primary'); return { page: { __primary: true } }; },
    async closeLocalBrowser() {},
    async checkAndConnectPrimary(page) { events.push('connect:' + page.__id); return { connected: false, connectAttempted: true, connectResult: 'sent' }; },
    async readSelfIdentity(page) { return { name: 'self-' + page.__id, profileUrl: 'https://linkedin.com/in/' + page.__id }; },
    async acceptInvitationFrom() { events.push('accept'); return { accepted: true }; },
    async acceptAllPendingInvitations() { return { cleared: 0, remaining: 1 }; },
    async enqueuePrimaryTask(t) { return t; },
    sleep: async (ms) => { events.push('sleep:' + ms); },
    now: () => 1000,
  };
  const r = await runCloudPreflightHandshake({ senderProfileIds: ['a', 'b'], primaryUrl, deps });
  assert.equal(r.ok, true);
  assert.equal(r.connected, 2);

  const settleIdx = events.indexOf('sleep:20000');
  assert.ok(settleIdx >= 0, 'a 20s settle happened between the two phases');
  assert.ok(events.indexOf('connect:a') >= 0 && events.indexOf('connect:a') < settleIdx, 'sender a sent its request before the settle');
  assert.ok(events.indexOf('connect:b') >= 0 && events.indexOf('connect:b') < settleIdx, 'sender b sent its request before the settle');
  assert.ok(events.indexOf('open-primary') > settleIdx, 'the primary browser opens only AFTER the settle');
  assert.ok(events.indexOf('accept') > settleIdx, 'no accept is attempted before the settle');
});

test('no settle when there is nothing newly sent (pure accept-all sweep of existing invites)', async () => {
  const primaryUrl = 'https://www.linkedin.com/in/pat-primary/';
  const { primaryKeyFromUrl, storeKey } = await import('../src/primary-status-store.js');
  const key = primaryKeyFromUrl(primaryUrl);
  const store = { [storeKey('a', key)]: { state: 'connected', primaryUrl } };
  const slept = [];
  const deps = {
    async loadPrimaryStatus() { return store; },
    async savePrimaryStatus() {},
    async launchProfile(id) { return { page: { __id: id } }; },
    async closeProfile() {},
    async launchLocalBrowser() { return { page: { __primary: true } }; },
    async closeLocalBrowser() {},
    async checkAndConnectPrimary() { return { connected: true, connectAttempted: false }; },
    async readSelfIdentity() { return {}; },
    async acceptInvitationFrom() { return { accepted: true }; },
    async acceptAllPendingInvitations() { return { cleared: 0, remaining: 1 }; },
    async enqueuePrimaryTask(t) { return t; },
    sleep: async (ms) => { slept.push(ms); },
    now: () => 1000,
  };
  // 'a' already connected → nothing queued; autoAcceptAllPending still sweeps.
  const r = await runCloudPreflightHandshake({ senderProfileIds: ['a'], primaryUrl, autoAcceptAllPending: true, deps });
  assert.equal(r.ok, true);
  assert.ok(!slept.includes(20000), 'no 20s settle when no fresh request was sent');
});

test('accept-all that empties the list skips the per-sender wait entirely', async () => {
  let matcherCalls = 0;
  let slept = 0;
  const { deps } = makeDeps({
    deps: {
      async acceptAllPendingInvitations() { return { cleared: 2, remaining: 0, verifiedEmpty: true }; },
      async acceptInvitationFrom() { matcherCalls++; return { accepted: false }; },
      async sleep(ms) { slept += ms; },
    },
  });
  const summary = await runCloudPreflightHandshake({
    senderProfileIds: ['p1'],
    primaryUrl: 'https://www.linkedin.com/in/primary/',
    autoAcceptAllPending: true,
    deps,
  });
  assert.equal(matcherCalls, 0, 'the identifier-matching loop must not run at all');
  assert.equal(summary.pending, 0);
  assert.ok(slept <= 20_000, 'no 30s poll cycles — only the settle wait at most');
});

test('an ambiguous zero from changed LinkedIn markup does not falsely mark the sender accepted', async () => {
  let matcherCalls = 0;
  const { deps } = makeDeps({
    deps: {
      // This is the observed failure: no safe person-named Accept controls were
      // readable, so remaining is numerically zero but emptiness is unverified.
      async acceptAllPendingInvitations() { return { cleared: 0, remaining: 0, verifiedEmpty: false }; },
      async acceptInvitationFrom() { matcherCalls++; return { accepted: false }; },
      now: (() => { let t = 0; return () => (t += 200_000); })(),
    },
  });
  const summary = await runCloudPreflightHandshake({
    senderProfileIds: ['p1'],
    primaryUrl: 'https://www.linkedin.com/in/primary/',
    autoAcceptAllPending: true,
    deps,
  });
  assert.ok(matcherCalls >= 1, 'fall back to the named sender verifier');
  assert.equal(summary.connected, 0, 'never claim a connection that was not verified');
  assert.equal(summary.pending, 1, 'leave the invitation pending for a later verified attempt');
});

test('accept-all that leaves something waiting still falls back to the matcher', async () => {
  let matcherCalls = 0;
  const { deps } = makeDeps({
    deps: {
      async acceptAllPendingInvitations() { return { cleared: 1, remaining: 2 }; },
      async acceptInvitationFrom() { matcherCalls++; return { accepted: true }; },
    },
  });
  await runCloudPreflightHandshake({
    senderProfileIds: ['p1'],
    primaryUrl: 'https://www.linkedin.com/in/primary/',
    autoAcceptAllPending: true,
    deps,
  });
  assert.ok(matcherCalls >= 1, 'a non-empty list means we cannot assume our own invites were accepted');
});

test('a frozen sender is closed, marked truthfully, and does not block the next sender', async () => {
  const { deps, calls } = makeDeps({
    deps: {
      async checkAndConnectPrimary(page) {
        if (page.__id === 'a') return new Promise(() => {});
        return { connected: true, connectAttempted: false, connectResult: '' };
      },
    },
  });
  const events = [];
  const summary = await runCloudPreflightHandshake({
    senderProfileIds: ['a', 'b'],
    primaryUrl: 'https://linkedin.com/in/pat',
    senderStepTimeoutMs: 5,
    deps,
    onProgress: (event) => events.push(event),
  });
  assert.deepEqual(calls.launchProfile, ['a', 'a', 'b'], 'the frozen sender gets one fresh browser, then the next sender gets its turn');
  assert.ok(calls.closeProfile.includes('a'), 'the exact frozen browser is closed');
  const frozen = summary.senders.find((sender) => sender.profileId === 'a');
  assert.equal(frozen.state, 'browser-frozen');
  assert.match(frozen.reason, /no request was confirmed/i);
  assert.equal(frozen.attempt, 2);
  assert.equal(frozen.maxAttempts, 2);
  assert.ok(events.some((event) => event.profileId === 'a' && event.state === 'reopening' && event.attempt === 2));
  assert.ok(events.some((event) => event.profileId === 'a' && event.state === 'browser-frozen'));
  assert.equal(summary.senders.find((sender) => sender.profileId === 'b').state, 'connected');
});

test('a sender that freezes once is reopened and can recover on attempt 2', async () => {
  let checks = 0;
  const { deps, calls } = makeDeps({
    deps: {
      async checkAndConnectPrimary() {
        checks++;
        if (checks === 1) return new Promise(() => {});
        return { connected: true, connectAttempted: false, connectResult: '' };
      },
    },
  });
  const events = [];
  const summary = await runCloudPreflightHandshake({
    senderProfileIds: ['a'],
    primaryUrl: 'https://linkedin.com/in/pat',
    senderStepTimeoutMs: 5,
    deps,
    onProgress: (event) => events.push(event),
  });
  assert.deepEqual(calls.launchProfile, ['a', 'a']);
  assert.ok(calls.closeProfile.filter((id) => id === 'a').length >= 2);
  assert.ok(events.some((event) => event.state === 'reopening' && event.attempt === 2));
  assert.ok(events.some((event) => event.state === 'connecting' && event.attempt === 2 && event.deadlineAt > 0));
  assert.equal(summary.senders[0].state, 'connected');
  assert.equal(summary.senders[0].attempt, 2);
  assert.equal(summary.senders[0].reason, '');
});

test('an unreadable LinkedIn result gets one fresh-browser recheck', async () => {
  let checks = 0;
  const { deps, calls } = makeDeps({
    deps: {
      async checkAndConnectPrimary() {
        checks++;
        if (checks === 1) return { connected: null, connectAttempted: false, connectResult: '', error: 'page could not be read' };
        return { connected: true, connectAttempted: false, connectResult: '' };
      },
    },
  });
  const summary = await runCloudPreflightHandshake({
    senderProfileIds: ['a'], primaryUrl: 'https://linkedin.com/in/pat', deps,
  });
  assert.deepEqual(calls.launchProfile, ['a', 'a']);
  assert.equal(summary.senders[0].state, 'connected');
  assert.equal(summary.senders[0].attempt, 2);
});

test('a LinkedIn rate limit is not hammered with an immediate second attempt', async () => {
  const { deps, calls } = makeDeps({
    deps: {
      async checkAndConnectPrimary() {
        return { connected: null, connectAttempted: true, connectResult: 'failed', error: 'HTTP 429 Too Many Requests' };
      },
    },
  });
  const summary = await runCloudPreflightHandshake({
    senderProfileIds: ['a'], primaryUrl: 'https://linkedin.com/in/pat', deps,
  });
  assert.deepEqual(calls.launchProfile, ['a']);
  assert.equal(summary.senders[0].state, 'not-sent');
  assert.match(summary.senders[0].reason, /429/);
});

test('cancelling closes the exact active sender and stops before later senders', async () => {
  const controller = new AbortController();
  let entered;
  const insideCheck = new Promise((resolve) => { entered = resolve; });
  const { deps, calls } = makeDeps({
    deps: {
      async checkAndConnectPrimary() {
        entered();
        return new Promise(() => {});
      },
    },
  });
  const running = runCloudPreflightHandshake({
    senderProfileIds: ['a', 'b'],
    primaryUrl: 'https://linkedin.com/in/pat',
    signal: controller.signal,
    deps,
  });
  await insideCheck;
  controller.abort(new Error('operator cancelled'));
  await assert.rejects(running, /operator cancelled/);
  assert.ok(calls.closeProfile.includes('a'), 'active sender was closed');
  assert.deepEqual(calls.launchProfile, ['a'], 'no later sender started after cancellation');
});
