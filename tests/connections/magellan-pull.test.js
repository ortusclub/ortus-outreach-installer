import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  formatConnectedOn, readExistingBySlug, mergeRows, toCsv, writeAccountCsv,
  readForPlan, collectAccount, listCollected, CSV_HEADER, migrateLegacyConnections,
} from '../../src/connections/magellan-pull.js';
import { ingestFolder } from '../../src/connections/csv-ingest.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'magellan-'));
}

// A real LinkedIn archive export: preamble, blank line, then the header.
const ARCHIVE = `Notes:
"When exporting your connection data, you may notice that some of the email addresses are missing."

First Name,Last Name,URL,Email Address,Company,Position,Connected On
Alessandra,Brambilla,https://www.linkedin.com/in/alebrambi,,NTT DATA,Executive Managing Director,15 Jun 2026
,,,,,,30 Apr 2026
`;

test('formatConnectedOn matches LinkedIn\'s own format', () => {
  assert.equal(formatConnectedOn(Date.UTC(2026, 5, 15)), '15 Jun 2026');
  assert.equal(formatConnectedOn(0), '');
});

test('readExistingBySlug pulls company and position out of an archive export', () => {
  const dir = tmpdir();
  const f = path.join(dir, 'antonio@ortusclub.com.csv');
  fs.writeFileSync(f, ARCHIVE);
  const bySlug = readExistingBySlug(f);
  assert.equal(bySlug.get('alebrambi').company, 'NTT DATA');
  assert.equal(bySlug.get('alebrambi').position, 'Executive Managing Director');
  // The all-blank row has no URL, so it cannot be keyed and is simply absent.
  assert.equal(bySlug.size, 1);
});

// The live connections API returns no company/title. Losing the archive's 95%
// coverage on the first collection would be a silent downgrade.
test('mergeRows keeps company and position that only the archive has', () => {
  const dir = tmpdir();
  const f = path.join(dir, 'a.csv');
  fs.writeFileSync(f, ARCHIVE);
  const rows = mergeRows(
    [{ publicId: 'alebrambi', firstName: 'Alessandra', lastName: 'Brambilla', memberNumber: '29418762', connectedAt: Date.UTC(2026, 5, 15) }],
    readExistingBySlug(f),
  );
  assert.equal(rows[0].company, 'NTT DATA');
  assert.equal(rows[0].position, 'Executive Managing Director');
  assert.equal(rows[0].memberId, '29418762', 'member id comes from the live pull');
});

test('mergeRows keeps a member id already on disk when the live pull misses it', () => {
  const bySlug = new Map([['alebrambi', { memberId: '29418762', company: '', position: '' }]]);
  const rows = mergeRows([{ publicId: 'alebrambi', memberNumber: '' }], bySlug);
  assert.equal(rows[0].memberId, '29418762');
});

test('toCsv emits the archive header plus Member ID', () => {
  const first = toCsv([]).split('\n')[0];
  assert.equal(first, CSV_HEADER.join(','));
  assert.ok(first.startsWith('First Name,Last Name,URL'), 'archive column order preserved');
});

test('toCsv quotes fields containing commas', () => {
  const csv = toCsv([{ firstName: 'A', lastName: 'B', url: '', email: '', company: 'Foo, Inc', position: '', connectedOn: '', memberId: '1' }]);
  assert.ok(csv.includes('"Foo, Inc"'));
});

// The written file feeds the warm-reach database, so the existing ingest has to
// read it without changes.
test('a file written by Magellan is readable by the existing csv-ingest', () => {
  const dir = tmpdir();
  writeAccountCsv('antonio@ortusclub.com', [
    { firstName: 'Alessandra', lastName: 'Brambilla', url: 'https://www.linkedin.com/in/alebrambi', email: '', company: 'NTT DATA', position: 'MD', connectedOn: '15 Jun 2026', memberId: '29418762' },
  ], { dir });

  const { index, stats } = ingestFolder(dir);
  assert.equal(stats.withUrl, 1);
  assert.equal(index.get('alebrambi')[0].colleague, 'antonio@ortusclub.com');
  assert.equal(index.get('alebrambi')[0].connectedOn, '15 Jun 2026');
});

test('writeAccountCsv leaves no .tmp file behind', () => {
  const dir = tmpdir();
  writeAccountCsv('x@y.com', [], { dir });
  assert.deepEqual(fs.readdirSync(dir), ['x@y.com.csv']);
});

