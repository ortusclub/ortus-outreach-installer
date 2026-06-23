import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildFgTargets } from '../../src/connections/search-service.js';

// Two operators' networks: alice@ and bob@ . Carol is connected via BOTH.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-targets-'));
const dir = path.join(tmp, 'connections');
fs.mkdirSync(dir, { recursive: true });
const cachePath = path.join(tmp, 'cache.json');

const HDR = 'First Name,Last Name,URL,Email Address,Company,Position,Connected On\n';
fs.writeFileSync(path.join(dir, 'alice@ortus.solutions.csv'),
  `Notes:\n\n${HDR}` +
  `Mara,Lee,https://www.linkedin.com/in/mara-m,,Acme,Head of Marketing,01 Jan 2025\n` +
  `Carol,Fox,https://www.linkedin.com/in/carol-c,,Globex,Engineer,01 Jan 2025\n` +
  `Dan,Roe,https://www.linkedin.com/in/dan-d,,Initech,Brand Lead,01 Jan 2025\n`);
fs.writeFileSync(path.join(dir, 'bob@ortus.solutions.csv'),
  `Notes:\n\n${HDR}` +
  `Carol,Fox,https://www.linkedin.com/in/carol-c,,Globex,Engineer,01 Jan 2025\n`);

fs.writeFileSync(cachePath, JSON.stringify({
  builtAt: '2026-06-23T00:00:00.000Z', slugsProcessed: 4, totalSlugs: 4,
  contacts: [
    { id: '1', firstname: 'Mara', lastname: 'Lee', linkedinbio: 'https://www.linkedin.com/in/mara-m', linkedin_membership_id: '100', company: 'Acme', jobtitle: 'Head of Marketing', country: 'United Kingdom', state: '', city: 'London', hs_lead_status: 'OPEN', lastmodifieddate: '1' },
    { id: '2', firstname: 'Carol', lastname: 'Fox', linkedinbio: 'https://www.linkedin.com/in/carol-c', linkedin_membership_id: '200', company: 'Globex', jobtitle: 'Engineer', country: 'United Kingdom', state: '', city: 'London', hs_lead_status: 'OPEN', lastmodifieddate: '1' },
    { id: '3', firstname: 'Dan', lastname: 'Roe', linkedinbio: 'https://www.linkedin.com/in/dan-d', linkedin_membership_id: '300', company: 'Initech', jobtitle: 'Brand Lead', country: 'United Kingdom', state: '', city: 'London', hs_lead_status: 'OPEN', lastmodifieddate: '1' },
    { id: '4', firstname: 'Eve', lastname: 'Sky', linkedinbio: 'https://www.linkedin.com/in/eve-e', linkedin_membership_id: '400', company: 'Umbrella', jobtitle: 'CMO', country: 'United Kingdom', state: '', city: 'London', hs_lead_status: 'UNSUBSCRIBED', lastmodifieddate: '1' },
  ],
}));

const opts = { dir, cachePath };
const MARKETER = ['marketing', 'brand', 'growth', 'cmo'];

test('scopes to one operator network via warmVia', () => {
  const r = buildFgTargets({}, { operator: 'bob@ortus.solutions', ...opts });
  assert.equal(r.count, 1);
  assert.equal(r.rows[0][0], 'Carol Fox');
});

test('applies the function/title filter (jobTitles keywords)', () => {
  const r = buildFgTargets({ jobTitles: MARKETER }, { operator: 'alice@ortus.solutions', ...opts });
  const names = r.rows.map((row) => row[0]).sort();
  assert.deepEqual(names, ['Dan Roe', 'Mara Lee']);
});

test('excludes DNC contacts', () => {
  const r = buildFgTargets({ jobTitles: ['cmo'] }, { operator: 'alice@ortus.solutions', ...opts });
  assert.equal(r.rows.find((row) => row[0] === 'Eve Sky'), undefined);
});

test('dedupes against already-invited Member IDs', () => {
  const r = buildFgTargets({ jobTitles: MARKETER }, { operator: 'alice@ortus.solutions', alreadyInvited: ['100'], ...opts });
  const names = r.rows.map((row) => row[0]);
  assert.deepEqual(names, ['Dan Roe']);
});

test('caps at remaining budget', () => {
  const r = buildFgTargets({ jobTitles: MARKETER }, { operator: 'alice@ortus.solutions', budget: 1, ...opts });
  assert.equal(r.count, 1);
  assert.equal(r.eligible, 2);
});
