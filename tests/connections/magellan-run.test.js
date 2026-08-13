import test from 'node:test';
import assert from 'node:assert/strict';
import {
  startCollect, stopCollect, buildPreview, runImport, mergeDuplicates, getState, getPlans, reset,
} from '../../src/connections/magellan-run.js';

const settle = () => new Promise((r) => setTimeout(r, 20));

// The sheet write is best-effort and lives behind the network; stub it so the
// unit tests never touch Google.
const noSheet = async () => ({ written: true });

function fakeSemaphore() {
  const s = { held: 0, peak: 0 };
  return {
    stats: s,
    async acquire() { s.held += 1; s.peak = Math.max(s.peak, s.held); },
    release() { s.held -= 1; },
  };
}

test('collect walks every account and always releases the browser slot', async () => {
  reset();
  const sem = fakeSemaphore();
  const closed = [];
  startCollect(
    [{ account: 'a@o.com', profileId: 'p1' }, { account: 'b@o.com', profileId: 'p2' }],
    {
      semaphore: sem,
      launchProfile: async () => ({ page: {} }),
      closeProfile: async (id) => { closed.push(id); },
      collect: async () => ({ total: 10, withMemberId: 9, hidden: 1 }),
      sheet: noSheet,
    },
  );
  await settle();
  const st = getState();
  assert.equal(st.done, 2);
  assert.equal(st.phase, 'done');
  assert.equal(sem.stats.held, 0, 'no leaked semaphore slot');
  assert.equal(sem.stats.peak, 1, 'one account at a time — campaigns keep their slots');
  assert.deepEqual(closed, ['p1', 'p2']);
});

// A blocked or logged-out account is normal at 300+ profiles.
test('one failing account does not abandon the rest of the sweep', async () => {
  reset();
  const sem = fakeSemaphore();
  let n = 0;
  startCollect(
    [{ account: 'bad@o.com', profileId: 'p1' }, { account: 'good@o.com', profileId: 'p2' }],
    {
      semaphore: sem,
      // Fails on every attempt, so the retry can't rescue it — the point here
      // is that the NEXT account still runs.
      launchProfile: async (id) => { n += 1; if (id === 'p1') throw new Error('LinkedIn is blocking this account'); return { page: {} }; },
      closeProfile: async () => {},
      collect: async () => ({ total: 5, withMemberId: 5, hidden: 0 }),
      sheet: noSheet,
    },
  );
  await settle();
  const st = getState();
  assert.equal(st.done, 2);
  assert.equal(st.perAccount[0].error, 'LinkedIn is blocking this account');
  assert.equal(st.perAccount[1].total, 5);
  assert.equal(sem.stats.held, 0);
});

test('a second collect is refused while one is running', async () => {
  reset();
  const slow = { async acquire() { await new Promise((r) => setTimeout(r, 40)); }, release() {} };
  startCollect([{ account: 'a@o.com', profileId: 'p1' }], {
    semaphore: slow,
    launchProfile: async () => ({ page: {} }),
    closeProfile: async () => {},
    collect: async () => ({ total: 1, withMemberId: 1, hidden: 0 }),
    sheet: noSheet,
  });
  const second = startCollect([{ account: 'b@o.com', profileId: 'p2' }], {});
  assert.equal(second.started, false);
  await new Promise((r) => setTimeout(r, 80));
});

test('collect refuses an empty selection', () => {
  reset();
  assert.equal(startCollect([], {}).started, false);
});

// Without the properties, creates would silently drop the member id and the
// connection — the two fields the whole exercise exists to write.
test('preview refuses to run when HubSpot lacks the properties', async () => {
  reset();
  await assert.rejects(
    () => buildPreview(['a@o.com'], {
      checkProps: async () => ({ ok: false, missing: ['linkedin_membership_id'] }),
      options: async () => new Set(['a@o.com']),
      read: () => [],
      lookup: async () => new Map(),
    }),
    /missing linkedin_membership_id/,
  );
});