test('readForPlan returns rows the planner can consume', () => {
  const dir = tmpdir();
  writeAccountCsv('antonio@ortusclub.com', [
    { firstName: 'Alessandra', lastName: 'Brambilla', url: 'https://www.linkedin.com/in/alebrambi', email: '', company: 'NTT DATA', position: 'MD', connectedOn: '15 Jun 2026', memberId: '29418762' },
  ], { dir });

  const [row] = readForPlan('antonio@ortusclub.com', { dir });
  assert.deepEqual(row, {
    slug: 'alebrambi', memberId: '29418762', firstName: 'Alessandra',
    lastName: 'Brambilla', company: 'NTT DATA', jobTitle: 'MD', location: '',
  });
});

// Drive-synced files predate Magellan and have no Member ID column. They must
// still load — those rows just come back unresolved for the push to skip.
test('readForPlan handles a Drive-synced file with no Member ID column', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'old@ortus.solutions.csv'), ARCHIVE);
  const rows = readForPlan('old@ortus.solutions', { dir });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].memberId, '');
  assert.equal(rows[0].company, 'NTT DATA');
});

// A 7,000-connection account is ~175 pages inside one page.evaluate(). Without
// the beacon the card shows nothing for minutes and looks hung.
test('collectAccount reports progress while the walk is still running', async () => {
  const dir = tmpdir();
  const seen = [];
  let beacon = { count: 0, pages: 0, total: 7213 };
  const page = {
    url: () => 'https://www.linkedin.com/mynetwork/invite-connect/connections/',
    goto: async () => {},
    evaluate: async (fn) => {
      // The poller reads with a zero-arg fn; the walk is called with an argument.
      if (fn.length === 0) return beacon;
      // The real walk takes minutes on a big account — that is the whole point.
      await new Promise((r) => setTimeout(r, 3200));
      return { connections: [], firstPageKeys: '' };
    },
  };
  const p = collectAccount(page, 'nikki@ortusclub.com', {
    dir,
    onProgress: (x) => seen.push(x),
  });
  // Let a couple of poll ticks land while the "walk" is in flight.
  await new Promise((r) => setTimeout(r, 1700));
  beacon = { count: 480, pages: 12, total: 7213 };
  await new Promise((r) => setTimeout(r, 1600));
  await p;

  assert.ok(seen.length >= 1, 'progress was reported before the walk finished');
  const last = seen[seen.length - 1];
  assert.equal(last.total, 7213, 'the network size is passed through for "N of M"');
  assert.ok(last.pages >= 1);
});

test('no progress callback means no polling — bulk-check behaviour is unchanged', async () => {
  const dir = tmpdir();
  let evaluates = 0;
  const page = {
    url: () => 'https://www.linkedin.com/mynetwork/invite-connect/connections/',
    goto: async () => {},
    evaluate: async () => { evaluates += 1; return { connections: [], firstPageKeys: '' }; },
  };
  await collectAccount(page, 'x@y.com', { dir });
  assert.equal(evaluates, 1, 'only the walk itself — no beacon reads');
});

// The picker's route calls listCollected on every visit, and parsing 455 CSVs
// holding 70MB took ~1.9s of blocking work each time. The parse is cached per
// file on (mtime, size); a rewritten file must not serve the old count.
test('listCollected re-reads a file after it changes', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'a@b.com.csv');
  const ONE = `${CSV_HEADER.join(',')}\nx,y,https://www.linkedin.com/in/one,,,,,111\n`;
  const TWO = `${ONE}a,b,https://www.linkedin.com/in/two,,,,,\n`;
  fs.writeFileSync(file, TWO);

  const first = listCollected({ dir });
  assert.equal(first.get('a@b.com').count, 2);
  assert.equal(first.get('a@b.com').withMemberId, 1);

  // Prove the parse was actually SKIPPED, not merely that the answer matched:
  // make the file unreadable. stat() still works, so the (mtime, size) stamp is
  // unchanged and a cache hit still answers 2 — while a reparse would throw and
  // drop the account entirely.
  fs.chmodSync(file, 0o000);
  try {
    // Root ignores the mode bits, which would turn both assertions below into
    // silent passes. Say so rather than pretend the test ran.
    assert.throws(() => fs.readFileSync(file), 'this test cannot run as root');
    assert.equal(listCollected({ dir }).get('a@b.com').count, 2, 'served from cache');
    // ...and `fresh` — what the refresh button sends — really does reparse.
    assert.equal(listCollected({ dir, fresh: true }).get('a@b.com'), undefined, 'fresh reparses');
  } finally {
    fs.chmodSync(file, 0o600);
  }

  // An ordinary rewrite moves the size, so no bypass is needed for it.
  fs.writeFileSync(file, TWO);
  const after = listCollected({ dir }).get('a@b.com');
  assert.equal(after.count, 2);
  assert.equal(after.withMemberId, 1);
});

