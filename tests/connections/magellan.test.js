import test from 'node:test';
import assert from 'node:assert/strict';
import {
  syntheticEmail, mergeConnections, isHidden, createProperties,
  updateProperties, hasAnyEmail, hasSyntheticEmail, planAccount,
  CONNECTIONS_PROP, MEMBER_ID_PROP,
} from '../../src/connections/magellan.js';

const ACCT = 'antonio@ortusclub.com';
const person = (over = {}) => ({
  slug: 'alebrambi', memberId: '29418762', firstName: 'Alessandra',
  lastName: 'Brambilla', company: 'NTT DATA', jobTitle: 'Executive Managing Director',
  ...over,
});

test('synthetic email matches the HS Extension format exactly', () => {
  assert.equal(syntheticEmail('417986156'), '417986156@linkedinmembership.id');
});

test('mergeConnections adds an account with the leading semicolon', () => {
  assert.equal(mergeConnections('', ACCT), ';antonio@ortusclub.com');
  assert.equal(mergeConnections(';soleil@ortusclub.com', ACCT),
    ';soleil@ortusclub.com;antonio@ortusclub.com');
});

test('mergeConnections is idempotent — re-collecting never grows the value', () => {
  assert.equal(mergeConnections(';antonio@ortusclub.com', ACCT), null);
  assert.equal(mergeConnections(';ANTONIO@ortusclub.com', ACCT), null);
});

test('rows LinkedIn blanked out are hidden, not written', () => {
  // A real archive row: everything empty except Connected On.
  assert.equal(isHidden({ slug: '', memberId: '', firstName: '', lastName: '' }), true);
  assert.equal(isHidden(person()), false);
});

test('create carries the synthetic email as primary', () => {
  const p = createProperties(person(), ACCT);
  assert.equal(p.email, '29418762@linkedinmembership.id');
  assert.equal(p[MEMBER_ID_PROP], '29418762');
  assert.equal(p.linkedinbio, 'https://www.linkedin.com/in/alebrambi');
  assert.equal(p[CONNECTIONS_PROP], ';antonio@ortusclub.com');
});

test('create omits blank fields rather than writing empty strings', () => {
  const p = createProperties(person({ company: '', jobTitle: '   ' }), ACCT);
  assert.ok(!('company' in p));
  assert.ok(!('jobtitle' in p));
});

// The one that matters most: at 400k contacts, writing `email` on update would
// overwrite real addresses across the whole CRM.
test('update NEVER writes email, even when the contact has none', () => {
  const p = updateProperties(person(), ACCT, {});
  assert.ok(!('email' in p), 'update must not carry an email property');
});

test('update fills blanks but never overwrites what a human already set', () => {
  const p = updateProperties(person(), ACCT, { company: 'Corrected Ltd', firstname: '' });
  assert.equal(p.company, undefined, 'existing company must survive');
  assert.equal(p.firstname, 'Alessandra', 'blank field gets filled');
});

test('update with nothing new produces no properties, so no call is made', () => {
  const existing = {
    [MEMBER_ID_PROP]: '29418762',
    [CONNECTIONS_PROP]: ';antonio@ortusclub.com',
    firstname: 'Alessandra', lastname: 'Brambilla',
    company: 'NTT DATA', jobtitle: 'Executive Managing Director',
  };
  assert.deepEqual(updateProperties(person(), ACCT, existing), {});
});

test('hasAnyEmail sees primary and additional addresses', () => {
  assert.equal(hasAnyEmail({}), false);
  assert.equal(hasAnyEmail({ email: 'a@b.com' }), true);
  assert.equal(hasAnyEmail({ hs_additional_emails: 'x@y.com;z@w.com' }), true);
});

test('hasSyntheticEmail finds the key in either slot', () => {
  assert.equal(hasSyntheticEmail({ email: '29418762@linkedinmembership.id' }, '29418762'), true);
  assert.equal(hasSyntheticEmail({ hs_additional_emails: '29418762@linkedinmembership.id' }, '29418762'), true);
  assert.equal(hasSyntheticEmail({ email: 'real@person.com' }, '29418762'), false);
});

test('planAccount splits new, existing, hidden and unresolved', () => {
  const rows = [
    person(),                                              // new
    person({ memberId: '111', slug: 'known' }),            // already in HubSpot
    { slug: '', memberId: '', firstName: '' },             // hidden by LinkedIn
    person({ memberId: '', slug: 'no-id-yet' }),           // needs a retry
  ];
  const plan = planAccount(rows, ACCT, (c) => (c.memberId === '111'
    ? { id: '900', properties: { email: 'real@person.com' } } : null));

  assert.equal(plan.counts.created, 1);
  assert.equal(plan.counts.updated, 1);
  assert.equal(plan.counts.hidden, 1);
  assert.equal(plan.counts.unresolved, 1);
});

test('an existing contact with a real email keeps it — synthetic goes alongside', () => {
  const plan = planAccount([person({ memberId: '111' })], ACCT,
    () => ({ id: '900', properties: { email: 'real@person.com' } }));

  assert.equal(plan.updates[0].properties.email, undefined);
  assert.deepEqual(plan.additionalEmails, [
    { id: '900', email: '111@linkedinmembership.id', asPrimary: false },
  ]);
});

test('an existing contact with no email gets the synthetic as primary', () => {
  const plan = planAccount([person({ memberId: '111' })], ACCT,
    () => ({ id: '900', properties: {} }));
  assert.equal(plan.additionalEmails[0].asPrimary, true);
});

test('a contact already carrying the synthetic key is not re-stamped', () => {
  const plan = planAccount([person({ memberId: '111' })], ACCT,
    () => ({ id: '900', properties: { email: '111@linkedinmembership.id' } }));
  assert.equal(plan.additionalEmails.length, 0);
});

test('the same member id twice in one export produces one write', () => {
  const plan = planAccount([person(), person()], ACCT, () => null);
  assert.equal(plan.counts.created, 1);
});
