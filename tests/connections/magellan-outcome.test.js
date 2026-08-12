import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOutcome } from '../../src/connections/magellan-outcome.js';

test('a finished check says what it found', () => {
  const o = buildOutcome({
    phase: 'done', done: 12, total: 12,
    preview: {
      totals: { created: 9623, updated: 15545 },
      accounts: ['a@o.com'],
      blocked: [],
      duplicates: [],
    },
  });
  assert.equal(o.ok, true);
  assert.equal(o.summary, '9,623 new · 15,545 already there');
  assert.deepEqual(o.problems, []);
});

test('duplicates are reported as a fact, never as a job to do', () => {
  const o = buildOutcome({
    phase: 'done', done: 12, total: 12,
    preview: {
      totals: { created: 1, updated: 2 },
      accounts: ['a@o.com'],
      blocked: [],
      duplicates: new Array(3727).fill({ memberId: 'x' }),
    },
  });
  assert.equal(o.ok, true);
  assert.match(o.problems[0], /^3,727 people are in HubSpot more than once/);
  assert.match(o.problems[0], /nothing was missed/);
  assert.doesNotMatch(o.problems[0], /merge/i);
});

test('a blocked account is named, not counted', () => {
  const o = buildOutcome({
    phase: 'done', done: 11, total: 11,
    preview: {
      totals: { created: 1, updated: 2 },
      accounts: ['ines@ortusclub.com'],
      blocked: ['jemely.butron@ortus.solutions'],
      duplicates: [],
    },
  });
  assert.match(o.problems[0], /jemely\.butron@ortus\.solutions/);
  assert.match(o.problems[0], /isn’t on the HubSpot list yet/);
});

test('a finished collect counts people and LinkedIn IDs', () => {
  const o = buildOutcome({
    phase: 'done', done: 12, total: 12,
    perAccount: [
      { account: 'a@o.com', total: 20000, withMemberId: 8000 },
      { account: 'b@o.com', total: 4607, withMemberId: 1102 },
    ],
  });
  assert.equal(o.ok, true);
  assert.equal(o.summary, '24,607 people from 2 accounts · 9,102 with a LinkedIn ID');
});

test('a finished import counts what it wrote', () => {
  const o = buildOutcome({
    phase: 'done', done: 12, total: 12,
    imported: { created: 4102, updated: 20505, problems: [] },
  });
  assert.equal(o.ok, true);
  assert.equal(o.summary, '4,102 added · 20,505 updated');
});

test('import problems come through grouped, with what to do', () => {
  const o = buildOutcome({
    phase: 'done', done: 1, total: 1,
    imported: {
      created: 1, updated: 0,
      problems: [{ code: 'duplicate_contact', what: 'HubSpot already has this person twice', fix: 'Nothing to do — recorded on the other record', count: 61, accounts: ['a@o.com'] }],
    },
  });
  assert.equal(o.problems[0], '61 × HubSpot already has this person twice — Nothing to do — recorded on the other record');
});

test('a stopped run says how far it got BEFORE it states any total', () => {
  const o = buildOutcome({
    phase: 'stopped', stopped: true, done: 7, total: 12,
    perAccount: [{ account: 'a@o.com', total: 100, withMemberId: 50 }],
  });
  assert.equal(o.ok, false);
  assert.match(o.summary, /^Stopped after 7 of 12 accounts/);
  assert.match(o.summary, /the rest weren’t asked about/);
});

test('an errored run reports the error and nothing else', () => {
  const o = buildOutcome({
    phase: 'error', error: 'HubSpot 401: token expired', done: 3, total: 12,
  });
  assert.equal(o.ok, false);
  assert.equal(o.summary, 'HubSpot 401: token expired');
});

test('a collect that lost accounts groups the failures by cause', () => {
  const o = buildOutcome({
    phase: 'done', done: 2, total: 2,
    perAccount: [
      { account: 'a@o.com', total: 10, withMemberId: 10 },
      { account: 'b@o.com', error: 'boom', diagnosis: { code: 'logged_out', what: 'The account is logged out of LinkedIn', fix: 'Log it back in and collect again' } },
    ],
  });
  assert.equal(o.problems[0], '1 × The account is logged out of LinkedIn — Log it back in and collect again');
});

test('an idle run has no outcome at all', () => {
  assert.equal(buildOutcome({ phase: 'idle' }), null);
  assert.equal(buildOutcome({ phase: 'checking', running: true }), null);
});

// Operator screenshot 2026-08-12: "0 new · 0 already there" as the headline of a
// Check that never opened a single file, because all four accounts were skipped.
// That reads as "we looked, they're all known" — the opposite of the truth.
test('a Check with nothing it may look at says so, instead of reporting zeros', () => {
  const o = buildOutcome({
    phase: 'done', done: 0, total: 0,
    preview: {
      totals: { created: 0, updated: 0 },
      accounts: [],
      blocked: ['a@o.com', 'b@o.com', 'c@o.com', 'd@o.com'],
      duplicates: [],
    },
  });
  assert.equal(o.ok, false, 'a Check that examined nothing is not a success');
  assert.equal(o.summary,
    'Nothing was checked — none of the 4 accounts you picked is on the HubSpot list yet');
  assert.doesNotMatch(o.summary, /already there/);
  assert.match(o.problems.join(' '), /a@o\.com/, 'the skipped accounts are still named');
});

test('one usable account is still a real Check', () => {
  const o = buildOutcome({
    phase: 'done', done: 1, total: 1,
    preview: {
      totals: { created: 5, updated: 3 },
      accounts: ['a@o.com'],
      blocked: ['b@o.com'],
      duplicates: [],
    },
  });
  assert.equal(o.ok, true);
  assert.equal(o.summary, '5 new · 3 already there');
  assert.match(o.problems.join(' '), /1 account skipped: b@o\.com/);
});

test('a Check with no accounts picked at all says that, not zeros', () => {
  const o = buildOutcome({
    phase: 'done', done: 0, total: 0,
    preview: { totals: { created: 0, updated: 0 }, accounts: [], blocked: [], duplicates: [] },
  });
  assert.equal(o.ok, false);
  assert.equal(o.summary, 'Nothing was checked — no accounts were picked');
});
