// The cloud In-Use flip has to be retryable.
//
// A cloud campaign flips its accounts to "In Use" ONCE, at dispatch. If the SoO
// was unreachable then, accountEmails came back empty, every account was
// skipped, and nothing ever re-ran it — so the campaign sent for days with every
// account still reading "Available" on the board. A local run retries on the
// next lead; reconcileCloudInUse is the cloud equivalent, driven by the same
// poll that reconciles the sheet and the weekly tally.
//
// Trigger parity matters as much as the retry: local flips on the first actual
// SEND, so an account that never sends is never reserved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// dataPath() resolves ORTUS_DATA_DIR at import time, so point it at a scratch
// dir BEFORE the module graph loads — the durable settle-list is a real file.
process.env.ORTUS_DATA_DIR = mkdtempSync(join(tmpdir(), 'ortus-soo-test-'));
const { reconcileCloudInUse } = await import('../src/cloud-soo-reconcile.js');

/** Stub global fetch; every call resolves to `body` as a 200 JSON response. */
function stubFetch(body) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (_url, opts) => {
    calls.push(JSON.parse((opts && opts.body) || '{}'));
    return { ok: true, status: 200, json: async () => body };
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

function failFetch() {
  const calls = { n: 0 };
  const real = globalThis.fetch;
  globalThis.fetch = async () => {
    calls.n++;
    throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

const WRITTEN = { matched: true, written: ['CC (Credits)'] };
const sent = (id, account) => ({ id, account, status: 'sent', sentAt: new Date().toISOString() });

test('a mode that writes nothing to the SoO never touches the network', async () => {
  const f = stubFetch(WRITTEN);
  try {
    const r = await reconcileCloudInUse({
      id: 'c-msg', mode: 'message_only',
      accountEmails: { p1: 'a@ortus.solutions' },
      leads: [sent('l1', 'p1')],
    });
    assert.equal(r.flipped, 0);
    assert.equal(f.calls.length, 0, 'message_only has no credit column — resolveSoOTarget returns null');
  } finally { f.restore(); }
});

test('only accounts that actually SENT are reserved', async () => {
  const f = stubFetch(WRITTEN);
  try {
    const r = await reconcileCloudInUse({
      id: 'c-partial', mode: 'connect_only',
      accountEmails: { p1: 'sender@ortus.solutions', p2: 'idle@ortus.solutions' },
      // p2 is on the campaign but has only a pending lead — same as local, where
      // the flip fires from the send path and an idle account is never flipped.
      leads: [sent('l1', 'p1'), { id: 'l2', account: 'p2', status: 'pending' }],
      operatorEmail: 'me@ortus.solutions',
    });
    assert.equal(r.flipped, 1);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].email, 'sender@ortus.solutions');
    assert.equal(f.calls[0].fields['CC (Credits)'], 'In Use');
    assert.equal(f.calls[0].fields['CC App User'], 'me@ortus.solutions');
  } finally { f.restore(); }
});

test('a flipped account is settled durably — the next poll does not re-POST', async () => {
  let f = stubFetch(WRITTEN);
  try {
    await reconcileCloudInUse({
      id: 'c-settle', mode: 'connect_only',
      accountEmails: { p1: 'a@ortus.solutions' }, leads: [sent('l1', 'p1')],
    });
    assert.equal(f.calls.length, 1);
  } finally { f.restore(); }

  f = stubFetch(WRITTEN);
  try {
    const r = await reconcileCloudInUse({
      id: 'c-settle', mode: 'connect_only',
      accountEmails: { p1: 'a@ortus.solutions' }, leads: [sent('l1', 'p1'), sent('l2', 'p1')],
    });
    assert.equal(r.flipped, 0);
    assert.equal(f.calls.length, 0, 'settled accounts are skipped, so the poll costs nothing');
  } finally { f.restore(); }
});

test('a transport failure leaves the account UNsettled so the next poll retries', async () => {
  const fail = failFetch();
  try {
    const r = await reconcileCloudInUse({
      id: 'c-retry', mode: 'connect_only',
      accountEmails: { p1: 'a@ortus.solutions' }, leads: [sent('l1', 'p1')],
      retryOpts: { baseDelayMs: 0, sleep: async () => {} },  // don't sit through the real backoff
    });
    assert.equal(r.flipped, 0);
    assert.ok(fail.calls.n > 0);
  } finally { fail.restore(); }

  // This is the whole point: the account was NOT written off after one failure.
  const ok = stubFetch(WRITTEN);
  try {
    const r = await reconcileCloudInUse({
      id: 'c-retry', mode: 'connect_only',
      accountEmails: { p1: 'a@ortus.solutions' }, leads: [sent('l1', 'p1')],
    });
    assert.equal(r.flipped, 1, 'the retry lands once the webapp answers');
    assert.equal(ok.calls.length, 1);
  } finally { ok.restore(); }
});

test('a guard skip settles — the dispatch-time flip already reserved it', async () => {
  // matched, but nothing written: the credit cell was not "Available", almost
  // always because the flip at dispatch got there first. Deterministic, so it
  // must not re-POST on every 4s poll for the campaign's whole life.
  const f = stubFetch({ matched: true, written: [], skipped: ['CC (Credits) (not Available: "in use")'] });
  try {
    await reconcileCloudInUse({
      id: 'c-guard', mode: 'connect_only',
      accountEmails: { p1: 'a@ortus.solutions' }, leads: [sent('l1', 'p1')],
    });
    assert.equal(f.calls.length, 1);
  } finally { f.restore(); }

  const f2 = stubFetch(WRITTEN);
  try {
    await reconcileCloudInUse({
      id: 'c-guard', mode: 'connect_only',
      accountEmails: { p1: 'a@ortus.solutions' }, leads: [sent('l1', 'p1')],
    });
    assert.equal(f2.calls.length, 0);
  } finally { f2.restore(); }
});

test('no row matched settles too — retrying cannot conjure a row', async () => {
  const f = stubFetch({ matched: false });
  try {
    await reconcileCloudInUse({
      id: 'c-norow', mode: 'connect_only',
      accountEmails: { p1: 'ghost@ortus.solutions' }, leads: [sent('l1', 'p1')],
    });
    assert.equal(f.calls.length, 1);
  } finally { f.restore(); }

  const f2 = stubFetch({ matched: false });
  try {
    await reconcileCloudInUse({
      id: 'c-norow', mode: 'connect_only',
      accountEmails: { p1: 'ghost@ortus.solutions' }, leads: [sent('l1', 'p1')],
    });
    assert.equal(f2.calls.length, 0);
  } finally { f2.restore(); }
});
