import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accountsRows, logRows, importRows, planRows, planBanner, connectionsRowsForAccount, tabNameFor,
  publish, resetPublished, setPlanVerdicts, resetPlanVerdicts,
  CONNECTIONS_HEADER, ACCOUNTS_TAB, LOG_TAB, IMPORT_TAB, PLAN_TAB,
} from '../../src/connections/magellan-sheet.js';
import { diagnose } from '../../src/connections/magellan-diagnose.js';
import { createProperties, CONNECTIONS_PROP } from '../../src/connections/magellan.js';

// The layout is Abygael's cleaned sheet, so the columns are a contract.
test('the connections tab has exactly the cleaned-sheet columns, in order', () => {
  assert.deepEqual(CONNECTIONS_HEADER, ['LinkedIn Membership ID', 'Location', 'First Name',
    'Last Name', 'LinkedIn Bio', 'Company Name', 'Job Title', 'Email',
    'Linkedin First Connections', 'HubSpot Link']);
});

test('a connection becomes a cleaned-sheet row, keyed by the synthetic email', () => {
  const rows = connectionsRowsForAccount('karl@ortus.solutions', [
    { memberId: '14258192', firstName: 'Anand', lastName: 'Choudha', slug: 'anand-choudha',
      company: 'Hive Pro Inc', jobTitle: 'CEO and Founder' },
  ]);
  assert.deepEqual(rows[0], ['14258192', '', 'Anand', 'Choudha',
    'https://www.linkedin.com/in/anand-choudha', 'Hive Pro Inc', 'CEO and Founder',
    '14258192@linkedinmembership.id', ';karl@ortus.solutions',
    '']);   // no import has run for this person yet, so nothing to link to
});

test('a connection with a location fills the Location column (index 1)', () => {
  const [row] = connectionsRowsForAccount('karl@ortus.solutions', [
    { memberId: '14258192', firstName: 'Anand', slug: 'anand-choudha', location: 'New York, New York, United States' },
  ]);
  assert.equal(row[1], 'New York, New York, United States', 'Location sits in the second column, per CONNECTIONS_HEADER');
});

// The leading ';' is what makes a CSV import APPEND to the multi-value property
// instead of replacing it. Without it the import wipes every other Ortus account
// already on that contact — reported by Abygael, 17 Aug 2026.
test('the connections column carries the leading semicolon the CSV import needs', () => {
  const rows = connectionsRowsForAccount('pat.yanguas@ortus.solutions', [
    { memberId: '2723390', firstName: 'Dawn', lastName: 'Maloney', slug: 'dawnmaloney' },
  ]);
  assert.equal(rows[0][8], ';pat.yanguas@ortus.solutions');
});

// Same format on both routes. They drifted once already.
test('the sheet column and the API property agree on the format', () => {
  const [row] = connectionsRowsForAccount('Karl@Ortus.Solutions ', [{ memberId: '7', slug: 'x' }]);
  assert.equal(row[8], createProperties({ memberId: '7' }, 'Karl@Ortus.Solutions ')[CONNECTIONS_PROP]);
  assert.equal(row[8], ';karl@ortus.solutions', 'trimmed and lowercased, like the property options');
});

// No member id means no HubSpot key — a half-row would just be noise.
test('people without a member id are left out', () => {
  const rows = connectionsRowsForAccount('a@o.com', [
    { memberId: '', firstName: 'Hidden', slug: '' },
    { memberId: '7', firstName: 'Real', slug: 'real' },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0][2], 'Real');
});

test('a tab is named after the account, with the characters Sheets rejects swapped out', () => {
  assert.equal(tabNameFor('nikki@ortus.solutions'), 'nikki@ortus.solutions');
  assert.equal(tabNameFor('a/b[c]*d?e:f'), 'a-b-c--d-e-f');
});

test('a failed account carries its cause and its fix, not a stack trace', () => {
  const rows = accountsRows({
    perAccount: [{ account: 'a@o.com', error: 'Cr24', diagnosis: diagnose('Cr24') }],
  });
  assert.equal(rows[0][1], 'Failed');
  assert.match(rows[0][6], /never opened/);
  assert.match(rows[0][7], /extensions cache/i);
});

test('a collected account carries its counts', () => {
  const rows = accountsRows({
    perAccount: [{ account: 'a@o.com', total: 1259, withMemberId: 1241, hidden: 18, collectedAt: 'T' }],
  });
  assert.deepEqual(rows[0], ['a@o.com', 'Collected', '1259', '1241', '18', 'T', '', '']);
});

