import { test } from 'node:test';
import assert from 'node:assert/strict';
import { annotate, matchesCriteria } from '../../src/connections/match.js';

const index = new Map([
  ['elson-chia', [{ colleague: 'bea.talusan@ortus.solutions', connectedOn: '16 Oct 2025' }]],
]);

test('keeps the numerically-newer record when lastmodifieddate is epoch-millis strings', () => {
  const contacts = [
    { id: 'old', firstname: 'X', linkedinbio: 'https://www.linkedin.com/in/dupe-x', lastmodifieddate: '999999999999' },
    { id: 'new', firstname: 'X', linkedinbio: 'https://www.linkedin.com/in/dupe-x', lastmodifieddate: '1700000000000' },
  ];
  const rows = annotate(contacts, new Map());
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].contact.id, 'new');
});

test('annotates warm matches, drops DNC, dedupes by slug', () => {
  const contacts = [
    { id: '1', firstname: 'Elson', linkedinbio: 'https://www.linkedin.com/in/elson-chia', lastmodifieddate: '2025-01-01' },
    { id: '2', firstname: 'Elson', linkedinbio: 'https://www.linkedin.com/in/elson-chia', lastmodifieddate: '2026-01-01' }, // dupe, newer
    { id: '3', firstname: 'Cold', linkedinbio: 'https://www.linkedin.com/in/nobody-x' },
    { id: '4', firstname: 'Gone', linkedinbio: 'https://www.linkedin.com/in/elson-chia', hs_lead_status: 'UNSUBSCRIBED' },
  ];
  const rows = annotate(contacts, index);
  const elson = rows.find(r => r.slug === 'elson-chia');
  assert.ok(elson.hasWarm);
  assert.deepStrictEqual(elson.warmVia, ['bea.talusan@ortus.solutions']);
  assert.strictEqual(elson.contact.id, '2');            // kept the newer record
  assert.ok(rows.find(r => r.slug === 'nobody-x' && !r.hasWarm)); // cold result still returned
  assert.strictEqual(rows.length, 2);                   // DNC row dropped, dupe merged
});

test('matchesCriteria: country exact, title/company substring, empty lists pass', () => {
  const c = { country: 'Singapore', jobtitle: 'Digital Marketing Director', company: 'Kimberly-Clark' };
  assert.ok(matchesCriteria(c, { countries: ['singapore'], jobTitles: ['director'] }));
  assert.ok(matchesCriteria(c, {}));
  assert.ok(!matchesCriteria(c, { countries: ['Malaysia'] }));
  assert.ok(!matchesCriteria(c, { jobTitles: ['Engineer'] }));
});
