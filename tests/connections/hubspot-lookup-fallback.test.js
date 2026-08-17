/**
 * lookupByMemberIds' second pass — finding the records the old manual process
 * left with a synthetic email and no linkedin_membership_id.
 *
 * Those records are why Abygael's 17 Aug run wrote nothing: invisible to the
 * member-id search, planned as creates, then rejected because the synthetic
 * address they hold is the same one the create tries to write.
 */
import test from 'node:test';
import assert from 'node:assert';
import { lookupByMemberIds } from '../../src/connections/hubspot-client.js';
import { syntheticEmail } from '../../src/connections/magellan.js';

const TOKEN = 'test-token';

/**
 * A fake portal. `byMemberId` answers the first pass, `byEmail` the second, so
 * a test can make a record visible to exactly one of them.
 */
function portal({ byMemberId = {}, byEmail = {} } = {}) {
  const calls = { memberId: 0, email: 0, emailValues: [] };
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const filter = body.filterGroups[0].filters[0];
    let results = [];
    if (filter.propertyName === 'linkedin_membership_id') {
      calls.memberId += 1;
      results = filter.values.flatMap((v) => byMemberId[v] || []);
    } else if (filter.propertyName === 'email') {
      calls.email += 1;
      calls.emailValues.push(...filter.values);
      results = filter.values.flatMap((v) => byEmail[v] || []);
    }
    return { ok: true, json: async () => ({ results }) };
  };
  return { fetchImpl, calls };
}

const shell = (id, memberId, extra = {}) => ({
  id,
  properties: { email: syntheticEmail(memberId), firstname: 'Dawn', lastname: 'Maloney', ...extra },
});

test('a record with the member id set is found by the first pass, no email search needed', async () => {
  const p = portal({ byMemberId: { 111: [shell('c1', 111, { linkedin_membership_id: '111', email: 'dawn@real.com' })] } });
  const out = await lookupByMemberIds(['111'], { fetchImpl: p.fetchImpl, token: TOKEN });
  assert.equal(out.get('111').id, 'c1');
  assert.equal(p.calls.email, 0, 'nothing was missing, so the second pass must not run');
});

test('a synthetic shell with NO member id is recovered by the email fallback', async () => {
  const p = portal({ byEmail: { [syntheticEmail('222')]: [shell('c2', 222)] } });
  const out = await lookupByMemberIds(['222'], { fetchImpl: p.fetchImpl, token: TOKEN });
  assert.equal(out.get('222').id, 'c2', 'this is the contact the create was colliding with');
  assert.equal(p.calls.email, 1);
});

test('the fallback searches the synthetic address, lowercased', async () => {
  const p = portal({});
  await lookupByMemberIds(['333'], { fetchImpl: p.fetchImpl, token: TOKEN });
  assert.deepEqual(p.calls.emailValues, ['333@linkedinmembership.id']);
});

test('a member-id hit is never overwritten by a synthetic shell', async () => {
  // Both exist. The human-maintained record must win — writing the connection
  // to the shell instead would put it on the record nobody opens.
  const p = portal({
    byMemberId: { 444: [{ id: 'real', properties: { email: 'dawn@real.com', linkedin_membership_id: '444' } }] },
    byEmail: { [syntheticEmail('444')]: [shell('shell', 444)] },
  });
  const out = await lookupByMemberIds(['444'], { fetchImpl: p.fetchImpl, token: TOKEN });
  assert.equal(out.get('444').id, 'real');
  assert.equal(p.calls.email, 0, 'it was not missing, so it is never asked about by email');
});

test('a genuinely new person is still absent, so it is still planned as a create', async () => {
  const p = portal({});
  const out = await lookupByMemberIds(['555'], { fetchImpl: p.fetchImpl, token: TOKEN });
  assert.equal(out.has('555'), false);
});

test('an unrelated contact returned by the email search is ignored', async () => {
  // Defensive: only a row whose email is one we actually asked for may be
  // mapped back to a member id.
  const p = portal({ byEmail: { [syntheticEmail('666')]: [{ id: 'x', properties: { email: 'someone@else.com' } }] } });
  const out = await lookupByMemberIds(['666'], { fetchImpl: p.fetchImpl, token: TOKEN });
  assert.equal(out.has('666'), false);
});

test('mixed batch: found, recovered and new are each sorted correctly', async () => {
  const p = portal({
    byMemberId: { 1: [{ id: 'a', properties: { email: 'a@real.com', linkedin_membership_id: '1' } }] },
    byEmail: { [syntheticEmail('2')]: [shell('b', 2)] },
  });
  const out = await lookupByMemberIds(['1', '2', '3'], { fetchImpl: p.fetchImpl, token: TOKEN });
  assert.equal(out.get('1').id, 'a');
  assert.equal(out.get('2').id, 'b');
  assert.equal(out.has('3'), false);
  assert.deepEqual(p.calls.emailValues, ['2@linkedinmembership.id', '3@linkedinmembership.id'],
    'only the ids the first pass missed are asked about by email');
});