// The whole point of the tab: a 7,000-connection account must not look idle.
test('the account being read right now shows its live count', () => {
  const rows = accountsRows({
    running: true, perAccount: [],
    current: { account: 'nikki@o.com', count: 1240, pages: 31, total: 7213 },
  });
  assert.equal(rows[0][1], 'Reading now');
  assert.equal(rows[0][2], '1240');
  assert.match(rows[0][6], /page 31 of about 7213/);
});

test('the live row disappears once the account has landed', () => {
  const rows = accountsRows({
    running: true,
    perAccount: [{ account: 'a@o.com', total: 7, withMemberId: 7, hidden: 0 }],
    current: { account: 'a@o.com', count: 7, pages: 1 },
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0][1], 'Collected');
});

test('log lines split into time and event', () => {
  const rows = logRows({ log: ['[2026-08-10T10:00:00.000Z] ▶ Collecting 2 accounts.', 'no timestamp'] });
  assert.deepEqual(rows[0], ['2026-08-10T10:00:00.000Z', '▶ Collecting 2 accounts.']);
  assert.deepEqual(rows[1], ['', 'no timestamp']);
});

test('import rows are per account, with the first errors spelled out', () => {
  const rows = importRows({
    perAccount: [{ account: 'a@o.com', created: 10, updated: 2, extraEmails: 1, errors: [{ stage: 'create', error: 'boom' }] }],
  });
  assert.deepEqual(rows[0].slice(0, 5), ['a@o.com', '10', '2', '1', '1']);
  assert.equal(rows[0][5], 'create: boom');
});

test('no import yet means no import tab', () => {
  assert.deepEqual(importRows(null), []);
});

// Collect Nikki, Antonio and Milee and you get three tabs, one per email.
test('every collected account gets its own tab, named after it', async () => {
  resetPublished();
  const calls = [];
  const r = await publish(
    { perAccount: [{ account: 'nikki@o.com' }, { account: 'antonio@o.com' }, { account: 'bad@o.com', error: 'Cr24' }], log: [] },
    {
      read: () => [{ memberId: '1', firstName: 'A', slug: 's' }],
      write: async (tab) => { calls.push(tab); return { url: 'https://sheet' }; },
    },
  );
  assert.equal(r.written, true);
  assert.equal(r.url, 'https://sheet');
  assert.deepEqual(calls, [ACCOUNTS_TAB, LOG_TAB, 'nikki@o.com', 'antonio@o.com']);
});

// A 300-account sweep publishes after every account; resending all 300 tabs
// each time would take longer than the collection itself.
test('an account tab is not rewritten when its numbers have not changed', async () => {
  resetPublished();
  const state = { perAccount: [{ account: 'a@o.com' }], log: [] };
  const deps = { read: () => [{ memberId: '1', slug: 's' }] };
  const first = [];
  await publish(state, { ...deps, write: async (tab) => first.push(tab) });
  const second = [];
  await publish(state, { ...deps, write: async (tab) => second.push(tab) });
  assert.ok(first.includes('a@o.com'));
  assert.deepEqual(second, [ACCOUNTS_TAB, LOG_TAB], 'only the run tabs were refreshed');
});

test('publish adds the import tab once an import has run', async () => {
  resetPublished();
  const calls = [];
  await publish(
    { perAccount: [], log: [], imported: { perAccount: [{ account: 'a@o.com', created: 1 }] } },
    { read: () => [], write: async (tab) => calls.push(tab) },
  );
  assert.deepEqual(calls, [ACCOUNTS_TAB, LOG_TAB, IMPORT_TAB]);
});

// A dead sheet must never stop a sweep.
test('a Google failure is reported, not thrown', async () => {
  const r = await publish({ perAccount: [], log: [] }, {
    read: () => [], write: async () => { throw new Error('Timeout di blocco'); },
  });
  assert.equal(r.written, false);
  assert.match(r.error, /Timeout di blocco/);
});

test('a second publish is skipped while the first is still in flight', async () => {
  let release;
  const gate = new Promise((res) => { release = res; });
  const first = publish({ perAccount: [], log: [] }, { read: () => [], write: () => gate });
  const second = await publish({ perAccount: [], log: [] }, { read: () => [], write: async () => {} });
  assert.equal(second.written, false);
  assert.match(second.skipped, /already in flight/);
  release();
  await first;
});

