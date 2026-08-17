/**
 * The pay-off of the lookup fallback: a shell the old process left behind stops
 * being a doomed create and becomes an update that ALSO repairs the record.
 *
 * This is what makes the fix self-healing rather than a one-off cleanup — the
 * invisible population shrinks by however many people a run touches.
 */
import test from 'node:test';
import assert from 'node:assert';
import { planAccount, syntheticEmail, MEMBER_ID_PROP, CONNECTIONS_PROP } from '../../src/connections/magellan.js';

const ACCOUNT = 'pat.yanguas@ortus.solutions';
const person = { memberId: '2723390', firstName: 'Dawn', lastName: 'Maloney', slug: 'dawnmaloney' };

test('without the fallback the shell is a create — the one HubSpot rejects', () => {
  const plan = planAccount([person], ACCOUNT, () => null);
  assert.equal(plan.creates.length, 1);
  assert.equal(plan.creates[0].properties.email, syntheticEmail('2723390'),
    'and this is the address the invisible record already holds, hence the 409');
});

test('a recovered shell becomes an update that backfills the member id', () => {
  // What the email fallback now returns: the shell, holding the synthetic
  // address, with linkedin_membership_id blank — the reason it was invisible.
  const shell = { id: 'c9', properties: { email: syntheticEmail('2723390') } };
  const plan = planAccount([person], ACCOUNT, () => shell);

  assert.equal(plan.creates.length, 0, 'no create means no 409');
  assert.equal(plan.updates.length, 1);
  const props = plan.updates[0].properties;
  assert.equal(props[MEMBER_ID_PROP], '2723390', 'the repair: it will be visible to the first pass next time');
  assert.equal(props[CONNECTIONS_PROP], `;${ACCOUNT}`, 'and the connection finally lands');
});

test('the repair is a one-time cost — a repaired record asks for nothing more', () => {
  const repaired = {
    id: 'c9',
    properties: {
      email: syntheticEmail('2723390'),
      [MEMBER_ID_PROP]: '2723390',
      [CONNECTIONS_PROP]: `;${ACCOUNT}`,
      firstname: 'Dawn',
      lastname: 'Maloney',
    },
  };
  const plan = planAccount([person], ACCOUNT, () => repaired);
  assert.equal(plan.updates.length, 0, 'nothing left to say, so no call at all');
});

test('the connection is appended, never replacing what the record already had', () => {
  const shell = {
    id: 'c9',
    properties: { email: syntheticEmail('2723390'), [CONNECTIONS_PROP]: ';someone.else@ortus.solutions' },
  };
  const plan = planAccount([person], ACCOUNT, () => shell);
  assert.equal(plan.updates[0].properties[CONNECTIONS_PROP],
    `;someone.else@ortus.solutions;${ACCOUNT}`);
});
