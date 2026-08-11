# Magellan Run Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Magellan card tell the truth about whether it is running, show one percentage, say what will actually run before you press Check, and state an outcome when it ends — and take the irreversible Merge button off the screen.

**Architecture:** The run state gains one field, `outcome`, built by a new pure module `src/connections/magellan-outcome.js` and written by the same code that ends a run — so it cannot exist without the run having ended. `buildPreview`'s `try` widens to cover the roll-up and the `preview` write, so `running` clears last. The browser side gains one pure module `public/js/magellan-view.mjs` holding the single percentage function and the selection summary, following the same pattern as `public/js/vjcard.mjs` (browser-safe, no DOM, unit-tested by `node --test`).

**Tech Stack:** Node ≥22, ES modules, Express 4, vanilla browser JS loaded as `<script type="module">`, `node --test` only.

## Global Constraints

- Node ≥22. ES modules everywhere (`import` / `export`, no `require`).
- Tests are `node --test` only. No Jest, no Vitest, no test framework additions.
- Pure helpers over integration tests. Anything with DOM access is verified manually in the Electron shell.
- All new CSS rules must be scoped `body[data-dashboard='v3']` with **single quotes** — the v0.3 design system is scoped to that attribute and an unscoped rule renders as an unstyled page.
- Design system: monochrome, hairlines, radii 0 or 9999, gold only on the Start CTA. No new accent colours.
- Never invent data. Every number on the card comes from the run state; when a number is not known, the surface says nothing rather than guessing.
- No file in `src/linkedin/` is touched by this plan.
- After every commit that touches runtime code, relaunch the dev app:
  ```bash
  pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "Electron.*ortus" 2>/dev/null
  npm run dev:app > /tmp/dev-app.log 2>&1 &
  ```
  Electron pins port **7847** and holds a single-instance lock — verify the relaunch actually happened with `ps -p <pid> -o lstart=`, not by checking that the port answers.
- Bump `package.json` version and the `?v=` cache-bust on `public/index.html`'s `app.js` script tag (line 4043) before the final relaunch. Current: `3.1.26`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/connections/magellan-outcome.js` | **new.** Pure. Turns a finished run's state into `{ok, summary, problems}`. No I/O, no state. |
| `tests/connections/magellan-outcome.test.js` | **new.** Unit tests for the above. |
| `src/connections/magellan-run.js` | Widened `try` in `buildPreview`; `outcome` in `idle()`; `_state.outcome` written at every run end (collect, check, import). |
| `tests/connections/magellan-run.test.js` | Adds the running-clears-last regression and the outcome tests. |
| `server.js` | `/api/magellan/accounts` gains `importable` per account. |
| `public/js/magellan-view.mjs` | **new.** Pure. `magellanPct(state)` and `selectionSummary(accounts)`. Browser-safe, no DOM. |
| `tests/magellan-view.test.js` | **new.** Unit tests for the above. |
| `public/js/app.js` | Reads `magellanPct` once; renders the selection split and the outcome block; deletes the duplicate list and merge handler. |
| `public/index.html` | Adds `#mg-outcome` and its scoped rules; deletes `#mg-dupes` and the `.dp*` / `.dpa*` / `.rec*` rules. |

---

### Task 1: The outcome module

**Files:**
- Create: `src/connections/magellan-outcome.js`
- Test: `tests/connections/magellan-outcome.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `buildOutcome(state) → { ok: boolean, summary: string, problems: string[] }`.
  `state` is the shape returned by `magellan-run.js` `getState()`. Task 2 calls this.

The two existing group-by-cause helpers already return compatible shapes and are
reused as-is:
- `summarise(perAccount)` from `magellan-diagnose.js` → `[{ code, count, accounts, what, why, fix }]`
- `summariseProblems(errors)` from `magellan-problems.js` → `[{ code, what, fix, count, accounts }]`

- [ ] **Step 1: Write the failing tests**

Create `tests/connections/magellan-outcome.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOutcome } from '../../src/connections/magellan-outcome.js';