// The verdict — already in HubSpot or not — comes from a Map keyed by member
// id, not from anything stamped on the row. readForPlan rebuilds its rows
// from disk on every call, so a stamped field would never survive a second
// read; the Map is what every publish() caller, not just Check, can share.
test('the Plan tab says, per person, what Import would do', () => {
  const verdicts = new Map([['222', '900']]);   // 111: new (absent), 222: already there
  const rows = planRows({
    preview: {
      accounts: ['a@o.com'],
      totals: { created: 1, updated: 1, hidden: 1 },
    },
  }, () => ([
    { memberId: '111', firstName: 'New', lastName: 'Person', slug: 'new-person' },
    { memberId: '222', firstName: 'Known', lastName: 'Person', slug: 'known-person' },
    { memberId: '', firstName: '', lastName: '', slug: '' },
  ]), verdicts);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0].slice(0, 3), ['a@o.com', 'New', 'Person']);
  assert.equal(rows[0][4], 'Will be added');
  assert.equal(rows[1][4], 'Already in HubSpot — we note the connection, nothing else changes');
  assert.equal(rows[2][4], 'Hidden by LinkedIn — nothing we can do');
});

// F4: a row with a memberId but an empty slug used to render
// "https://www.linkedin.com/in/" with nothing after it — a link to nowhere,
// visible to the non-technical reviewer this tab exists for.
test('a resolved person with no slug gets a blank link, not a dangling URL', () => {
  const rows = planRows({
    preview: { accounts: ['a@o.com'] },
  }, () => ([
    { memberId: '5', firstName: 'No', lastName: 'Slug', slug: '' },
  ]), new Map());
  assert.equal(rows[0][3], '', 'no slug means no URL, never "https://www.linkedin.com/in/"');
});

test('planRows is empty when Check has not run', () => {
  assert.deepEqual(planRows({}, () => []), []);
});

// A row with a slug but no member id is NOT hidden — magellan.js's isHidden
// requires both to be missing. planAccount buckets these as "unresolved" and
// retries them on the next collection; the tab has to say that, not claim
// LinkedIn hid them.
test('a person with a link but no LinkedIn ID yet is unresolved, not hidden', () => {
  const rows = planRows({
    preview: { accounts: ['a@o.com'] },
  }, () => ([
    { memberId: '', firstName: 'Not', lastName: 'Yet', slug: 'not-yet' },
  ]), new Map());
  assert.equal(rows[0][4], 'Not collected yet — no LinkedIn ID, we retry next collection');
  assert.equal(rows[0][3], 'https://www.linkedin.com/in/not-yet', 'the link is still shown — we do know who they are');
});

// planAccount collapses repeat member ids so only one write is issued;
// planRows has to agree, or the tab counts someone twice for a ledger that
// counted them once.
test('the same member id twice in one export becomes one row', () => {
  const rows = planRows({
    preview: { accounts: ['a@o.com'] },
  }, () => ([
    { memberId: '1', firstName: 'A', lastName: 'One', slug: 'a-one' },
    { memberId: '1', firstName: 'A', lastName: 'One', slug: 'a-one' },
  ]), new Map());
  assert.equal(rows.length, 1);
});

// The bar from the review: the tab's rows have to reconcile with the three
// numbers the card shows (new / already there / hidden), with the arithmetic
// spelled out, not just "close enough".
test('Plan tab counts reconcile with the ledger the card shows', () => {
  const verdicts = new Map([['2', '900'], ['4', '901']]);   // 2 and 4 already in HubSpot
  const read = () => ([
    { memberId: '1', firstName: 'New', lastName: 'One', slug: 's1' },      // → will be added
    { memberId: '2', firstName: 'Old', lastName: 'One', slug: 's2' },      // → already there
    { memberId: '3', firstName: 'New', lastName: 'Two', slug: 's3' },      // → will be added
    { memberId: '4', firstName: 'Old', lastName: 'Two', slug: 's4' },      // → already there
    { memberId: '', firstName: '', lastName: '', slug: '' },               // → hidden
    { memberId: '', firstName: 'Soon', lastName: '', slug: 's5' },         // → unresolved (not on the ledger)
  ]);
  const rows = planRows({ preview: { accounts: ['a@o.com'] } }, read, verdicts);

  const willBeAdded = rows.filter((r) => r[4] === 'Will be added').length;
  const alreadyThere = rows.filter((r) => r[4].startsWith('Already in HubSpot')).length;
  const hidden = rows.filter((r) => r[4].startsWith('Hidden by LinkedIn')).length;
  const unresolved = rows.filter((r) => r[4].startsWith('Not collected yet')).length;

  // The three numbers on the card's ledger — created, updated, hidden — sum
  // exactly to willBeAdded + alreadyThere + hidden. Unresolved people have no
  // pill on the card at all (they are not a HubSpot outcome, they are a
  // "we don't know yet"), so they are the one bucket the ledger's three
  // numbers don't have to account for.
  assert.equal(willBeAdded, 2);
  assert.equal(alreadyThere, 2);
  assert.equal(hidden, 1);
  assert.equal(unresolved, 1);
  assert.equal(rows.length, willBeAdded + alreadyThere + hidden + unresolved);
});