// ── where the collected CSVs live ────────────────────────────────────────────
// They used to live in the repo, so running the app from a worktree hid all 455
// of them and the card said "nothing has been collected yet" for accounts that
// had been read weeks earlier. They are user data; they live in ORTUS_DATA_DIR.

test('the legacy repo folder is copied across once, and never deleted', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mag-mig-'));
  const from = path.join(base, 'repo'); const to = path.join(base, 'data');
  fs.mkdirSync(from, { recursive: true });
  fs.writeFileSync(path.join(from, 'a@o.com.csv'), 'x');
  fs.writeFileSync(path.join(from, 'b@o.com.csv'), 'y');
  fs.writeFileSync(path.join(from, 'notes.txt'), 'not a csv');

  const r = migrateLegacyConnections({ from, to });
  assert.equal(r.moved, 2);
  assert.deepEqual(fs.readdirSync(to).sort(), ['a@o.com.csv', 'b@o.com.csv']);
  // The original is hours of LinkedIn reading. It stays put.
  assert.equal(fs.existsSync(path.join(from, 'a@o.com.csv')), true);
});

test('a destination that already holds CSVs is never overwritten', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mag-mig-'));
  const from = path.join(base, 'repo'); const to = path.join(base, 'data');
  fs.mkdirSync(from, { recursive: true }); fs.mkdirSync(to, { recursive: true });
  fs.writeFileSync(path.join(from, 'a@o.com.csv'), 'STALE');
  fs.writeFileSync(path.join(to, 'a@o.com.csv'), 'FRESH');

  const r = migrateLegacyConnections({ from, to });
  assert.equal(r.moved, 0);
  assert.equal(r.kept, 1);
  assert.equal(fs.readFileSync(path.join(to, 'a@o.com.csv'), 'utf8'), 'FRESH');
});

test('nothing to copy is not an error', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mag-mig-'));
  assert.deepEqual(migrateLegacyConnections({ from: path.join(base, 'nope'), to: path.join(base, 'to') }), { moved: 0 });
});

test('location survives the mergeRows → toCsv → readExistingBySlug round-trip', () => {
  // A live pull carries location on the enriched connection.
  const live = [{ publicId: 'jane-d', firstName: 'Jane', lastName: 'Doe', memberNumber: '111', location: 'New York, New York, United States' }];
  const rows = mergeRows(live, new Map());
  assert.equal(rows[0].location, 'New York, New York, United States');
  assert.ok(CSV_HEADER.includes('Location'));

  const dir = tmpdir();
  const file = writeAccountCsv('a@o.com', rows, { dir });
  const back = readExistingBySlug(file);
  assert.equal(back.get('jane-d').location, 'New York, New York, United States');

  const plan = readForPlan('a@o.com', { dir });
  assert.equal(plan.find((p) => p.slug === 'jane-d').location, 'New York, New York, United States');
});

test('an older CSV with no Location column reads back as blank, not undefined', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'old@o.com.csv');
  // Pre-Location schema — header stops at Member ID.
  fs.writeFileSync(file,
    'First Name,Last Name,URL,Email Address,Company,Position,Connected On,Member ID\n'
    + 'Ada,Ho,https://www.linkedin.com/in/adaho,,Acme,CEO,2024,555\n');
  const back = readExistingBySlug(file);
  assert.equal(back.get('adaho').location, '');
});

test('live location wins over the disk copy, disk is the fallback', () => {
  const prev = new Map([['jane-d', { company: 'X', position: 'Y', location: 'Old City' }]]);
  const rows = mergeRows([{ publicId: 'jane-d', firstName: 'Jane', memberNumber: '111', location: 'New City' }], prev);
  assert.equal(rows[0].location, 'New City');
  // No live location → fall back to disk.
  const rows2 = mergeRows([{ publicId: 'jane-d', firstName: 'Jane', memberNumber: '111' }], prev);
  assert.equal(rows2[0].location, 'Old City');
});