test('a finished check says what it found', () => {
  const o = buildOutcome({
    phase: 'done', done: 12, total: 12,
    preview: {
      totals: { created: 9623, updated: 15545 },
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/connections/magellan-outcome.test.js`
Expected: FAIL — `Cannot find module '.../magellan-outcome.js'`

- [ ] **Step 3: Write the module**

Create `src/connections/magellan-outcome.js`:

```js
// What a finished Magellan run has to say for itself.
//
// The card used to keep its live counters after a run ended, so a finished
// Check read "92% · 0 people so far" — the live labels were still in place
// because nothing replaced them. This turns an ended run into one sentence and
// a short list of things worth knowing, in the words of whoever has to act on
// them.
//
// Pure. Takes the state, returns a record. Never reads the clock, never fetches.
import { summarise } from './magellan-diagnose.js';

const n = (v) => Number(v || 0).toLocaleString();

// One line per KIND of problem, never per occurrence: 61 identical duplicate
// clashes are one job, not 61 lines. Both group-by-cause helpers in this folder
// already return {count, what, fix}, so they render the same way.
const problemLine = (p) => `${n(p.count)} × ${p.what} — ${p.fix}`;

/**
 * @param {object} state - magellan-run.js getState() shape
 * @returns {{ok: boolean, summary: string, problems: string[]}|null}
 *   null while the run has not ended — there is nothing truthful to say yet.
 */
export function buildOutcome(state = {}) {
  const s = state || {};
  if (s.running) return null;
  if (!['done', 'stopped', 'error'].includes(s.phase)) return null;

  if (s.phase === 'error') {
    return { ok: false, summary: String(s.error || 'It stopped unexpectedly'), problems: [] };
  }

  const problems = [];

  // Collect failures — grouped by the diagnosis code the sweep already stamped.
  for (const g of summarise(s.perAccount || [])) {
    problems.push(problemLine({ count: g.count, what: g.what || 'It failed', fix: g.fix || '' }));
  }

  // Check findings. Duplicates are stated, never actioned: the import already
  // writes the connection to the record with a real email address, so there is
  // nothing to fix here — merging was dropped on purpose.
  const pv = s.preview;
  if (pv) {
    const dupes = (pv.duplicates || []).length;
    if (dupes) {
      problems.push(`${n(dupes)} ${dupes === 1 ? 'person is' : 'people are'} in HubSpot more than once — `
        + 'their connection was recorded on the record with a real email address, so nothing was missed');
    }
    const blocked = pv.blocked || [];
    if (blocked.length) {
      problems.push(`${blocked.length} account${blocked.length === 1 ? '' : 's'} skipped: `
        + `${blocked.join(', ')} ${blocked.length === 1 ? 'isn’t' : 'aren’t'} on the HubSpot list yet`);
    }
  }

  // Import problems, already grouped by cause with a fix attached.
  const imp = s.imported;
  for (const p of (imp && imp.problems) || []) problems.push(problemLine(p));

  // A run that ended early says how far it got BEFORE it states any total. A
  // partial number is never presented as a final one.
  if (s.phase === 'stopped') {
    return {
      ok: false,
      summary: `Stopped after ${n(s.done)} of ${n(s.total)} accounts — the rest weren’t asked about`,
      problems,
    };
  }

  // Which half ran decides which numbers mean anything. Newest wins: an import
  // replaces a check's summary, a check replaces a collect's.
  if (imp) {
    return { ok: true, summary: `${n(imp.created)} added · ${n(imp.updated)} updated`, problems };
  }
  if (pv) {
    const t = pv.totals || {};
    return { ok: true, summary: `${n(t.created)} new · ${n(t.updated)} already there`, problems };
  }
  const ok = (s.perAccount || []).filter((a) => !a.error);
  const people = ok.reduce((sum, a) => sum + (a.total || 0), 0);
  const matched = ok.reduce((sum, a) => sum + (a.withMemberId || 0), 0);
  return {
    ok: true,
    summary: `${n(people)} people from ${n(ok.length)} account${ok.length === 1 ? '' : 's'} · ${n(matched)} with a LinkedIn ID`,
    problems,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/connections/magellan-outcome.test.js`
Expected: PASS, 10 tests

- [ ] **Step 5: Commit**

```bash
git add src/connections/magellan-outcome.js tests/connections/magellan-outcome.test.js
git commit -m "feat(magellan): turn a finished run into one sentence and a short list

A finished Check read '92% · 0 people so far' because the card kept its live
counters and nothing replaced them. buildOutcome() is the replacement: pure,
per-phase, and null while the run is still going so there is no way to render a
half-finished answer as a final one.

Duplicates are stated as a fact, not as a job — merging was dropped."
```

---

### Task 2: `running` clears last, and every run end writes its outcome

**Files:**
- Modify: `src/connections/magellan-run.js` (`idle()` at `:20`, collect end at `:185-204`, `buildPreview` at `:256-313`, `runImport` end at `:464-488`)
- Test: `tests/connections/magellan-run.test.js`

**Interfaces:**
- Consumes: `buildOutcome(state)` from Task 1.
- Produces: `getState().outcome` — `{ok, summary, problems}` or `null`. Task 7 renders it.
  Guarantee relied on by Task 7: when `running` is `false` and `outcome` is non-null,
  the state also carries whatever produced it (`preview`, `imported`, or `error`).

**The bug being fixed:** `buildPreview`'s `finally` (`:282`) sets `running = false`
and `phase = 'done'`, but the duplicate roll-up (`:293`), `_plans` (`:305`),
`_state.preview` (`:306`) and the `return` (`:313`) all run *after* it. The 5s
poller sees `running: false` while the request is still open and `preview` is
still `null` — the card reads `Not running · 92% · Idle`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/connections/magellan-run.test.js`:

```js
// The bug this exists to stop coming back: the card read
// "NOT RUNNING · 92% · Idle" for several seconds while Check was still working,
// because running cleared before the answer was written.
test('the answer exists before running clears', async () => {
  reset();
  let stateWhenClear = null;
  // Poll like the browser does, and grab the state the instant running drops.
  const poll = setInterval(() => {
    const st = getState();
    if (!stateWhenClear && st.phase !== 'idle' && !st.running) stateWhenClear = st;
  }, 1);
  await buildPreview(['a@o.com'], {
    checkProps: async () => ({ ok: true, missing: [] }),
    options: async () => new Set(['a@o.com']),
    read: () => [{ slug: 's1', memberId: '1', firstName: 'A' }],
    lookup: async () => new Map(),
  });
  clearInterval(poll);
  assert.ok(stateWhenClear, 'the poller saw running go false');
  assert.ok(stateWhenClear.preview, 'preview was already written when running cleared');
  assert.ok(stateWhenClear.outcome, 'the outcome was already written too');
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/connections/magellan-run.test.js`
Expected: FAIL — `the answer exists before running clears` fails on
`preview was already written when running cleared`; the outcome assertions fail
with `Cannot read properties of null (reading 'ok')`.

- [ ] **Step 3: Import the builder and add the state field**

In `src/connections/magellan-run.js`, add to the imports after line 13:

```js
import { buildOutcome } from './magellan-outcome.js';
```

and add one field to `idle()` (after `error: null,` at `:35`):

```js
  outcome: null,           // {ok, summary, problems} once the run has ended
```

- [ ] **Step 4: Restructure `buildPreview` so `running` clears last**

Replace the block from `let checkedSoFar = 0;` (`:258`) through the `return` (`:313`) with:

```js
  let checkedSoFar = 0;
  try {
    for (const account of usable) {
      const rows = read(account);
      const memberIds = rows.map((r) => r.memberId).filter(Boolean);
      _state.account = account;
      const existing = await lookup(memberIds, {
        onProgress: ({ done, total }) => {
          _state.current = { account, count: done, total, stage: 'check' };
          _state.checked = checkedSoFar + done;
        },
      });
      for (const d of existing.duplicates || []) {
        const seen = dupeByMember.get(d.memberId);
        if (seen) { if (!seen.accounts.includes(account)) seen.accounts.push(account); continue; }
        dupeByMember.set(d.memberId, { ...d, accounts: [account] });
      }
      const plan = planAccount(rows, account, (c) => existing.get(String(c.memberId)) || null);
      plans.push({ account, plan });
      for (const k of Object.keys(totals)) totals[k] += plan.counts[k] || 0;
      checkedSoFar += memberIds.length;
      _state.done += 1;
      _state.current = null;
    }

    // Everything below used to sit AFTER the finally, so the card went idle
    // seconds before the answer existed — "NOT RUNNING · 92% · Idle" while the
    // request was still open. running now clears only once the state carries a
    // preview or an error. There is no instant where the card can truthfully
    // say "not running" and have nothing to show.
    const duplicates = [...dupeByMember.values()];
    if (duplicates.length) {
      log(`⚠ ${duplicates.length} people are in HubSpot twice under one LinkedIn ID. `
        + 'Their connection is recorded on the record with a real email address, so nothing is '
        + 'missed. The second address is refused — that is the "different vid" message.');
      for (const d of duplicates.slice(0, 10)) {
        log(`⚠ ${d.name || 'unnamed'} (LinkedIn ${d.memberId}): recorded on ${d.keptId}, `
          + `also exists as ${d.otherIds.join(', ')}`);
      }
      if (duplicates.length > 10) log(`⚠ …and ${duplicates.length - 10} more — the full list is in the sheet.`);
    }

    _plans = plans;
    _state.preview = {
      totals, blocked, duplicates, builtAt: new Date().toISOString(), accounts: usable,
    };
    if (blocked.length) {
      log(`⚠ ${blocked.length} account${blocked.length === 1 ? '' : 's'} cannot go into HubSpot — `
        + `not on the "Linkedin 1st Connections" list: ${blocked.join(', ')}`);
    }
    _state.phase = 'done';
    _state.outcome = buildOutcome(_state);
    return { totals, plans, blocked, duplicates };
  } catch (err) {
    log(`✗ The check stopped — ${err.message}`);
    _state.error = err.message;
    _state.phase = 'error';
    _state.outcome = buildOutcome(_state);
    throw err;
  } finally {
    // Check writes nothing, so the card must not be left looking busy — whether
    // it finished, threw, or the portal refused halfway through. running goes
    // last, after the try or the catch has written the result.
    _state.account = null;
    _state.current = null;
    _state.step = null;
    _state.running = false;
  }
}
```

- [ ] **Step 5: Write the outcome at the other two run ends**

In `startCollect`'s async body, after `_state.finishedAt = new Date().toISOString();` (`:194`), add:

```js
    _state.outcome = buildOutcome(_state);
```

In the same function's `.catch` (`:198-204`), after `_state.phase = 'error';` add:

```js
    _state.outcome = buildOutcome(_state);
```

In `runImport`, after `_state.phase = 'done';` (`:477`) add:

```js
    _state.outcome = buildOutcome(_state);
```

and in its `catch`, after `_state.phase = 'error';` (`:482`) add:

```js
    _state.outcome = buildOutcome(_state);
```

- [ ] **Step 6: Run the whole Magellan suite**

Run: `node --test tests/connections/magellan-run.test.js tests/connections/magellan-outcome.test.js`
Expected: PASS. The six new tests pass and all 25 pre-existing tests still pass.

- [ ] **Step 7: Commit**

```bash
git add src/connections/magellan-run.js tests/connections/magellan-run.test.js
git commit -m "fix(magellan): the job is not done until its result exists

buildPreview's finally cleared running and set phase='done' before the duplicate
roll-up, _plans, _state.preview and the return — so the 5s poller saw
running:false while the request was still open and preview was still null. That
is the 'NOT RUNNING · 92% · Idle' screenshot.

The try now covers the roll-up and the preview write; the finally clears running
last, after the try or the catch has written a preview or an error. Every run end
— collect, check, import, and both error paths — writes _state.outcome."
```

- [ ] **Step 8: Relaunch the dev app**

```bash
pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "Electron.*ortus" 2>/dev/null
npm run dev:app > /tmp/dev-app.log 2>&1 &
```

Then confirm it actually restarted:

```bash
ps -eo pid,lstart,command | grep -i "[E]lectron.*ortus" | head -3
```

Expected: a start time within the last minute. A single-instance lock means a
second `npm run dev:app` silently focuses the existing window without restarting
it — the port answering is not proof.

---

### Task 3: The server says which accounts HubSpot can accept

**Files:**
- Modify: `server.js:2560-2607` (`GET /api/magellan/accounts`)

**Interfaces:**
- Consumes: `connectionsPropOptions()` from `src/connections/hubspot-client.js` —
  returns a `Set` of lowercased Ortus account emails that the
  `linkedin_1st_connections` property will accept.
- Produces: each account object in the response gains
  `importable: true | false | null`. `null` means the option list could not be
  read, and every consumer must treat it as "unknown" and say nothing.

Today the split happens inside `buildPreview` (`magellan-run.js:233`) and the
blocked account is only named in a log line *after* the run. The same split has
to be available before the operator presses Check.

- [ ] **Step 1: Import the option reader**

Add to the imports near `server.js:107`:

```js
import { connectionsPropOptions } from './src/connections/hubspot-client.js';
```

- [ ] **Step 2: Read the options, tolerating failure**

Inside the `/api/magellan/accounts` handler, after the `const overrides = magellanLabelOverrides();`
line, add:

```js
    // Which accounts HubSpot's "Linkedin 1st Connections" list will actually
    // accept. Read here so the selection bar can say "12 of 13 can go in"
    // BEFORE Check runs — the same split buildPreview does at run time. A
    // portal that will not answer leaves this null: unknown, and the screen
    // says nothing rather than guessing.
    let hsOptions = null;
    try {
      hsOptions = await connectionsPropOptions();
    } catch (err) {
      console.warn(`[magellan] could not read the HubSpot options — ${err.message}`);
    }
```

- [ ] **Step 3: Add the field to each row**

In the same handler's `res.json(profiles.map((p) => { … }))`, add one line to the
returned object, after `ambiguous: …`:

```js
        // Matched exactly as buildPreview does: trimmed and lowercased.
        importable: hsOptions ? hsOptions.has(String(account).trim().toLowerCase()) : null,
```

- [ ] **Step 4: Verify by hand**

With the dev app running:

```bash
curl -s http://127.0.0.1:7847/api/magellan/accounts | head -c 600
```

Expected: each object carries `"importable": true` or `"importable": false`.
`jemely.butron@ortus.solutions` must be `false` — it is the known-blocked account.
If every value is `null`, the HubSpot token is not loading; check `.env` before
continuing.

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat(magellan): tell the browser which accounts HubSpot will accept

The allowlist split already happens inside buildPreview, but only names the
blocked account in a log line after the run — which is why the bar said '13
accounts selected' over a run of '11 of 12'. The accounts endpoint now carries
importable per account so the split can be shown before Check is pressed. A
portal that will not answer leaves it null: unknown, and the screen says nothing."
```

---

### Task 4: One percentage, and one selection summary

**Files:**
- Create: `public/js/magellan-view.mjs`
- Test: `tests/magellan-view.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `magellanPct(state) → number` (0-100 integer). Task 5 uses it.
  - `selectionSummary(accounts) → { total, usable, blocked: string[], known: boolean }`
    where `accounts` is `[{ account: string, importable: boolean|null }]`. Task 6 uses it.

Follows the `public/js/vjcard.mjs` pattern: browser-safe, no DOM, imported by
`app.js` and unit-tested by `node --test`.

- [ ] **Step 1: Write the failing tests**

Create `tests/magellan-view.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { magellanPct, selectionSummary } from '../public/js/magellan-view.mjs';

test('no total means no percentage', () => {
  assert.equal(magellanPct({}), 0);
  assert.equal(magellanPct({ done: 3, total: 0 }), 0);
});

test('whole accounts when nothing is mid-flight', () => {
  assert.equal(magellanPct({ done: 10, total: 12 }), 83);
});

test('a check counts its in-account fraction as the whole slice', () => {
  // 10 of 12 accounts done, and 50% through the 11th.
  assert.equal(magellanPct({ done: 10, total: 12, current: { stage: 'check', count: 50, total: 100 } }), 88);
});

test('reading the list is the front half of an account', () => {
  assert.equal(magellanPct({ done: 10, total: 12, current: { stage: 'list', count: 50, total: 100 } }), 85);
});

test('looking up IDs is the back half', () => {
  assert.equal(magellanPct({ done: 10, total: 12, current: { stage: 'ids', count: 50, total: 100 } }), 90);
});

test('it never exceeds 100', () => {
  assert.equal(magellanPct({ done: 12, total: 12, current: { stage: 'check', count: 500, total: 100 } }), 100);
});

test('the selection splits into what can go in and what cannot', () => {
  const s = selectionSummary([
    { account: 'a@o.com', importable: true },
    { account: 'b@o.com', importable: true },
    { account: 'jemely.butron@ortus.solutions', importable: false },
  ]);
  assert.equal(s.total, 3);
  assert.equal(s.usable, 2);
  assert.deepEqual(s.blocked, ['jemely.butron@ortus.solutions']);
  assert.equal(s.known, true);
});

test('one unknown account makes the whole split unknown — it never guesses', () => {
  const s = selectionSummary([
    { account: 'a@o.com', importable: true },
    { account: 'b@o.com', importable: null },
  ]);
  assert.equal(s.known, false);
  assert.deepEqual(s.blocked, []);
  assert.equal(s.usable, 2, 'with nothing known to be blocked, all of them are the honest count');
});

test('an empty selection is known and empty', () => {
  assert.deepEqual(selectionSummary([]), { total: 0, usable: 0, blocked: [], known: true });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/magellan-view.test.js`
Expected: FAIL — `Cannot find module '.../public/js/magellan-view.mjs'`

- [ ] **Step 3: Write the module**

Create `public/js/magellan-view.mjs`:

```js
// Pure helpers for the Magellan card — browser-safe (no DOM), so app.js imports
// them and node --test unit-tests them. Same arrangement as vjcard.mjs.

/**
 * The ONLY percentage in this card.
 *
 * renderMagellanState used to compute this twice: once from whole accounts and
 * again with the in-account fraction blended in, writing both to #mg-pct — and
 * the Check button read the first while the hero showed the second. That is how
 * 92% and 83% ended up on screen together. The in-account fraction is part of
 * the answer, not a later correction to it.
 *
 * Stage weighting, unchanged from what the card already did:
 *   'check' — asking HubSpot IS the whole of an account's work
 *   'list'  — reading the connections list is the front half
 *   'ids'   — resolving each person's LinkedIn ID is the back half
 */
export function magellanPct(state = {}) {
  const s = state || {};
  const total = Number(s.total) || 0;
  if (total <= 0) return 0;
  const done = Number(s.done) || 0;
  const c = s.current;
  let frac = 0;
  if (c && Number(c.total) > 0 && c.count != null) {
    const raw = Math.min(1, Number(c.count) / Number(c.total));
    frac = c.stage === 'check' ? raw : c.stage === 'ids' ? 0.5 + raw / 2 : raw / 2;
  }
  return Math.min(100, Math.round(((done + frac) / total) * 100));
}

/**
 * What pressing Check would actually run.
 *
 * The bar said "13 accounts selected" over a run that reported "11 of 12",
 * because the HubSpot allowlist drops accounts it has no option for and only
 * says so in the log afterwards. Neither number was wrong; nothing connected
 * them.
 *
 * `importable` is null when the portal could not be asked. One unknown makes the
 * whole split unknown — a screen that guesses which colleague's account is about
 * to be skipped is worse than one that stays quiet.
 *
 * @param {Array<{account: string, importable: boolean|null}>} accounts
 */
export function selectionSummary(accounts = []) {
  const list = Array.isArray(accounts) ? accounts : [];
  const known = list.every((a) => typeof a.importable === 'boolean');
  const blocked = known ? list.filter((a) => !a.importable).map((a) => a.account) : [];
  return { total: list.length, usable: list.length - blocked.length, blocked, known };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/magellan-view.test.js`
Expected: PASS, 9 tests

- [ ] **Step 5: Commit**

```bash
git add public/js/magellan-view.mjs tests/magellan-view.test.js
git commit -m "feat(magellan): one percentage function, one selection summary

magellanPct is the single source of the card's percentage — the hero, the bar and
the Check button all read it, which is what stops 92% and 83% appearing together.
selectionSummary answers what pressing Check would actually run, and refuses to
guess when the HubSpot option list could not be read."
```

---

### Task 5: The card reads one percentage

**Files:**
- Modify: `public/js/app.js` — the import block near `:26`, and `renderMagellanState` at `:27203-27320`

**Interfaces:**
- Consumes: `magellanPct(state)` from Task 4.
- Produces: nothing new.

- [ ] **Step 1: Import the helper**

Add near the other `/js/*.mjs` imports (around `public/js/app.js:26`):

```js
import { magellanPct, selectionSummary } from '/js/magellan-view.mjs';
```

`selectionSummary` is used in Task 6; importing both here keeps one import line.

- [ ] **Step 2: Replace the first percentage computation**

In `renderMagellanState`, replace line `:27211`:

```js
  const pct = s.total ? Math.round((s.done / s.total) * 100) : 0;
```

with:

```js
  // The only percentage in this card. Computing it twice — once here from whole
  // accounts and again below with the in-account fraction — is what put 92% in
  // the hero and 83% on the Check button at the same moment.
  const pct = magellanPct(s);
```

- [ ] **Step 3: Delete the second computation**

Inside the `if (stage)` / `if (s.account)` block, delete the whole trailing
blend, currently `:27311-27320`:

```js
      // Blend the in-account fraction into the bar so it moves continuously
      // instead of jumping a whole account at a time.
      if (c && c.total && c.count != null && s.total) {
        // The ID lookup is the back half of one account's work, so its
        // fraction counts for the second half of that account's slice.
        // Checking has no second half — its fraction is the whole slice.
        const raw = Math.min(1, c.count / c.total);
        const frac = c.stage === 'check' ? raw : ids ? 0.5 + raw / 2 : raw / 2;
        const blended = Math.round((((s.done || 0) + frac) / s.total) * 100);
        set('mg-pct', blended);
        if (bar) bar.style.width = `${blended}%`;
      }
```

Delete all of it. `magellanPct` already carries this weighting, and `mg-pct` and
`mg-bar` are set from `pct` earlier in the function.

- [ ] **Step 4: Verify by hand in the app**

Reload the Electron window with Cmd+R, open the Connections → Magellan tab, tick
two collected accounts and press **Check what would happen**.

Expected: the number on the button (`Checking… NN%`) and the big number in the
card are **the same** on every tick, and both move smoothly rather than jumping a
whole account at a time.

- [ ] **Step 5: Commit**

```bash
git add public/js/app.js
git commit -m "fix(magellan): the hero and the Check button read the same percentage

#mg-pct was written twice per render — once from whole accounts, once with the
in-account fraction blended in — and the button label read the first while the
hero showed the second. 92% and 83%, same screen, same moment. Both now read
magellanPct()."
```

---

### Task 6: The selection bar says what will actually run

**Files:**
- Modify: `public/js/app.js` — `updateMagellanCounts` at `:27044-27061`
- Modify: `public/index.html:812-815` (the `.mg-selbar` block) and the Magellan `<style>` block

**Interfaces:**
- Consumes: `selectionSummary(accounts)` from Task 4; `importable` from Task 3;
  the module-level `mgAccounts` array and `mgSelected` `Set` of profile ids that
  already exist in `app.js`.
- Produces: nothing new.

- [ ] **Step 1: Give the bar somewhere to put the split**

In `public/index.html`, replace the `.mg-selbar` block (`:812-815`):

```html
          <div class="mg-selbar">
            <span class="mg-selbar-n" id="mg-sel-count">0</span>
            <span class="mg-selbar-t" id="mg-sel-sub">accounts selected</span>
          </div>
```

with:

```html
          <div class="mg-selbar">
            <span class="mg-selbar-n" id="mg-sel-count">0</span>
            <span class="mg-selbar-t" id="mg-sel-sub">accounts selected</span>
            <!-- Which of them HubSpot will actually take. Said here, before
                 Check runs — it used to be a log line after the run, which is
                 why "13 accounts selected" sat above a run of "11 of 12". -->
            <span class="mg-selbar-split" id="mg-sel-split" hidden></span>
          </div>
```

- [ ] **Step 2: Style it**

In the Magellan `<style>` block in `public/index.html` (the one that opens at
`:710`), add after the `#mg-acct-detail` rule:

```css
        /* The allowlist split. Quiet by default; the blocked names are the
           part worth reading, so only they carry weight. */
        body[data-dashboard='v3'] .mg-selbar-split {
          display: block; width: 100%; margin-top: 7px;
          font-size: 12.5px; line-height: 1.6; color: var(--gray);
        }
        body[data-dashboard='v3'] .mg-selbar-split b { color: var(--ink); font-weight: 600; }
        body[data-dashboard='v3'] .mg-selbar-split .blk { font-family: ui-monospace, monospace; font-size: 12px; }
```

- [ ] **Step 3: Fill it**

In `public/js/app.js`, replace the body of `updateMagellanCounts` from
`set('mg-sel-count', mgSelected.size);` (`:27053`) to the end of the function
with:

```js
  set('mg-sel-count', mgSelected.size);
  const sub = document.getElementById('mg-sel-sub');
  if (sub) {
    sub.textContent = mgSelected.size === 1
      ? 'account selected · about a minute'
      : 'accounts selected · one at a time, roughly a minute each';
  }

  // What pressing Check would actually run. The HubSpot allowlist drops accounts
  // it has no option for; that used to surface only as a log line after the run.
  const chosen = mgAccounts.filter((a) => mgSelected.has(a.profileId));
  const sel = selectionSummary(chosen);
  const split = document.getElementById('mg-sel-split');
  if (split) {
    // Unknown (the portal could not be asked) or nothing to say — stay quiet
    // rather than guess which colleague's account is about to be skipped.
    const show = sel.known && sel.total > 0 && sel.blocked.length > 0;
    split.hidden = !show;
    split.innerHTML = show
      ? `<b>${sel.usable}</b> can go into HubSpot · `
        + `<b>${sel.blocked.length} need${sel.blocked.length === 1 ? 's' : ''} adding</b> to the `
        + '"Linkedin 1st Connections" list first: '
        + `<span class="blk">${sel.blocked.map(escHtml).join(', ')}</span>`
      : '';
  }
}
```

- [ ] **Step 4: Verify by hand in the app**

Reload with Cmd+R and open the Magellan tab. Press **Select all visible**.

Expected: under the count, a line reading
`12 can go into HubSpot · 1 needs adding to the "Linkedin 1st Connections" list first: jemely.butron@ortus.solutions`.
Untick that account and the line disappears. The numbers must add up to the
count above them.

- [ ] **Step 5: Commit**

```bash
git add public/js/app.js public/index.html
git commit -m "feat(magellan): the selection bar says what will actually run

'13 accounts selected' sat above a run of '11 of 12' because the HubSpot
allowlist split happened inside buildPreview and was only named in a log line
afterwards. The bar now shows the split before Check is pressed, and names the
accounts that need adding. Silent when the option list could not be read."
```

---

### Task 7: A finished run states its outcome

**Files:**
- Modify: `public/index.html` — add `#mg-outcome` inside `#mg-card`, plus its scoped rules
- Modify: `public/js/app.js` — `renderMagellanState` at `:27203+`

**Interfaces:**
- Consumes: `getState().outcome` from Task 2 — `{ok, summary, problems: string[]}` or `null`.
- Produces: nothing new.

- [ ] **Step 1: Add the block to the card**

In `public/index.html`, inside `#mg-card`, insert immediately **before** the
`<div class="vj-stage-accts" id="mg-accts" hidden></div>` line:

```html
            <!-- What happened, once it has happened. The card used to keep its
                 live counters after a run ended, so a finished Check read
                 "92% · 0 people so far". Written by the run itself, so it
                 cannot exist without the run having ended. -->
            <div class="mg-outcome" id="mg-outcome" hidden></div>
```

- [ ] **Step 2: Style it**

In the Magellan `<style>` block, add after the `.mg-selbar-split` rules from Task 6:

```css
        /* The outcome. One sentence, then the things worth knowing. Never a
           progress colour — a finished run is a record, not an activity. */
        body[data-dashboard='v3'] .mg-outcome {
          margin: 16px 0 2px; padding-top: 15px; border-top: 1px solid var(--hairline);
        }
        body[data-dashboard='v3'] .mg-outcome .oc-sum { font-size: 15px; font-weight: 600; line-height: 1.5; }
        body[data-dashboard='v3'] .mg-outcome.is-bad .oc-sum { color: var(--red); }
        body[data-dashboard='v3'] .mg-outcome .oc-list { margin: 9px 0 0; padding: 0; list-style: none; }
        body[data-dashboard='v3'] .mg-outcome .oc-list li {
          font-size: 13px; line-height: 1.62; color: var(--gray);
          padding-left: 15px; position: relative;
        }
        body[data-dashboard='v3'] .mg-outcome .oc-list li + li { margin-top: 5px; }
        body[data-dashboard='v3'] .mg-outcome .oc-list li::before {
          content: '·'; position: absolute; left: 3px;
        }
```

- [ ] **Step 3: Render it**

In `public/js/app.js`, inside `renderMagellanState`, add immediately after the
`if (s.stopped) set('mg-eyebrow', 'Stopped');` line (`:27270`):

```js
  // What happened. Only ever drawn from the run's own outcome record, which the
  // engine writes at the moment the run ends — so there is no way to render a
  // half-finished run's numbers as a final answer.
  const ocBox = el('mg-outcome');
  if (ocBox) {
    const oc = s.outcome;
    ocBox.hidden = !oc || !!s.running;
    ocBox.classList.toggle('is-bad', !!oc && oc.ok === false);
    ocBox.innerHTML = (oc && !s.running)
      ? `<div class="oc-sum">${escHtml(oc.summary)}</div>`
        + (oc.problems && oc.problems.length
          ? `<ul class="oc-list">${oc.problems.map((p) => `<li>${escHtml(p)}</li>`).join('')}</ul>`
          : '')
      : '';
  }
```

- [ ] **Step 4: Stop the live hero labels surviving the run**

Still in `renderMagellanState`, the `if (checking && s.running)` branch (`:27228`)
already guards on `s.running`, so a finished check falls through to the `else`
and reprints collect labels over stale numbers. Replace the condition of the
final `else` branch so a finished run with an outcome shows the accounts it
worked through rather than a people count it no longer has:

Replace:

```js
  } else {
    set('mg-people', people.toLocaleString());
    set('mg-people-lbl', 'people so far');
```

with:

```js
  } else {
    set('mg-people', people.toLocaleString());
    // "so far" is a promise of more to come. Once a run has ended there is no
    // more, and the outcome block below is where the real answer lives.
    set('mg-people-lbl', s.running ? 'people so far' : 'people');
```

- [ ] **Step 5: Verify by hand in the app**

Reload with Cmd+R. Tick two collected accounts, press **Check what would happen**,
and wait for it to finish.

Expected, in order:
1. While it runs: eyebrow `Checking`, one moving percentage, no outcome block.
2. The instant it finishes: eyebrow `Finished`, and a line such as
   `9,623 new · 15,545 already there`, with bullets beneath naming the duplicates
   and any skipped account.
3. At no point does the card read `Not running` with a percentage and no outcome.

Then press **Stop** during a second Check and confirm the outcome reads
`Stopped after N of M accounts — the rest weren’t asked about`.

- [ ] **Step 6: Commit**

```bash
git add public/js/app.js public/index.html
git commit -m "feat(magellan): a finished run says what happened

The card kept its live counters after a run ended, so a finished Check read
'92% · 0 people so far' — the live labels were still there because nothing
replaced them. It now renders the run's own outcome record: one sentence, then
one line per thing worth knowing. Hidden while running, so a half-finished run's
numbers can never be read as a final answer."
```

---

### Task 8: Take Merge off the screen

**Files:**
- Modify: `public/js/app.js` — delete `renderMagellanDupes` (`:27521-27581`), `mergeMagellanDupes` (`:27583-27604`), the `window.mergeMagellanDupes` export (`:27605`), the `let mgDupes = [];` declaration (`:27520`) and the `renderMagellanDupes(j.duplicates || [])` call (`:27508`)
- Modify: `public/index.html` — delete the `#mg-dupes` div (`:914`) and the `.dp*` / `.dpa*` / `.rec*` rules (`:725-771`)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing. `mergeDuplicates` in `src/connections/magellan-run.js`,
  `mergeContacts` in `hubspot-client.js`, `POST /api/magellan/merge-duplicates`
  in `server.js` and all their tests **stay exactly as they are**. Only the UI
  path to them is removed.

**Why:** merging cannot be undone in HubSpot, and for a few hundred people it
silently picks between two real email addresses — Alecx Bagatsolon has both
`alecx@ortusclub.com` (2021) and `alecx.bagatsolon@ortusclub.com` (2026).
The screen rendered that identically to Sam Adcock's harmless case of one real
address and one synthetic placeholder. The import never needed the merge:
`lookupByMemberIds` (`hubspot-client.js:141`) already writes the connection to
the record with a real email address. Duplicates stay a reported fact in the
outcome (Task 1).

- [ ] **Step 1: Delete the render call**

In `previewMagellan`, delete `:27508`:

```js
    renderMagellanDupes(j.duplicates || []);
```

- [ ] **Step 2: Delete the two functions and their state**

Delete `public/js/app.js:27515-27605` in full — the comment block starting
`// People HubSpot holds twice under one LinkedIn ID.`, `let mgDupes = [];`,
`function renderMagellanDupes(dupes) { … }`, `async function mergeMagellanDupes() { … }`
and `window.mergeMagellanDupes = mergeMagellanDupes;`.

Replace the whole span with one comment so the next reader knows this was a
decision, not an oversight:

```js
// Merging duplicates was removed from the screen on purpose. It cannot be undone
// in HubSpot, and for a few hundred people it silently picks between two real
// email addresses (Alecx Bagatsolon: alecx@ vs alecx.bagatsolon@) — rendered
// identically to the harmless one-real-one-synthetic case. The import never
// needed it: lookupByMemberIds already writes the connection to the record with
// a real email address. Duplicates are stated in the run's outcome instead.
// mergeDuplicates() and POST /api/magellan/merge-duplicates are still there,
// with their tests, if this is ever wanted back.
```

- [ ] **Step 3: Delete the markup**

In `public/index.html`, delete `:912-914`:

```html
          <!-- People HubSpot holds twice. Found by Check, fixed by its own
               button: merging is the one action here with no undo. -->
          <div id="mg-dupes" hidden></div>
```

- [ ] **Step 4: Delete the styles**

In the Magellan `<style>` block, delete every rule from the
`/* Duplicate people. One card per person… */` comment through
`body[data-dashboard='v3'] .dp-hint { … }` — `:723-771`. That is all `.dp-*`,
`.dpa*` and `.rec*` selectors plus `#mg-dupes`. Nothing else uses them:

```bash
grep -n "dp-\|dpa\|rec-mail\|rec-flag\|rec-when\|mg-dupes" public/js/app.js public/index.html
```

Expected after deleting: no matches.

- [ ] **Step 5: Verify by hand in the app**

Reload with Cmd+R and run a Check.

Expected: the ledger, the blocked-accounts box, the confirm line and the Import
button all still render. No duplicate list, no Merge button anywhere. The
duplicate count now appears only as a bullet under the outcome, worded as a fact.

Check the console is clean — a leftover call to a deleted function throws.

- [ ] **Step 6: Run the whole suite**

Run: `node --test tests/connections/ tests/magellan-view.test.js`
Expected: PASS. The merge tests in `tests/connections/magellan-run.test.js` still
pass — the engine is untouched.

- [ ] **Step 7: Bump the version and cache-bust**

In `package.json`, bump the patch version. In `public/index.html:4043`, bump the
`?v=` on the `app.js` script tag to match:

```html
  <script type="module" src="/js/app.js?v=3.1.27"></script>
```

Check for any other `?v=3.1.26` in `public/index.html` and bump those too:

```bash
grep -n "v=3\.1\.26" public/index.html
```

- [ ] **Step 8: Commit and relaunch**

```bash
git add public/js/app.js public/index.html package.json
git commit -m "feat(magellan): take Merge off the screen

Merging cannot be undone in HubSpot, and for a few hundred people it silently
picks between two real email addresses — Alecx Bagatsolon has alecx@ from 2021
and alecx.bagatsolon@ from 2026, rendered identically to Sam Adcock's harmless
one-real-one-synthetic case. The import never needed it: lookupByMemberIds
already writes the connection to the record with a real email address.

Duplicates remain a reported fact in the run's outcome. mergeDuplicates() and
POST /api/magellan/merge-duplicates stay in the codebase with their tests;
nothing in the UI calls them."

pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "Electron.*ortus" 2>/dev/null
npm run dev:app > /tmp/dev-app.log 2>&1 &
sleep 6; ps -eo pid,lstart,command | grep -i "[E]lectron.*ortus" | head -3
```

Expected: a start time within the last minute.

---

## Final verification

- [ ] **Run every test the change can reach**

```bash
node --test tests/connections/ tests/magellan-view.test.js tests/vjcard.test.js
```

Expected: PASS, no failures.

- [ ] **Walk the four original symptoms in the app**

1. Start a Check on two accounts. Watch it to completion without touching
   anything. At no point may the card read `Not running` / `Idle` while the
   Check button still says `Checking…`.
2. During the Check, read the card's big number and the button's number. They
   must be identical on every tick.
3. Before pressing Check, select all accounts. The bar must say how many can go
   into HubSpot and name the ones that cannot.
4. When the Check ends, the card must state what it found in one sentence, with
   the duplicates and any skipped account listed beneath it.
