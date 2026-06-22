import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFilterGroups, searchContacts, slugVariants, lookupBySlugs } from '../../src/connections/hubspot-client.js';

test('builds AND base with OR-of-titles across groups', () => {
  const fg = buildFilterGroups({ countries: ['Singapore'], jobTitles: ['Director', 'Head of'] });
  assert.strictEqual(fg.length, 2);
  assert.deepStrictEqual(fg[0].filters[0], { propertyName: 'country', operator: 'IN', values: ['Singapore'] });
  assert.strictEqual(fg[0].filters[1].propertyName, 'jobtitle');
  assert.strictEqual(fg[1].filters[1].value, 'Head of');
});

test('single group when no titles', () => {
  const fg = buildFilterGroups({ companies: ['StarHub'] });
  assert.strictEqual(fg.length, 1);
  assert.strictEqual(fg[0].filters[0].propertyName, 'company');
});

test('paginates with injected fetch and flattens properties', async () => {
  const pages = [
    { results: [{ id: '1', properties: { firstname: 'A', linkedinbio: 'x' } }], paging: { next: { after: '100' } } },
    { results: [{ id: '2', properties: { firstname: 'B' } }] },
  ];
  let call = 0;
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => pages[call++] });
  const out = await searchContacts({ countries: ['SG'] }, { fetchImpl, token: 't' });
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].firstname, 'A');
  assert.strictEqual(out[1].id, '2');
});

test('slugVariants returns https/http www forms', () => {
  assert.deepStrictEqual(slugVariants('elson-chia'), [
    'https://www.linkedin.com/in/elson-chia', 'http://www.linkedin.com/in/elson-chia']);
});
test('lookupBySlugs batches slugs into linkedinbio IN and flattens results', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => { calls.push(JSON.parse(opts.body));
    return { ok: true, status: 200, json: async () => ({ results: [{ id: '1', properties: { firstname: 'A', linkedinbio: 'https://www.linkedin.com/in/a' } }] }) }; };
  const out = await lookupBySlugs(['a', 'b'], { fetchImpl, token: 't', valuesPerBatch: 4 });
  assert.strictEqual(calls.length, 1);                                   // 2 slugs × 2 variants = 4 ≤ 4 → one batch
  assert.strictEqual(calls[0].filterGroups[0].filters[0].values.length, 4);
  assert.strictEqual(calls[0].filterGroups[0].filters[0].operator, 'IN');
  assert.strictEqual(out[0].firstname, 'A');
});
