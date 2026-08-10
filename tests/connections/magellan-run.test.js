import test from 'node:test';
import assert from 'node:assert/strict';
import { startCollect, buildPreview, runImport, getState, reset } from '../../src/connections/magellan-run.js';

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

test('nothing is written until runImport is called', async () => {
  reset();
  let wrote = false;
  await buildPreview(['a@o.com'], {
    checkProps: async () => ({ ok: true, missing: [] }),
    options: async () => new Set(['a@o.com']),
    read: () => [{ slug: 's', memberId: '1' }],
    lookup: async () => new Map(),
    create: async () => { wrote = true; },
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
