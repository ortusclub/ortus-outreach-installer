import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

// The ledger stops a SoO weekly tally being bumped twice for the same send, and
// four campaigns reconcile at once off the board poll. Before this fix they all
// wrote one shared "<file>.tmp": the first rename moved it away and the rest
// threw ENOENT, losing the ledger (Sam's log, 1 Sep — six failures in seven
// minutes across four campaign ids).
//
// Every case here passes an EMPTY accountEmails map on purpose. That path still
// records the campaign and still calls persist(), which is what is under test,
// while reaching no SoO and no network: a unit test must never post to the live
// Apps Script.
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ortus-ledger-'));
process.env.ORTUS_DATA_DIR = dir;
process.env.ORTUS_SOO_WRITEBACK = '0';
const mod = await import('../src/cloud-soo-reconcile.js');
const FILE = path.join(dir, 'cloud-soo-reconcile.json');

const run = (id) => mod.reconcileCloudConnections({
  id,
  mode: 'connect_only',
  accountEmails: {},
  leads: [{ id: `${id}-lead`, status: 'sent', sentAt: new Date().toISOString(), account: 'acct' }],
});

test('four concurrent saves all resolve and leave a readable ledger', async () => {
  // Not allSettled: a rejection here IS the bug. One writer's rename used to
  // delete the temp file the next three were about to rename.
  await Promise.all(['a', 'b', 'c', 'd'].map((k) => run(`campaign-${k}`)));
  const saved = JSON.parse(await fs.readFile(FILE, 'utf8'));
  assert.ok(saved.campaigns, 'the ledger file must exist and parse after concurrent saves');
});

test('every campaign reconciled is in the ledger once the writes have settled', async () => {
  await run('campaign-last'); // one more save, so the newest file holds them all
  const saved = JSON.parse(await fs.readFile(FILE, 'utf8'));
  for (const k of ['a', 'b', 'c', 'd', 'last']) {
    assert.ok(saved.campaigns[`campaign-${k}`], `campaign-${k} must be in the saved ledger`);
  }
});

test('no temp files are left behind for the next run to trip over', async () => {
  const leftovers = (await fs.readdir(dir)).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], 'a save must clean up its own temp file');
});

test('an unwritable ledger warns instead of throwing, so the reconcile still returns', async () => {
  // The SoO bump has ALREADY happened by the time persist() runs, so throwing
  // loses the return value that tells the caller what was counted.
  await fs.chmod(dir, 0o500);
  try {
    const r = await run('campaign-readonly');
    assert.ok(r && typeof r.bumped === 'number', 'a failed save must still return a result');
  } finally {
    await fs.chmod(dir, 0o700);
  }
});