test('preview totals up new vs existing across accounts, writing nothing', async () => {
  reset();
  const rows = {
    'a@o.com': [{ slug: 's1', memberId: '1', firstName: 'A' }, { slug: 's2', memberId: '2', firstName: 'B' }],
    'b@o.com': [{ slug: 's3', memberId: '3', firstName: 'C' }],
  };
  const { totals } = await buildPreview(['a@o.com', 'b@o.com'], {
    checkProps: async () => ({ ok: true, missing: [] }),
    options: async () => new Set(['a@o.com', 'b@o.com']),
    read: (acct) => rows[acct],
    lookup: async () => new Map([['2', { id: '900', properties: { email: 'real@x.com' } }]]),
    sheet: noSheet,
  });
  assert.equal(totals.created, 2);
  assert.equal(totals.updated, 1);
  assert.equal(totals.extraEmails, 1, 'existing contact gets the key as an extra address');
});

test('import reports per-stage errors instead of throwing them away', async () => {
  reset();
  const plans = [{
    account: 'a@o.com',
    plan: {
      creates: [{ properties: {} }],
      updates: [{ id: '1', properties: {} }],
      additionalEmails: [{ id: '900', email: 'x@linkedinmembership.id', asPrimary: false }],
    },
  }];
  const r = await runImport(plans, {
    create: async () => ({ created: 1, errors: [] }),
    update: async () => ({ updated: 1, errors: [{ size: 1, error: 'HubSpot 400' }] }),
    attach: async () => { throw new Error('secondary-email failed'); },
    sheet: noSheet,
  });
  assert.equal(r.ok, true);
  assert.equal(r.created, 1);
  assert.equal(r.updated, 1);
  assert.equal(r.extraEmails, 0);
  assert.deepEqual(r.errors.map((e) => e.stage), ['update', 'email']);
});

test('the import narrates itself — progress, per account, and why a problem happened', async () => {
  reset();
  const plans = [{
    account: 'a@o.com',
    plan: {
      creates: [{ properties: {} }],
      updates: [{ id: '1', properties: {} }],
      additionalEmails: [{ id: '900', email: 'x@linkedinmembership.id', asPrimary: false }],
    },
  }];
  await runImport(plans, {
    create: async () => ({ created: 1, errors: [] }),
    update: async () => ({ updated: 1, errors: [] }),
    attach: async () => { throw new Error('HubSpot 409: Contact already has that email'); },
    sheet: noSheet,
  });
  const s = getState();
  const log = s.log.join('\n');
  // The counters the card's progress bar reads.
  assert.equal(s.done, 1);
  assert.equal(s.total, 1);
  // The operator needs the account, the numbers, and the reason — a bare
  // "1 problems" pointing at an empty log is what this replaced.
  assert.match(log, /▶ Importing 1 account — 2 people/);
  // A failed secondary email costs nobody — the connection is already on the
  // record that holds the real address. It is a note, and calling it a problem
  // is what made one genuine 61-person loss look like the same kind of thing.
  assert.match(log, /✓ a@o\.com: 1 added, 1 updated, 1 note/);
  assert.doesNotMatch(log, /NOT written/);
  // Translated, not echoed: what happened, what to do, and HubSpot's own words
  // in brackets so a wrong explanation is visible rather than hidden.
  assert.match(log, /⚠ a@o\.com: That email address is already used by someone else/);
  assert.match(log, /merge them/);
  assert.match(log, /\[HubSpot 409: Contact already has that email\]/);
  assert.match(log, /■ Import finished\. 1 added, 1 updated\./);
  // The roll-up someone hands to whoever cleans HubSpot.
  assert.match(log, /· 1 × That email address is already used by someone else — nothing was lost/);
});

test('a rejected batch reports the people it cost, not the lines it printed', async () => {
  // The 13 Aug edlor run: 429 planned, 168 added + 200 updated, and a batch of
  // 61 updates refused by a property that had never been configured. The log
  // said "1 problem" and the card said "168 added · 200 updated". Both true;
  // together they read as a clean run that had in fact dropped 61 people.
  reset();
  const plans = [{
    account: 'edlor@o.com',
    plan: { creates: [{ properties: {} }], updates: [{ id: '1', properties: {} }], additionalEmails: [] },
  }];
  await runImport(plans, {
    create: async () => ({ created: 168, errors: [] }),
    update: async () => ({
      updated: 200,
      errors: [{ size: 61, error: 'HubSpot 400: jhengh@ortus.solutions was not one of the allowed options' }],
    }),
    attach: async () => {},
    sheet: noSheet,
  });
  const s = getState();
  const log = s.log.join('\n');
  assert.equal(s.imported.notWritten, 61);
  assert.match(log, /✓ edlor@o\.com: 168 added, 200 updated, 61 NOT written/);
  assert.match(log, /■ Import finished\. 168 added, 200 updated, 61 NOT written\./);
  // The roll-up leads with the cost and says the repeat run is safe.
  assert.match(log, /⚠ 61 people were not written/);
  assert.match(log, /⚠ 61 not written — This account is not on the "Linkedin 1st Connections" list/);
  // And the card says it in its headline, where it cannot be missed.
  assert.equal(s.outcome.ok, false);
  assert.match(s.outcome.summary, /168 added · 200 updated · 61 NOT written/);
  assert.match(s.outcome.problems[0], /61 people NOT written/);
});

