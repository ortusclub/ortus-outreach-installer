import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConnectionsStats, searchConnections, exportConnections, buildLeadRows } from '../../src/connections/search-service.js';

// Build an isolated fixture: one network CSV + a matching HubSpot cache file.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-svc-'));
const dir = path.join(tmp, 'connections');
fs.mkdirSync(dir, { recursive: true });
const cachePath = path.join(tmp, 'cache.json');

fs.writeFileSync(
  path.join(dir, 'alice@ortus.solutions.csv'),
  `Notes:\n"preamble line"\n\nFirst Name,Last Name,URL,Email Address,Company,Position,Connected On\n` +
    `Alice,Ng,https://www.linkedin.com/in/alice-a,,Acme,Director,01 Jan 2025\n` +
    `Bob,Tan,https://www.linkedin.com/in/bob-b,,Globex,Engineer,01 Jan 2025\n`,
);

fs.writeFileSync(
  cachePath,
  JSON.stringify({
    builtAt: '2026-06-22T00:00:00.000Z',
    slugsProcessed: 2,
    totalSlugs: 2,
    contacts: [
      { id: '1', firstname: 'Alice', lastname: 'Ng', linkedinbio: 'https://www.linkedin.com/in/alice-a', linkedin_membership_id: '41857001', country: 'Singapore', state: 'Central', city: 'Singapore', jobtitle: 'Director of Operations', company: 'Acme', hs_lead_status: 'OPEN', lastmodifieddate: '1000' },
      { id: '2', firstname: 'Bob', lastname: 'Tan', linkedinbio: 'https://www.linkedin.com/in/bob-b', country: 'Singapore', state: '', city: '', jobtitle: 'Engineer', company: 'Globex', hs_lead_status: 'UNSUBSCRIBED', lastmodifieddate: '1000' },
    ],
  }),
);

const opts = { dir, cachePath };

test('stats report networks + cache state', () => {
  const s = getConnectionsStats(opts);
  assert.equal(s.networks, 1);
  assert.equal(s.uniqueSlugs, 2);
  assert.equal(s.cache.built, true);
  assert.equal(s.cache.complete, true);
  assert.equal(s.cache.contacts, 2);
});

test('search filters by country, drops DNC, annotates warmVia', () => {
  const r = searchConnections({ countries: ['Singapore'] }, opts);
  assert.equal(r.count, 1); // Bob is UNSUBSCRIBED → dropped
  assert.equal(r.results[0].firstName, 'Alice');
  assert.ok(r.results[0].warmVia.includes('alice@ortus.solutions'));
  assert.ok(r.results[0].hasWarm);
});

test('search surfaces connectedOn, linkedinId, region/city; counts DNC separately', () => {
  const r = searchConnections({ countries: ['Singapore'] }, opts);
  assert.equal(r.count, 1);          // Alice only — Bob (UNSUBSCRIBED) excluded from results
  assert.equal(r.warmCount, 1);      // Alice is warmly reachable
  assert.equal(r.dncExcluded, 1);    // Bob matched Singapore but is DNC
  const a = r.results[0];
  assert.equal(a.linkedinId, '41857001');
  assert.equal(a.region, 'Central');
  assert.equal(a.city, 'Singapore');
  assert.equal(a.dnc, false);
  assert.ok(Array.isArray(a.warmDetails));
  assert.equal(a.warmDetails[0].connectedOn, '01 Jan 2025');
  assert.equal(a.warmDetails[0].name, 'alice@ortus.solutions');
  // DNC contacts surface separately so the UI can show them greyed/unselectable.
  assert.equal(r.dncResults.length, 1);
  assert.equal(r.dncResults[0].firstName, 'Bob');
  assert.equal(r.dncResults[0].dnc, true);
});

test('geo field matches country, region, or city (level-free)', () => {
  assert.equal(searchConnections({ geo: ['Singapore'] }, opts).count, 1); // Alice (country & city)
  assert.equal(searchConnections({ geo: ['Central'] }, opts).count, 1);   // Alice (region/state)
  assert.equal(searchConnections({ geo: ['Atlantis'] }, opts).count, 0);
  assert.equal(searchConnections({ geo: ['Singapore'] }, opts).dncExcluded, 1); // Bob matches but is DNC
});

test('jobTitle filter uses substring match', () => {
  assert.equal(searchConnections({ jobTitles: ['Director'] }, opts).count, 1); // "Director of Operations"
  assert.equal(searchConnections({ jobTitles: ['Nurse'] }, opts).count, 0);
});

test('export writes lead CSV, drops DNC, honours url selection', () => {
  const all = exportConnections({ countries: ['Singapore'] }, opts);
  assert.equal(all.count, 1);
  assert.match(all.csv, /Alice/);
  assert.doesNotMatch(all.csv, /Bob/);

  const none = exportConnections({ countries: ['Singapore'] }, { ...opts, urls: ['https://www.linkedin.com/in/nobody'] });
  assert.equal(none.count, 0);
});

test('buildLeadRows returns header + rectangular string rows, drops DNC', () => {
  const { header, rows, count } = buildLeadRows({ countries: ['Singapore'] }, opts);
  assert.deepEqual(header, ['First Name', 'Last Name', 'LinkedIn URL', 'Company', 'Job Title', 'Country', 'Primary', 'Primary URL', 'Stage']);
  assert.equal(count, 1);            // Bob (DNC) dropped
  assert.equal(rows.length, 1);
  assert.equal(rows[0].length, header.length);
  assert.equal(rows[0][0], 'Alice');
  assert.equal(rows[0][6], 'alice@ortus.solutions'); // Primary = connector (no colleagues meta → email)
  rows[0].forEach((cell) => assert.equal(typeof cell, 'string'));
});
