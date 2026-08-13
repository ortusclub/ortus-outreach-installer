import test from 'node:test';
import assert from 'node:assert/strict';
import { explainProblem, peopleLost, problemLine, summariseProblems } from '../../src/connections/magellan-problems.js';

// The real one, copied from the log of the 11 Aug run.
const REAL_409 = 'HubSpot 409: {"status":"error","message":"Email 444725921@linkedinmembership.id '
  + 'is associated with a different vid 33062650786","correlationId":"019ff0e9-aca7"}';

test('the duplicate-contact refusal names the other record and what to do with it', () => {
  const p = explainProblem(REAL_409, { stage: 'email' });
  assert.equal(p.code, 'duplicate_contact');
  assert.equal(p.what, 'This person is in HubSpot twice');
  // The vid is the whole point — without it nobody can find the other record.
  assert.match(p.why, /33062650786/);
  assert.match(p.fix, /33062650786/);
  assert.match(p.fix, /merge/i);
  // And it must say the connection still landed, or this reads as lost data.
  assert.match(p.fix, /connection has been recorded/i);
});

test('every failure carries HubSpot\'s own words, unedited', () => {
  for (const raw of [REAL_409, 'HubSpot 429: too many requests', 'HubSpot 403: scopes', 'weird new thing']) {
    assert.equal(explainProblem(raw).raw, raw);
    assert.match(problemLine('a@o.com', explainProblem(raw)), /\[.+\]$/);
  }
});

test('an unrecognised failure says so rather than inventing a cause', () => {
  const p = explainProblem('HubSpot 418: I am a teapot');
  assert.equal(p.code, 'unknown');
  assert.match(p.why, /not a failure we recognise/i);
  assert.match(p.fix, /Antonio/);
});

test('each kind of failure is told apart', () => {
  const cases = [
    ['HubSpot 429: rate limit exceeded', 'rate_limited'],
    ['HubSpot 403: This app hasn\'t been granted all required scopes', 'not_allowed'],
    ['HubSpot 401: unauthorized', 'bad_key'],
    ['HubSpot 502: bad gateway', 'hubspot_down'],
    ['HubSpot 400: value is not one of the allowed options', 'not_an_option'],
    ['HubSpot 409: already has that email', 'email_taken'],
  ];
  for (const [raw, code] of cases) assert.equal(explainProblem(raw).code, code, raw);
});

test('a duplicate is not mistaken for a plain email clash — the specific rule wins', () => {
  // Both rules match a 409; the one that can name the other record must win,
  // or the fix loses the only detail that makes it actionable.
  assert.equal(explainProblem(REAL_409).code, 'duplicate_contact');
});

test('the roll-up groups by cause and counts, rather than repeating itself', () => {
  const errors = [
    { account: 'a@o.com', stage: 'email', error: REAL_409 },
    { account: 'a@o.com', stage: 'email', error: REAL_409 },
    { account: 'b@o.com', stage: 'email', error: REAL_409 },
    { account: 'b@o.com', stage: 'update', error: 'HubSpot 429: rate limit' },
  ];
  const out = summariseProblems(errors);
  assert.equal(out.length, 2);
  // Worst first, and "worst" is people lost — not lines printed. The single
  // rate-limited update cost somebody; the three duplicate clashes cost nobody,
  // because the connection is already on the record with the real address.
  assert.equal(out[0].code, 'rate_limited');
  assert.equal(out[0].people, 1);
  assert.equal(out[0].blocking, true);
  const dupes = out.find((g) => g.code === 'duplicate_contact');
  assert.equal(dupes.count, 3);
  assert.equal(dupes.people, 0);
  assert.equal(dupes.blocking, false);
  assert.deepEqual(dupes.accounts.sort(), ['a@o.com', 'b@o.com']);
});

test('a rejected batch is counted in PEOPLE, not in lines', () => {
  // The bug this exists to prevent: one 400 on a batch of 61 was reported as
  // "1 problem" beside "168 added", and read like a clean run. It was 61 people
  // that never reached HubSpot.
  const out = summariseProblems([
    { account: 'a@o.com', stage: 'update', size: 61, error: 'HubSpot 400: not one of the allowed options' },
    { account: 'a@o.com', stage: 'email', error: 'HubSpot 409: associated with a different vid 33062030850' },
  ]);
  assert.equal(out[0].code, 'not_an_option');
  assert.equal(out[0].count, 1);
  assert.equal(out[0].people, 61);
  assert.equal(out[1].people, 0);
});

test('peopleLost: batches cost their size, email clashes cost nobody', () => {
  assert.equal(peopleLost({ stage: 'update', size: 61 }), 61);
  assert.equal(peopleLost({ stage: 'create', size: 100 }), 100);
  assert.equal(peopleLost({ stage: 'email', id: '900' }), 0);
  // An unrecognised failure with no size is one person, never zero — the whole
  // point of this module is that it must not understate the damage.
  assert.equal(peopleLost({ stage: 'update' }), 1);
  assert.equal(peopleLost(), 1);
});

test('the line leads with the cost when there is one', () => {
  const p = explainProblem('HubSpot 400: not one of the allowed options', { stage: 'update' });
  const line = problemLine('a@o.com', p, { people: 61, count: 1 });
  assert.match(line, /61 people NOT written/);
  // Nothing lost: the old per-account tally, unchanged.
  const dupe = explainProblem(REAL_409, { stage: 'email' });
  assert.match(problemLine('a@o.com', dupe, { people: 0, count: 30 }), /\(30 people in this account\)/);
  assert.doesNotMatch(problemLine('a@o.com', dupe, { people: 0, count: 30 }), /NOT written/);
});

test('no errors means no roll-up', () => {
  assert.deepEqual(summariseProblems([]), []);
  assert.deepEqual(summariseProblems(undefined), []);
});
