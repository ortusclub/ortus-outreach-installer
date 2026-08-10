import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  formatConnectedOn, readExistingBySlug, mergeRows, toCsv, writeAccountCsv,
  readForPlan, CSV_HEADER,
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
    lastName: 'Brambilla', company: 'NTT DATA', jobTitle: 'MD',
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
