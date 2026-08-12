import test from 'node:test';
import assert from 'node:assert/strict';
import { explainProblem, problemLine, summariseProblems } from '../../src/connections/magellan-problems.js';

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
  // Biggest first — that is the job worth doing.
  assert.equal(out[0].code, 'duplicate_contact');
  assert.equal(out[0].count, 3);
  assert.deepEqual(out[0].accounts.sort(), ['a@o.com', 'b@o.com']);
  assert.equal(out[1].code, 'rate_limited');
  assert.equal(out[1].count, 1);
});

test('no errors means no roll-up', () => {
  assert.deepEqual(summariseProblems([]), []);
  assert.deepEqual(summariseProblems(undefined), []);
});