// The CRITICAL bug: only buildPreview's own publish() call used to know the
// verdicts. Collect, merge and import all call publish() too, with no
// override — setPlanVerdicts is what lets them agree.
test('a publish() call with no override still sees the verdicts Check found', async () => {
  resetPublished();
  setPlanVerdicts(new Map([['1', '900']]));   // member 1 is already in HubSpot
  const calls = [];
  await publish(
    {
      perAccount: [],
      log: [],
      preview: { accounts: ['a@o.com'] },
    },
    {
      // No `read` override, no verdicts passed — exactly what collect's
      // toSheet(), mergeDuplicates() and runImport() actually call with.
      read: () => [{ memberId: '1', firstName: 'Old', lastName: 'One', slug: 's1' }],
      write: async (tab, header, rows) => { calls.push({ tab, rows }); return { url: 'https://sheet' }; },
    },
  );
  const planCall = calls.find((c) => c.tab === PLAN_TAB);
  assert.ok(planCall, 'the Plan tab was written');
  // Row 0 is the provenance banner (see the planBanner tests below); the
  // person rows start at row 1.
  assert.equal(planCall.rows[1][4], 'Already in HubSpot — we note the connection, nothing else changes');
  resetPlanVerdicts();
});

// F2: the Plan tab is the only artifact a non-technical reviewer can open
// without the app running, and it can go stale two different ways (see the
// comment on planBanner). Neither is suppressed — the banner just makes the
// tab's age and coverage impossible to miss.
test('planBanner says when the plan was built and what it covers', () => {
  const row = planBanner({ preview: { builtAt: '2026-08-11T14:30:00.000Z', accounts: ['a@o.com', 'b@o.com'] } });
  assert.equal(row.length, 5, 'padded to the Plan tab\'s column width');
  assert.match(row[0], /built/i);
  assert.match(row[0], /2 accounts/);
});

test('planBanner does not crash or invent a date when there is no preview yet', () => {
  const row = planBanner({});
  assert.match(row[0], /unknown time/);
  assert.match(row[0], /0 accounts/);
});

// runImport sets state.imported before it re-publishes, so the banner can
// stop hedging on a timestamp and just say an import already happened.
test('planBanner says an import already ran once state.imported is set', () => {
  const row = planBanner({
    preview: { builtAt: '2026-08-11T14:30:00.000Z', accounts: ['a@o.com', 'b@o.com'] },
    imported: { created: 2, updated: 0, at: '2026-08-11T15:00:00.000Z' },
  });
  assert.match(row[0], /built/i);
  assert.match(row[0], /2 accounts/);
  assert.match(row[0], /import has already run/i);
  assert.doesNotMatch(row[0], /may no longer be accurate/);
});

test('the banner rides in front of the plan rows a publish() write actually sends', async () => {
  resetPublished();
  const calls = [];
  await publish(
    {
      perAccount: [], log: [],
      preview: { accounts: ['a@o.com'], builtAt: '2026-08-11T09:00:00.000Z' },
    },
    {
      read: () => [{ memberId: '1', firstName: 'A', lastName: 'One', slug: 's1' }],
      write: async (tab, header, rows) => { calls.push({ tab, rows }); return { url: 'https://sheet' }; },
    },
  );
  const planCall = calls.find((c) => c.tab === PLAN_TAB);
  assert.match(planCall.rows[0][0], /built/i, 'row 0 is the banner, not a person');
  assert.equal(planCall.rows[1][2], 'One', 'row 1 onward is the actual plan');
});

test('resetPlanVerdicts clears what Check found — a fresh sweep starts unknown', () => {
  setPlanVerdicts(new Map([['1', '900']]));
  resetPlanVerdicts();
  const rows = planRows({ preview: { accounts: ['a@o.com'] } },
    () => [{ memberId: '1', firstName: 'A', lastName: 'B', slug: 's1' }]);
  // With no verdicts at all, nothing is known to already exist — the safer
  // default reads as "will be added", not a false "already there".
  assert.equal(rows[0][4], 'Will be added');
});
