import test from 'node:test';
import assert from 'node:assert/strict';
import { startCollect, buildPreview, runImport, getState, reset } from '../../src/connections/magellan-run.js';

const settle = () => new Promise((r) => setTimeout(r, 20));

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
      launchProfile: async () => { n += 1; if (n === 1) throw new Error('LinkedIn is blocking this account'); return { page: {} }; },
      closeProfile: async () => {},
      collect: async () => ({ total: 5, withMemberId: 5, hidden: 0 }),
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
    read: () => [{ slug: 's', memberId: '1' }],
    lookup: async () => new Map(),
    create: async () => { wrote = true; },
  });
  assert.equal(wrote, false);
  assert.equal(getState().imported, null);
});
