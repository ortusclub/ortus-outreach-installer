/**
 * The "HubSpot Link" column — Abygael's way to check a person really landed,
 * without searching the portal for them one at a time.
 *
 * The column can only be filled once an id is known, and ids arrive at two
 * different moments: Check learns them for people already in HubSpot, Import
 * learns them for the people it creates. Before either, the cell is blank.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  connectionsRowsForAccount, CONNECTIONS_HEADER,
  addHubspotIds, resetHubspotIds, hubspotIdCount,
} from '../../src/connections/magellan-sheet.js';
import { hubspotContactUrl, HUBSPOT_PORTAL_ID } from '../../src/connections/magellan.js';

const PERSON = { memberId: '2723390', firstName: 'Dawn', lastName: 'Maloney', slug: 'dawnmaloney' };
const ACCOUNT = 'antoniovarlese@ortus.solutions';
const LINK = CONNECTIONS_HEADER.indexOf('HubSpot Link');

test('the column exists, and it is the last one', () => {
  assert.equal(LINK, 9);
  assert.equal(CONNECTIONS_HEADER.length, 10);
});

test('before anything is known the cell is blank, not a broken link', () => {
  const [row] = connectionsRowsForAccount(ACCOUNT, [PERSON], new Map());
  assert.equal(row[LINK], '');
});

test('a known id becomes a link to that contact', () => {
  const ids = new Map([['2723390', '221275842971']]);
  const [row] = connectionsRowsForAccount(ACCOUNT, [PERSON], ids);
  assert.equal(row[LINK],
    `https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/contact/221275842971`);
});

test('the portal id is the live one, read off the account not remembered', () => {
  assert.equal(HUBSPOT_PORTAL_ID, '2748825');
});

test('a blank or missing id never produces a URL', () => {
  assert.equal(hubspotContactUrl(''), '');
  assert.equal(hubspotContactUrl(null), '');
  assert.equal(hubspotContactUrl(undefined), '');
  assert.equal(hubspotContactUrl('  '), '');
});

test('ids from Check and from Import add up rather than replacing each other', () => {
  resetHubspotIds();
  addHubspotIds([['1', 'a']]);            // Check: already in HubSpot
  addHubspotIds([['2', 'b']]);            // Import: just created
  const rows = connectionsRowsForAccount(ACCOUNT, [
    { memberId: '1', slug: 'x' }, { memberId: '2', slug: 'y' }, { memberId: '3', slug: 'z' },
  ]);
  assert.equal(rows[0][LINK].endsWith('/contact/a'), true);
  assert.equal(rows[1][LINK].endsWith('/contact/b'), true);
  assert.equal(rows[2][LINK], '', 'never checked, never created — nothing to link');
  resetHubspotIds();
});

test('a rejected create contributes no id, so its row stays blank', () => {
  resetHubspotIds();
  addHubspotIds([['9', null], ['10', undefined], ['', 'orphan']]);
  assert.equal(hubspotIdCount(), 0);
  const [row] = connectionsRowsForAccount(ACCOUNT, [{ memberId: '9', slug: 'q' }]);
  assert.equal(row[LINK], '');
});

test('a fresh sweep drops last run links', () => {
  resetHubspotIds();
  addHubspotIds([['1', 'a']]);
  assert.equal(hubspotIdCount(), 1);
  resetHubspotIds();
  assert.equal(hubspotIdCount(), 0);
});

test('numeric member ids from the CSV still match string-keyed ids', () => {
  const ids = new Map([['2723390', '555']]);
  const [row] = connectionsRowsForAccount(ACCOUNT, [{ memberId: 2723390, slug: 'n' }], ids);
  assert.equal(row[LINK].endsWith('/contact/555'), true);
});

test('the other nine columns are untouched by the addition', () => {
  const ids = new Map([['2723390', '77']]);
  const [row] = connectionsRowsForAccount(ACCOUNT, [PERSON], ids);
  assert.deepEqual(row.slice(0, 9), ['2723390', '', 'Dawn', 'Maloney',
    'https://www.linkedin.com/in/dawnmaloney', '', '', '2723390@linkedinmembership.id',
    ';antoniovarlese@ortus.solutions']);
});

/**
 * The trap this nearly fell into: Import adds no PEOPLE, it only fills the
 * link column. publish() skips a tab whose row count is unchanged, so a
 * count-only cache key would have skipped the exact write that publishes the
 * links — the feature would have looked built and shipped nothing.
 */
test('filling links rewrites the tab even though the row count is identical', async () => {
  const { publish, resetPublished } = await import('../../src/connections/magellan-sheet.js');
  resetPublished();
  resetHubspotIds();

  const wrote = [];
  const deps = {
    write: async (tab, header, rows) => { wrote.push({ tab, rows }); return { url: 'u' }; },
    read: () => [{ memberId: '1', firstName: 'A', slug: 'a' }],
  };
  const state = { perAccount: [{ account: ACCOUNT }] };

  await publish(state, deps);
  assert.equal(wrote.filter((w) => w.tab === ACCOUNT).length, 1, 'collect writes the tab once');

  // Same people, same count — but now they have links.
  addHubspotIds([['1', 'c1']]);
  await publish(state, { ...deps, force: true });
  const after = wrote.filter((w) => w.tab === ACCOUNT);
  assert.equal(after.length, 2, 'the link fill must not be cached away');
  assert.equal(after[1].rows[0][LINK].endsWith('/contact/c1'), true);

  // Nothing new learned: back to skipping, so a poll does not rewrite forever.
  await publish(state, { ...deps, force: true });
  assert.equal(wrote.filter((w) => w.tab === ACCOUNT).length, 2);
  resetHubspotIds();
  resetPublished();
});