const DUPES = [
  { account: 'a@o.com', memberId: '444725921', name: 'Alecx Bagatsolon', keptId: '192286279995', otherIds: ['33062650786'] },
  { account: 'a@o.com', memberId: '9895272', name: 'Rinky Rani', keptId: '230221683470', otherIds: ['1', '2'] },
];

test('merging folds every extra record into the one that is kept', async () => {
  reset();
  const calls = [];
  const r = await mergeDuplicates(DUPES, {
    merge: async (p) => { calls.push(p); return { id: p.primaryId, merged: p.mergeId }; },
    sheet: noSheet,
  });
  assert.equal(r.ok, true);
  // Three records folded away, not two: the second person had two spares.
  assert.equal(r.merged, 3);
  assert.deepEqual(calls, [
    { primaryId: '192286279995', mergeId: '33062650786' },
    { primaryId: '230221683470', mergeId: '1' },
    { primaryId: '230221683470', mergeId: '2' },
  ]);
});

test('the pairs are logged BEFORE the first merge — it cannot be undone', async () => {
  reset();
  // Sampled at the moment of the FIRST merge, not after the call returns —
  // reading the log at the end proves nothing about ordering, and the previous
  // version of this test passed with the logging loop moved below the merges.
  let logAtFirstMerge = null;
  await mergeDuplicates(DUPES, {
    merge: async () => {
      if (!logAtFirstMerge) logAtFirstMerge = [...getState().log];
      return {};
    },
    sheet: noSheet,
  });
  assert.ok(logAtFirstMerge, 'at least one merge ran');
  // Every pair was already named in the log when the first irreversible call
  // was made — so a crash mid-merge still leaves a record of what was touched.
  const listedBefore = logAtFirstMerge.filter((l) => /keeping .+, folding in/.test(l));
  assert.equal(listedBefore.length, DUPES.length);
  const log = getState().log;
  assert.match(log.join('\n'), /cannot be undone/i);
  assert.match(log.join('\n'), /Alecx Bagatsolon .*192286279995.*33062650786/);
});

test('one merge that fails does not abandon the rest, and says why', async () => {
  reset();
  const r = await mergeDuplicates(DUPES, {
    merge: async (p) => {
      if (p.mergeId === '33062650786') throw new Error('HubSpot 403: scopes');
      return {};
    },
    sheet: noSheet,
  });
  assert.equal(r.ok, true);
  assert.equal(r.merged, 2);
  assert.equal(r.errors.length, 1);
  assert.match(getState().log.join('\n'), /The app is not allowed to do this/);
});

test('records that disagree about the name are never merged', async () => {
  reset();
  const merged = [];
  const r = await mergeDuplicates([
    { memberId: '1', name: 'Ina Dakay', keptId: '10', otherIds: ['11'], nameMatch: true },
    { memberId: '2', name: 'Ina Dakay', keptId: '20', otherIds: ['21'], nameMatch: false },
  ], { merge: async (p) => { merged.push(p.mergeId); return {}; }, sheet: noSheet });
  assert.equal(r.ok, true);
  // Only the pair whose names agree.
  assert.deepEqual(merged, ['11']);
  const log = getState().log.join('\n');
  assert.match(log, /may be two different people/i);
  assert.match(log, /left alone: Ina Dakay \(LinkedIn 2\)/);
  assert.match(log, /1 left alone for a human to check/);
});

test('when every pair is a name mismatch, nothing is merged at all', async () => {
  reset();
  const r = await mergeDuplicates([{ memberId: '2', keptId: '20', otherIds: ['21'], nameMatch: false }],
    { merge: async () => { throw new Error('must not be called'); }, sheet: noSheet });
  assert.equal(r.ok, false);
  assert.match(r.reason, /name mismatch/i);
});

