import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsCloudHandshake, runCloudPreflightHandshake } from '../src/cloud-preflight-handshake.js';

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
    async acceptAllPendingInvitations() { return { accepted: 0 }; },
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
  const store = {
    [storeKey('a', key)]: { state: 'connected', primaryUrl },
    [storeKey('b', key)]: { state: 'connected', primaryUrl },
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
  const { deps } = makeDeps({ store, deps: { async acceptAllPendingInvitations() { sweeps++; return { accepted: 3 }; } } });
  const r = await runCloudPreflightHandshake({
    senderProfileIds: ['a'], primaryUrl, autoAcceptAllPending: true, deps,
  });
  assert.equal(r.ok, true);
  assert.equal(sweeps, 1, 'accept-all sweep ran even though the sender was already connected');
});
