/**
 * "Import from CSV" — staging a Connections Collector export as an off-GoLogin
 * account's connections, so the normal Check → Import runs against it.
 *
 * The collector writes this exact header (see the extension's popup.js):
 *   LinkedIn Membership ID, Location, First Name, Last Name, LinkedIn Bio,
 *   Company Name, Job Title, Email, Linkedin First Connections, HubSpot Link
 * and tags the owner into "Linkedin First Connections" as ";<owner>".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mapExtensionRows, stageConnectionsCsv, splitDelimited, detectDelimiter,
} from '../../src/connections/magellan-csv-import.js';

const HEADER = 'LinkedIn Membership ID,Location,First Name,Last Name,LinkedIn Bio,Company Name,Job Title,Email,Linkedin First Connections,HubSpot Link';
const row = (id, loc, fn, ln, url, co, title, owner) =>
  `${id},${loc},${fn},${ln},${url},${co},${title},${id}@linkedinmembership.id,${owner ? `;${owner}` : ''},`;

const sample = [
  HEADER,
  row('123', 'Singapore', 'Ada', 'Lovelace', 'https://www.linkedin.com/in/ada', 'Analytical Engines', 'Founder', 'steven@ortusclub.com'),
  row('456', 'London', 'Alan', 'Turing', 'https://www.linkedin.com/in/alan', 'Bletchley', 'Cryptanalyst', 'steven@ortusclub.com'),
].join('\n') + '\n';

test('maps the collector columns onto Magellan connection rows', () => {
  const m = mapExtensionRows(sample);
  assert.equal(m.hadMemberIdColumn, true);
  assert.equal(m.total, 2);
  assert.equal(m.rows.length, 2);
  assert.deepEqual(m.rows[0], {
    firstName: 'Ada', lastName: 'Lovelace',
    url: 'https://www.linkedin.com/in/ada',
    email: '', // Magellan generates the synthetic key at import — never from the file
    company: 'Analytical Engines', position: 'Founder',
    connectedOn: '', memberId: '123', location: 'Singapore',
  });
});

test('rows with no numeric member id are skipped and counted, not imported', () => {
  const text = [
    HEADER,
    row('789', 'Paris', 'Marie', 'Curie', 'https://x/in/marie', 'Radium', 'Physicist', 'steven@ortusclub.com'),
    ',,No,Member,,,,,;steven@ortusclub.com,',       // blank member id
    'notanumber,,Bad,Id,,,,,;steven@ortusclub.com,', // non-numeric member id
  ].join('\n') + '\n';
  const m = mapExtensionRows(text);
  assert.equal(m.total, 3);
  assert.equal(m.rows.length, 1);
  assert.equal(m.skippedNoMemberId, 2);
  assert.equal(m.rows[0].memberId, '789');
});

test('recovers the owner from the "Linkedin First Connections" tag', () => {
  const m = mapExtensionRows(sample);
  assert.equal(m.owner, 'steven@ortusclub.com');
});

test('owner is null when the file tags two different owners (must be typed)', () => {
  const text = [
    HEADER,
    row('1', 'A', 'One', 'X', 'u', 'C', 'T', 'steven@ortusclub.com'),
    row('2', 'B', 'Two', 'Y', 'u', 'C', 'T', 'antonio@ortusclub.com'),
  ].join('\n') + '\n';
  assert.equal(mapExtensionRows(text).owner, null);
});

test('a file with no member-id column is refused with a collector-specific message', () => {
  // The raw LinkedIn "Export connections" CSV — First Name, Last Name, URL,
  // Email, Company, Position, Connected On. No member id → nothing to key on.
  const raw = 'First Name,Last Name,URL,Email Address,Company,Position,Connected On\nAda,Lovelace,https://x,,Engines,Founder,01 Jan 2020\n';
  const m = mapExtensionRows(raw);
  assert.equal(m.hadMemberIdColumn, false);
  assert.throws(() => stageConnectionsCsv('steven@ortusclub.com', raw, { write: () => 'f' }),
    /Connections Collector/);
});

test('stage writes the mapped rows under the owner email and reports the counts', () => {
  let seen = null;
  const write = (account, rows) => { seen = { account, rows }; return `/data/${account}.csv`; };
  const out = stageConnectionsCsv('Steven@Ortusclub.com', sample, { write });
  assert.equal(out.account, 'steven@ortusclub.com', 'account is lower-cased to match buildPreview');
  assert.equal(out.staged, 2);
  assert.equal(out.skippedNoMemberId, 0);
  assert.equal(out.file, '/data/steven@ortusclub.com.csv');
  assert.equal(seen.account, 'steven@ortusclub.com');
  assert.equal(seen.rows.length, 2);
});

test('stage falls back to the file-tagged owner when no owner is given', () => {
  let seen = null;
  const write = (account, rows) => { seen = { account, rows }; return 'f'; };
  const out = stageConnectionsCsv('', sample, { write }); // owner blank → recovered from file
  assert.equal(out.account, 'steven@ortusclub.com');
  assert.equal(out.ownerFromFile, true);
  assert.equal(seen.rows.length, 2);
});

test('the explicit owner wins over the file tag', () => {
  const write = () => 'f';
  const out = stageConnectionsCsv('override@ortusclub.com', sample, { write });
  assert.equal(out.account, 'override@ortusclub.com');
  assert.equal(out.ownerFromFile, false);
});

test('stage refuses when neither an owner argument nor a file tag is present', () => {
  const untagged = [HEADER, row('1', 'A', 'One', 'X', 'u', 'C', 'T', '')].join('\n') + '\n';
  assert.throws(() => stageConnectionsCsv('', untagged, { write: () => 'f' }), /valid owner email/);
});

test('splitDelimited handles quoted fields with embedded commas', () => {
  assert.deepEqual(
    splitDelimited('123,"Singapore, SG","Ada ""A"" Lovelace"', ','),
    ['123', 'Singapore, SG', 'Ada "A" Lovelace'],
  );
});

test('detectDelimiter picks tab only when tabs outnumber commas', () => {
  assert.equal(detectDelimiter('a,b,c'), ',');
  assert.equal(detectDelimiter('a\tb\tc'), '\t');
});
