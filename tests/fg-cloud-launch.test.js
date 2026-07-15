import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCloudLeads } from '../src/connections/fg-cloud-launch.js';

// FG row: [Name, URL, MemberID, Company, Title, ...]
const row = (name, url, member, company = 'Acme', title = 'CMO') =>
  [name, url, member, company, title, '', '', '', '', '', '', '', ''];

test('buildCloudLeads flattens rows to engine leads with routeAccount + row_data', () => {
  const pairs = [{ profileId: 'p1', account: 'a@x.com', operator: 'op@x.com', operatorName: 'Op' }];
  const deps = {
    buildTargets: () => ({ rows: [row('Jane Doe', 'https://linkedin.com/in/jane', '111')], count: 1, reason: '' }),
  };
  const { perAccount, leads } = buildCloudLeads(pairs, { month: '2026-07' }, deps);
  assert.equal(leads.length, 1);
  assert.deepEqual(leads[0], {
    leadUrl: 'https://linkedin.com/in/jane',
    fullName: 'Jane Doe',
    memberUrn: null,
    routeAccount: 'p1',
    row: { memberId: '111', name: 'Jane Doe', company: 'Acme', title: 'CMO' },
  });
  assert.equal(perAccount[0].profileId, 'p1');
  assert.equal(perAccount[0].account, 'a@x.com');
  assert.equal(perAccount[0].operator, 'op@x.com');
  assert.equal(perAccount[0].month, '2026-07');
  assert.deepEqual(perAccount[0].rowsByUrl, { 'https://linkedin.com/in/jane': '111' });
});

test('buildCloudLeads drops rows with an empty URL', () => {
  const pairs = [{ profileId: 'p1', account: 'a', operator: 'o' }];
  const deps = { buildTargets: () => ({ rows: [['No URL', '', '222']], count: 1, reason: '' }) };
  const { leads } = buildCloudLeads(pairs, { month: '2026-07' }, deps);
  assert.equal(leads.length, 0);
});

test('buildCloudLeads dedups a contact across accounts — first pair wins', () => {
  const shared = row('Shared Person', 'https://linkedin.com/in/shared', '999');
  const pairs = [
    { profileId: 'p1', account: 'a1', operator: 'o1' },
    { profileId: 'p2', account: 'a2', operator: 'o2' },
  ];
  const deps = { buildTargets: (pair) => ({ rows: [shared], count: 1, reason: '' }) };
  const { leads } = buildCloudLeads(pairs, { month: '2026-07' }, deps);
  assert.equal(leads.length, 1);
  assert.equal(leads[0].routeAccount, 'p1');
});