test('merging refuses when Check has not found any duplicates', async () => {
  reset();
  const r = await mergeDuplicates([], { merge: async () => { throw new Error('must not be called'); } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /run Check first/i);
});

test('a merged pair is cleared from the preview so it cannot be merged twice', async () => {
  reset();
  await buildPreview(['a@o.com'], {
    checkProps: async () => ({ ok: true, missing: [] }),
    options: async () => new Set(['a@o.com']),
    read: () => [{ slug: 's', memberId: '444725921' }],
    lookup: async () => {
      const m = new Map();
      m.duplicates = [{ memberId: '444725921', keptId: '10', otherIds: ['11'], name: 'Alecx' }];
      return m;
    },
    sheet: noSheet,
  });
  assert.equal(getState().preview.duplicates.length, 1);
  await mergeDuplicates(null, { merge: async () => ({}), sheet: noSheet });
  assert.equal(getState().preview.duplicates.length, 0);
});

test('nothing is written until runImport is called', async () => {
  reset();
  let wrote = false;
  await buildPreview(['a@o.com'], {
    checkProps: async () => ({ ok: true, missing: [] }),
    options: async () => new Set(['a@o.com']),
    read: () => [{ slug: 's', memberId: '1' }],
    lookup: async () => new Map(),
    create: async () => { wrote = true; },
    sheet: noSheet,
  });
  assert.equal(wrote, false);
  assert.equal(getState().imported, null);
});

test('stop lets the current account finish, then skips the rest', async () => {
  reset();
  const { stopCollect } = await import('../../src/connections/magellan-run.js');
  const collected = [];
  let closed = 0;
  startCollect(
    [{ account: 'a@o.com', profileId: 'p1' }, { account: 'b@o.com', profileId: 'p2' }, { account: 'c@o.com', profileId: 'p3' }],
    {
      semaphore: { async acquire() {}, release() {} },
      launchProfile: async () => ({ page: {} }),
      closeProfile: async () => { closed += 1; },
      collect: async (_page, account) => {
        collected.push(account);
        if (account === 'a@o.com') stopCollect();   // stop mid-first-account
        return { total: 1, withMemberId: 1, hidden: 0 };
      },
      sheet: noSheet,
    },
  );
  await new Promise((r) => setTimeout(r, 40));
  const st = getState();
  assert.deepEqual(collected, ['a@o.com'], 'the account in flight finished; the rest never started');
  assert.equal(closed, 1, 'its browser was still closed cleanly');
  assert.equal(st.stopped, true);
  assert.equal(st.phase, 'stopped');
  assert.equal(st.running, false);
});

test('stop on an idle runner reports that nothing is running', async () => {
  reset();
  const { stopCollect } = await import('../../src/connections/magellan-run.js');
  assert.deepEqual(stopCollect(), { stopped: false, reason: 'Nothing is running' });
});

// bulk-check gets a free retry — a failed sweep is simply run again next tick.
// Magellan visits an account once, so it has to retry inside the run.
test('a retryable failure gets a second attempt', async () => {
  reset();
  let tries = 0;
  startCollect([{ account: 'a@o.com', profileId: 'p1' }], {
    semaphore: { async acquire() {}, release() {} },
    launchProfile: async () => ({ page: {} }),
    closeProfile: async () => {},
    collect: async () => {
      tries += 1;
      if (tries === 1) throw new Error('navigation-failed: Navigation timeout of 30000 ms exceeded');
      return { total: 3, withMemberId: 3, hidden: 0 };
    },
    sheet: noSheet,
  });
  await settle();
  const st = getState();
  assert.equal(tries, 2);
  assert.equal(st.perAccount.length, 1, 'the failed attempt is not also recorded');
  assert.equal(st.perAccount[0].total, 3);
  assert.equal(st.done, 1, 'one account, counted once');
});

// A signed-out account will not sign itself in on a second try.
test('a failure that cannot be retried is not retried', async () => {
  reset();
  let tries = 0;
  startCollect([{ account: 'a@o.com', profileId: 'p1' }], {
    semaphore: { async acquire() {}, release() {} },
    launchProfile: async () => ({ page: {} }),
    closeProfile: async () => {},
    collect: async () => { tries += 1; throw new Error('Could not read connections: no-csrf'); },
    sheet: noSheet,
  });
  await settle();
  assert.equal(tries, 1);
  assert.equal(getState().perAccount[0].diagnosis.code, 'not_logged_in');
});

test('a retryable failure twice gives up and records it once', async () => {
  reset();
  let tries = 0;
  startCollect([{ account: 'a@o.com', profileId: 'p1' }], {
    semaphore: { async acquire() {}, release() {} },
    launchProfile: async () => ({ page: {} }),
    closeProfile: async () => {},
    collect: async () => { tries += 1; throw new Error('navigation-failed: Navigation timeout of 30000 ms exceeded'); },
    sheet: noSheet,
  });
  await settle();
  const st = getState();
  assert.equal(tries, 2);
  assert.equal(st.perAccount.length, 1);
  assert.equal(st.done, 1);
});

// The blocker behind "why can't we import it": HubSpot's Linkedin 1st
// Connections field is a fixed list of Ortus emails. Four accounts collected as
// GoLogin profile NAMES had nowhere to write to, and would have failed at
// import time, thousands of rows in.
test('an account HubSpot cannot accept is held back and named', async () => {
  reset();
  const { totals, blocked } = await buildPreview(['nushe@o.com', 'Jovana'], {
    checkProps: async () => ({ ok: true, missing: [] }),
    options: async () => new Set(['nushe@o.com']),
    read: () => [{ slug: 's', memberId: '1' }],
    lookup: async () => new Map(),
    sheet: noSheet,
  });
  assert.deepEqual(blocked, ['Jovana']);
  assert.equal(totals.created, 1, 'only the account that can be written is counted');
});

test('the option check is case-insensitive — HubSpot options are emails either way', async () => {
  reset();
  const { blocked } = await buildPreview(['Nushe@O.com'], {
    checkProps: async () => ({ ok: true, missing: [] }),
    options: async () => new Set(['nushe@o.com']),
    read: () => [],
    lookup: async () => new Map(),
    sheet: noSheet,
  });
  assert.deepEqual(blocked, []);
});

// Two GoLogin profiles can resolve to the same SoO address, and the picker has
// let the same one through twice — two runs then fight over one CSV.
test('the same account twice in one selection is collected once', async () => {
  reset();
  const seen = [];
  startCollect([
    { account: 'a@o.com', profileId: 'p1' },
    { account: 'A@O.com', profileId: 'p2' },
    { account: 'b@o.com', profileId: 'p3' },
  ], {
    semaphore: { async acquire() {}, release() {} },
    launchProfile: async () => ({ page: {} }),
    closeProfile: async () => {},
    collect: async (_p, acct) => { seen.push(acct); return { total: 1, withMemberId: 1, hidden: 0 }; },
    sheet: noSheet,
  });
  await settle();
  assert.deepEqual(seen, ['a@o.com', 'b@o.com']);
  assert.equal(getState().total, 2);
});

// The bug this exists to stop coming back: the card read
// "NOT RUNNING · 92% · Idle" for several seconds while Check was still working,
// because running cleared before the answer was written.
//
// A timer-based poller cannot catch this: buildPreview here resolves through a
// chain of already-resolved promises, which drains as pure microtasks and
// never once hands control to the timers phase, so a setInterval poll placed
// around the call never gets a turn while it's actually running — it can only
// ever observe the state well after everything is already settled, which
// would let a real ordering regression slip straight through disguised as a
// pass. onRunEnd is the seam built for exactly this: it fires from inside
// buildPreview's own finally, one line after running clears, so it sees the
// state at that instant with no race to lose.
test('the answer exists before running clears', async () => {
  reset();
  let snapshot = null;
  await buildPreview(['a@o.com'], {
    checkProps: async () => ({ ok: true, missing: [] }),
    options: async () => new Set(['a@o.com']),
    read: () => [{ slug: 's1', memberId: '1', firstName: 'A' }],
    lookup: async () => new Map(),
    onRunEnd: (st) => { snapshot = st; },
    sheet: noSheet,
  });
  assert.ok(snapshot, 'onRunEnd fired');
  assert.equal(snapshot.running, false, 'running had already cleared by the time onRunEnd saw it');
  assert.ok(snapshot.preview, 'preview was already written when running cleared');
  assert.ok(snapshot.outcome, 'the outcome was already written too');
});

test('a check that throws still clears running, and says why', async () => {
  reset();
  await assert.rejects(() => buildPreview(['a@o.com'], {
    checkProps: async () => ({ ok: true, missing: [] }),
    options: async () => new Set(['a@o.com']),
    read: () => [{ slug: 's1', memberId: '1', firstName: 'A' }],
    lookup: async () => { throw new Error('HubSpot 401: token expired'); },
  }), /token expired/);
  const st = getState();
  assert.equal(st.running, false, 'the card must not be left looking busy');
  assert.equal(st.phase, 'error');
  assert.equal(st.outcome.ok, false);
  assert.equal(st.outcome.summary, 'HubSpot 401: token expired');
});

test('a finished check carries its outcome', async () => {
  reset();
  await buildPreview(['a@o.com'], {
    checkProps: async () => ({ ok: true, missing: [] }),
    options: async () => new Set(['a@o.com']),
    read: () => [{ slug: 's1', memberId: '1', firstName: 'A' }, { slug: 's2', memberId: '2', firstName: 'B' }],
    lookup: async () => new Map([['2', { id: '900', properties: { email: 'real@x.com' } }]]),
    sheet: noSheet,
  });
  const st = getState();
  assert.equal(st.outcome.ok, true);
  assert.equal(st.outcome.summary, '1 new · 1 already there');
});

test('a blocked account reaches the outcome, named', async () => {
  reset();
  await buildPreview(['a@o.com', 'nope@o.com'], {
    checkProps: async () => ({ ok: true, missing: [] }),
    options: async () => new Set(['a@o.com']),
    read: () => [{ slug: 's1', memberId: '1', firstName: 'A' }],
    lookup: async () => new Map(),
    sheet: noSheet,
  });
  assert.match(getState().outcome.problems.join(' '), /nope@o\.com/);
});

test('a finished collect carries its outcome', async () => {
  reset();
  startCollect([{ account: 'a@o.com', profileId: 'p1' }], {
    semaphore: fakeSemaphore(),
    launchProfile: async () => ({ page: {} }),
    closeProfile: async () => {},
    collect: async () => ({ total: 10, withMemberId: 9, hidden: 1 }),
    sheet: noSheet,
  });
  await settle();
  const st = getState();
  assert.equal(st.outcome.ok, true);
  assert.equal(st.outcome.summary, '10 people from 1 account · 9 with a LinkedIn ID');
});

test('a finished import carries its outcome', async () => {
  reset();
  await runImport([{ account: 'a@o.com', plan: { creates: [{ properties: {} }], updates: [], additionalEmails: [] } }], {
    create: async () => ({ created: 1, errors: [] }),
    update: async () => ({ updated: 0, errors: [] }),
    attach: async () => {},
    sheet: noSheet,
  });
  const st = getState();
  assert.equal(st.outcome.ok, true);
  assert.equal(st.outcome.summary, '1 added · 0 updated');
});

// F1 regression: buildPreview used to spread the previous _state and never
// clear `imported`, so buildOutcome — which prefers `imported` over
// `preview` by field presence — kept reporting the LAST import's numbers on
// every Check that ran afterwards. Reproduces the exact real sequence:
// Check → Import → Check, and asserts the second Check's outcome is its own.
test('a Check after an Import states the Check\'s own numbers, not the Import\'s', async () => {
  reset();
  const rows = {
    'a@o.com': [{ slug: 's1', memberId: '1', firstName: 'A' }, { slug: 's2', memberId: '2', firstName: 'B' }],
  };
  const checkDeps = {
    checkProps: async () => ({ ok: true, missing: [] }),
    options: async () => new Set(['a@o.com']),
    read: (acct) => rows[acct],
    sheet: noSheet,
  };

  // 1. Check — 1 new, 1 already there.
  await buildPreview(['a@o.com'], { ...checkDeps, lookup: async () => new Map([['2', { id: '900', properties: {} }]]) });
  assert.equal(getState().outcome.summary, '1 new · 1 already there');

  // 2. Import — deliberately different numbers than the check, so a leak is
  // unmistakable.
  await runImport(getPlans(), {
    create: async () => ({ created: 4, errors: [] }),
    update: async () => ({ updated: 7, errors: [] }),
    attach: async () => {},
    sheet: noSheet,
  });
  assert.equal(getState().outcome.summary, '4 added · 7 updated');

  // 3. Check again — nothing already there this time. The outcome must be
  // THIS check's numbers, never the import's.
  await buildPreview(['a@o.com'], { ...checkDeps, lookup: async () => new Map() });
  const st = getState();
  assert.equal(st.outcome.summary, '2 new · 0 already there');
  assert.notEqual(st.outcome.summary, '4 added · 7 updated', 'the second Check must not report the Import\'s result');
});

// F1 regression, second half: `stopped` leaked the same way — stop a
// collect, then run a Check, and the card's eyebrow (app.js: `if (s.stopped)
// set('mg-eyebrow', 'Stopped')`) read "Stopped" forever because nothing ever
// cleared it on the next run.
test('stop a collect, then run a Check — Stopped does not survive into it', async () => {
  reset();
  startCollect([
    { account: 'a@o.com', profileId: 'p1' },
    { account: 'b@o.com', profileId: 'p2' },
  ], {
    semaphore: fakeSemaphore(),
    launchProfile: async () => ({ page: {} }),
    closeProfile: async () => {},
    // Asks to stop while the first account is still "in flight" — the second
    // account is then never started, exactly like stopCollect() being
    // clicked mid-sweep.
    collect: async () => { stopCollect(); return { total: 1, withMemberId: 1, hidden: 0 }; },
    sheet: noSheet,
  });
  await settle();
  assert.equal(getState().stopped, true, 'sanity: the stop actually landed');

  await buildPreview(['a@o.com'], {
    checkProps: async () => ({ ok: true, missing: [] }),
    options: async () => new Set(['a@o.com']),
    read: () => [{ slug: 's1', memberId: '1', firstName: 'A' }],
    lookup: async () => new Map(),
    sheet: noSheet,
  });
  assert.equal(getState().stopped, false, 'a Check that never stopped must not be marked Stopped');
});

// startCollect, runImport and mergeDuplicates all refused to start on top of a
// live run; Check did not, and shares the same module-level _state.
test('a Check refuses to start on top of a live collect', async () => {
  reset();
  let release;
  const held = new Promise((r) => { release = r; });
  startCollect([{ account: 'a@o.com', profileId: 'p1' }], {
    semaphore: fakeSemaphore(),
    launchProfile: async () => ({ page: {} }),
    closeProfile: async () => {},
    collect: async () => { await held; return { total: 10, withMemberId: 10, hidden: 0 }; },
    sheet: noSheet,
  });
  await settle();
  assert.equal(getState().running, true);

  await assert.rejects(
    () => buildPreview(['a@o.com'], {
      checkProps: async () => { throw new Error('must not be reached'); },
      options: async () => { throw new Error('must not be reached'); },
      sheet: noSheet,
    }),
    /already running/i,
  );
  // The collect's own run is untouched by the refusal.
  assert.equal(getState().phase, 'collecting');
  release();
  await settle();
  assert.equal(getState().done, 1);
  assert.equal(getState().phase, 'done');
});

// An account HubSpot allows but that was never collected reads back as zero
// rows. Counting it as "looked at" produced "0 new · 0 already there".
test('a Check on an allowed but uncollected account says nothing was collected', async () => {
  reset();
  await buildPreview(['a@o.com'], {
    checkProps: async () => ({ ok: true, missing: [] }),
    options: async () => new Set(['a@o.com']),
    read: () => [],
    lookup: async () => new Map(),
    sheet: noSheet,
  });
  const st = getState();
  assert.deepEqual(st.preview.read, [], 'no account had a file with rows in it');
  assert.equal(st.outcome.ok, false);
  assert.match(st.outcome.summary, /nothing has been collected yet/i);
});

// A contact HubSpot already holds complete needs no property written, so it
// lands in neither creates nor updates. "Already there" counted updates.
test('a Check counts people HubSpot already holds, not just the ones it will write to', async () => {
  reset();
  const complete = {
    id: '900',
    properties: {
      linkedin_membership_id: '111',
      linkedin_1st_connections: 'a@o.com',
      firstname: 'Al', lastname: 'Ecx', company: 'Ortus', jobtitle: 'Ops',
      email: 'alecx@ortusclub.com',
      hs_additional_emails: '111@linkedinmembership.id',
    },
  };
  const { totals } = await buildPreview(['a@o.com'], {
    checkProps: async () => ({ ok: true, missing: [] }),
    options: async () => new Set(['a@o.com']),
    read: () => [{ slug: 'alecx', memberId: '111', firstName: 'Al', lastName: 'Ecx', company: 'Ortus', jobTitle: 'Ops' }],
    lookup: async () => new Map([['111', complete]]),
    sheet: noSheet,
  });
  assert.equal(totals.created, 0, 'HubSpot already has them');
  assert.equal(totals.updated, 0, 'and there is nothing left to write');
  assert.equal(totals.existing, 1, 'but they were still found');
  assert.match(getState().outcome.summary, /^0 new · 1 already there$/);
});

// HubSpot cannot un-create a contact, so an import that dies part-way still has
// to account for what it already wrote.
test('an import that fails part-way still reports what it already wrote', async () => {
  reset();
  const plans = [
    { account: 'a@o.com', plan: { creates: [{ connection: { memberId: '1' }, properties: {} }], updates: [], additionalEmails: [] } },
    { account: 'b@o.com', plan: { creates: [{ connection: { memberId: '2' }, properties: {} }], updates: [], additionalEmails: [] } },
  ];
  const r = await runImport(plans, {
    create: async (items) => {
      if (items[0].properties === plans[1].plan.creates[0].properties) throw new Error('HubSpot 500');
      return { created: 7, errors: [] };
    },
    update: async () => ({ updated: 0, errors: [] }),
    attach: async () => ({ attached: 0, errors: [] }),
    sheet: noSheet,
  });
  assert.equal(r.ok, false);
  const st = getState();
  assert.equal(st.imported.created, 7, 'the first account is on the record');
  assert.equal(st.outcome.ok, false);
  assert.match(st.outcome.summary, /7 added .* before it stopped — HubSpot 500/);
});

// The whole walk lives inside one page.evaluate(), so a dead browser leaves a
// promise that never settles. Stop was checked only BETWEEN accounts, which is
// indistinguishable from never when the hung account is the current one.
test('Stop abandons the account being read instead of waiting for it', async () => {
  reset();
  let closed = false;
  startCollect([{ account: 'a@o.com', profileId: 'p1' }, { account: 'b@o.com', profileId: 'p2' }], {
    semaphore: fakeSemaphore(),
    launchProfile: async () => ({ page: {} }),
    closeProfile: async () => { closed = true; },
    // Never settles — exactly what a closed browser leaves behind.
    collect: () => new Promise(() => {}),
    sheet: noSheet,
  });
  await settle();
  assert.equal(getState().running, true);

  stopCollect();
  // The watchdog ticks once a second; give it two.
  await new Promise((r) => setTimeout(r, 2200));

  const st = getState();
  assert.equal(st.running, false, 'the sweep actually ended');
  assert.equal(st.phase, 'stopped');
  assert.equal(closed, true, 'the browser was still closed on the way out');
  const row = st.perAccount.find((a) => a.account === 'a@o.com');
  assert.equal(row.diagnosis.code, 'stopped_by_operator');
  assert.equal(row.diagnosis.retryable, false, 'a stop must never be retried');
  assert.ok(!st.perAccount.some((a) => a.account === 'b@o.com'), 'the rest were not started');
});

// Same hang, nobody watching. Four minutes of silence used to be forever.
test('a read that stops reporting progress is abandoned, and the sweep goes on', async () => {
  reset();
  const { setStallMs } = await import('../../src/connections/magellan-run.js');
  setStallMs(1200);
  try {
    startCollect([{ account: 'dead@o.com', profileId: 'p1' }, { account: 'ok@o.com', profileId: 'p2' }], {
      semaphore: fakeSemaphore(),
      launchProfile: async () => ({ page: {} }),
      closeProfile: async () => {},
      collect: (page, account) => (account === 'dead@o.com'
        ? new Promise(() => {})
        : Promise.resolve({ total: 4, withMemberId: 4, hidden: 0 })),
      sheet: noSheet,
    });
    await new Promise((r) => setTimeout(r, 3000));
    const st = getState();
    assert.equal(st.running, false);
    assert.equal(st.phase, 'done', 'a stall is not a stop — the sweep finishes');
    const dead = st.perAccount.find((a) => a.account === 'dead@o.com');
    assert.equal(dead.diagnosis.code, 'stalled');
    assert.equal(dead.diagnosis.retryable, false, 'retrying a dead browser just buys another stall');
    const ok = st.perAccount.find((a) => a.account === 'ok@o.com');
    assert.equal(ok.total, 4, 'the next account still ran');
  } finally {
    setStallMs(4 * 60 * 1000);
  }
});
