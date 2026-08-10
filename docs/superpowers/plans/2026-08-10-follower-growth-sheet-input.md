# Follower Growth — sheet as input + company-page dropdown — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Follower Growth read its invite list from any Google Sheet the operator pastes (the way a CC campaign already does) and let the operator pick which company page to grow from a dropdown, without changing the Live status card.

**Architecture:** FG's fire path currently reads and writes through `fg-apps-script.js`, which is **container-bound** (`SpreadsheetApp.getActiveSpreadsheet()` on every handler) and therefore can only ever touch the one central FG spreadsheet. The main `google-apps-script.js` is `openById` and can touch any sheet. So the read moves to `fetchSheet(sheetUrl)` (public CSV, no Apps Script involved) and the ledger writeback moves to `updateSheetRow(sheetUrl, …)` on the main deployment — which first needs four new fields in its `FIELD_MAP`. The company page becomes a small registry consulted at dispatch time instead of a hardcoded constant.

**Tech Stack:** Node 20 ESM, Express 4, vanilla JS front-end (`public/js/app.js`), Google Apps Script (two separate deployments), `node --test` for tests.

## Global Constraints

- **Ortus behaviour must not change.** The default page resolves to today's `ORTUS_PAGE_INVITE_URL` constant, verbatim. A test pins this.
- **The Live status section is untouched.** `#fgw-step-live`, `#fgtl-acctboard`, `#fgtl-card` (the `vj-*` card), `#fgw-log` and the FG Master collapsible keep their markup, IDs, classes and behaviour. The only permitted edits are the step number on the badge and adding the page label to the eyebrow.
- **No silent fallback.** A launch with no list source is refused with an error. The app must never build a list that was not explicitly requested.
- Tests: `node --test tests/*.test.js`. Test files live in `tests/` and end `.test.js`. Use `node:test` + `node:assert/strict`, ESM imports.
- The invite URL must keep the `/posts/?feedView=all&invite=true` shape — a bare `/company/<slug>/` URL does not open the invite modal.
- Do not `git add data/monitoring-campaign.json` (tracked foot-gun).
- Version bump (`package.json` + all `?v=` in `public/index.html`) happens in the final task, not per-task.
- `public/index.html` is being edited in another session. Before editing it, re-locate anchors by searching for the quoted marker strings given in each task — **do not trust line numbers**.

---

### Task 1: Company-page registry

**Files:**
- Create: `src/fg-pages.js`
- Test: `tests/fg-pages.test.js`

**Interfaces:**
- Consumes: `ORTUS_PAGE_INVITE_URL` from `src/sheets-webapp-url.js`
- Produces: `FG_PAGES` (object keyed by page id), `pageById(id) -> { id, label, inviteUrl }`, `FG_PAGE_LIST` (array for the dropdown, Ortus first)

- [ ] **Step 1: Write the failing test**

Create `tests/fg-pages.test.js`:

```js
// The company page an FG run invites to. Picked from a dropdown in setup —
// never inferred from the login email or from which accounts were selected
// (Sam, 2026-08-10). Ortus is the default so doing nothing behaves as it
// always has.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FG_PAGES, FG_PAGE_LIST, pageById } from '../src/fg-pages.js';
import { ORTUS_PAGE_INVITE_URL } from '../src/sheets-webapp-url.js';

test('Ortus is the default and its URL is today\'s constant, verbatim', () => {
  // THE regression test. If this fails, an FG run is inviting to the wrong
  // page for every Ortus operator.
  assert.equal(pageById('ortus').inviteUrl, ORTUS_PAGE_INVITE_URL);
  assert.equal(FG_PAGE_LIST[0].id, 'ortus');
});

test('anything unrecognised falls back to Ortus', () => {
  for (const bad of ['', null, undefined, 'nonsense', 'APEX ', 42, {}]) {
    assert.equal(pageById(bad).id, 'ortus', String(bad));
    assert.equal(pageById(bad).inviteUrl, ORTUS_PAGE_INVITE_URL, String(bad));
  }
});

test('apex resolves to the Apex page', () => {
  assert.equal(pageById('apex').id, 'apex');
  assert.match(pageById('apex').inviteUrl, /apex-guesting-partner/);
});

test('every page URL has the shape that actually opens the invite modal', () => {
  // A bare /company/<slug>/ URL loads the page but not the modal.
  for (const p of FG_PAGE_LIST) {
    assert.match(p.inviteUrl, /^https:\/\/www\.linkedin\.com\/company\/[^/]+\/posts\/\?feedView=all&invite=true$/, p.id);
    assert.ok(p.label && p.label.trim(), `${p.id} needs a label`);
  }
});

test('FG_PAGE_LIST is FG_PAGES in order, with no duplicate ids', () => {
  const ids = FG_PAGE_LIST.map((p) => p.id);
  assert.deepEqual(ids, [...new Set(ids)]);
  assert.equal(ids.length, Object.keys(FG_PAGES).length);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/fg-pages.test.js`
Expected: FAIL — `Cannot find module '.../src/fg-pages.js'`

- [ ] **Step 3: Write minimal implementation**

Create `src/fg-pages.js`:

```js
// The LinkedIn company pages Follower Growth can grow.
//
// The page is an EXPLICIT choice in the wizard, not something derived. An
// earlier design resolved it from each account's SoO `Company` column; Sam
// asked for a dropdown instead (2026-08-10), which is simpler and means an
// account's org and the page it invites to are independent.
//
// Adding a page is one entry here. Ortus stays first and is the fallback for
// every unrecognised input, so an app that fails to send a page id behaves
// exactly as it did before this file existed.
import { ORTUS_PAGE_INVITE_URL } from './sheets-webapp-url.js';

export const FG_PAGES = {
  ortus: {
    id: 'ortus',
    label: 'Ortus Club',
    inviteUrl: ORTUS_PAGE_INVITE_URL,
  },
  apex: {
    id: 'apex',
    label: 'Apex Guesting Partner',
    // Same /posts/?feedView=all&invite=true shape as Ortus — that query is what
    // opens the invite modal; the bare /company/<slug>/ URL does not.
    inviteUrl: 'https://www.linkedin.com/company/apex-guesting-partner/posts/?feedView=all&invite=true',
  },
};

// Dropdown order. Ortus first = the default selection.
export const FG_PAGE_LIST = Object.values(FG_PAGES);

/**
 * Resolve a page id to its config. Never throws and never returns undefined:
 * an unknown, blank or malformed id resolves to Ortus, so a bad request can
 * only ever produce today's behaviour.
 * @param {string} id
 * @returns {{ id: string, label: string, inviteUrl: string }}
 */
export function pageById(id) {
  const key = String(id == null ? '' : id).trim().toLowerCase();
  return FG_PAGES[key] || FG_PAGES.ortus;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/fg-pages.test.js`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add src/fg-pages.js tests/fg-pages.test.js
git commit -m "feat(fg): company-page registry with Ortus as the safe default"
```

---

### Task 2: Turn `fetchSheet` output into the grid `parseListRows` expects

**Files:**
- Modify: `src/connections/fg-list.js` (add one exported function at the end)
- Test: `tests/fg-list-grid.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces: `gridFromSheetRows(rows) -> string[][]` — exported from `src/connections/fg-list.js`

**Why this task exists:** `fetchSheet(sheetUrl)` (`src/sheets.js:180`) returns `Record<string,string>[]` — one object per row, keyed by header. `parseListRows` (`src/connections/fg-list.js:191`) expects a 2-D grid whose row 0 is the header array. Without this adapter the two do not connect, and the mismatch would show up as "0 usable rows" rather than as a type error.

- [ ] **Step 1: Write the failing test**

Create `tests/fg-list-grid.test.js`:

```js
// fetchSheet() hands back one object per row keyed by header; parseListRows
// wants a 2-D grid with the header as row 0. This adapter is the join between
// them — get it wrong and every BYO sheet silently reads as empty.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { gridFromSheetRows, parseListRows } from '../src/connections/fg-list.js';

test('builds a header row plus one array per record', () => {
  const grid = gridFromSheetRows([
    { 'LinkedIn URL': 'https://www.linkedin.com/in/ada', 'Account Email': 'a@x.com' },
    { 'LinkedIn URL': 'https://www.linkedin.com/in/bob', 'Account Email': 'b@x.com' },
  ]);
  assert.deepEqual(grid, [
    ['LinkedIn URL', 'Account Email'],
    ['https://www.linkedin.com/in/ada', 'a@x.com'],
    ['https://www.linkedin.com/in/bob', 'b@x.com'],
  ]);
});

test('column order comes from the FIRST row and later rows follow it', () => {
  // Object key order can differ per record; the grid must stay rectangular or
  // parseListRows reads values out of the wrong column.
  const grid = gridFromSheetRows([
    { A: '1', B: '2' },
    { B: '4', A: '3' },
  ]);
  assert.deepEqual(grid, [['A', 'B'], ['1', '2'], ['3', '4']]);
});

test('a key missing from a later row becomes an empty cell, not a hole', () => {
  const grid = gridFromSheetRows([{ A: '1', B: '2' }, { A: '3' }]);
  assert.deepEqual(grid, [['A', 'B'], ['1', '2'], ['3', '']]);
});

test('non-string cells are stringified, null/undefined become empty', () => {
  const grid = gridFromSheetRows([{ A: 1, B: null }, { A: undefined, B: false }]);
  assert.deepEqual(grid, [['A', 'B'], ['1', ''], ['', 'false']]);
});

test('empty input gives an empty grid, not a crash', () => {
  assert.deepEqual(gridFromSheetRows([]), []);
  assert.deepEqual(gridFromSheetRows(null), []);
  assert.deepEqual(gridFromSheetRows(undefined), []);
});

test('a row whose Account Email is unknown is reported, not silently dropped', () => {
  // An operator will typo a sending address. That row must come back in
  // `skipped` with the reason, or the run quietly invites fewer people than
  // the sheet says and nobody finds out.
  const { leads, skipped } = parseListRows(
    gridFromSheetRows([{ 'LinkedIn URL': 'https://www.linkedin.com/in/ada', 'Account Email': 'typo@x.com' }]),
    { emailToProfileId: { 'a@x.com': 'p1' } },
  );
  assert.equal(leads.length, 0);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /unknown account email/i);
  assert.equal(skipped[0].rowNumber, 2);
});

test('end to end: a two-column BYO sheet parses into routed leads', () => {
  // The whole point of the feature — an operator's own sheet with only the two
  // required columns, in their own words, must produce leads.
  const rows = [
    { 'Profile URL': 'https://www.linkedin.com/in/ada', 'Sending Account': 'a@x.com' },
    { 'Profile URL': 'https://www.linkedin.com/in/bob', 'Sending Account': 'b@x.com' },
  ];
  const { leads, skipped } = parseListRows(gridFromSheetRows(rows), {
    emailToProfileId: { 'a@x.com': 'p1', 'b@x.com': 'p2' },
  });
  assert.equal(skipped.length, 0);
  assert.equal(leads.length, 2);
  assert.deepEqual(leads.map((l) => l.routeAccount).sort(), ['p1', 'p2']);
});
```

Note on the last test: `'profile url'` and `'sending account'` must be present in `HEADER_ALIASES` in `src/connections/fg-list.js`. Read that constant first. `url` already lists `'profile url'`. If `accountEmail` does not already list `'sending account'`, add it in Step 3 — it is exactly the kind of wording an operator will use.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/fg-list-grid.test.js`
Expected: FAIL — `gridFromSheetRows is not a function`

- [ ] **Step 3: Write minimal implementation**

Append to `src/connections/fg-list.js`:

```js
/**
 * Adapt fetchSheet()'s output to the grid parseListRows() reads.
 *
 * fetchSheet returns one object per row keyed by column header; parseListRows
 * (and the whole FG list path) works on a 2-D grid whose row 0 is the header.
 * The first record fixes the column order — object key order is not guaranteed
 * to be identical across records, and a ragged grid would make parseListRows
 * read values out of the wrong column rather than fail loudly.
 *
 * @param {Array<Record<string, unknown>>} rows
 * @returns {string[][]} header row first; [] when there is nothing to convert
 */
export function gridFromSheetRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return [];
  const header = Object.keys(list[0] || {});
  if (!header.length) return [];
  const cell = (v) => (v === null || v === undefined ? '' : String(v));
  return [header, ...list.map((r) => header.map((h) => cell((r || {})[h])))];
}
```

If `'sending account'` is absent from `HEADER_ALIASES.accountEmail`, add it to that array in the same edit.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/fg-list-grid.test.js`
Expected: PASS, 7 tests

- [ ] **Step 5: Run the whole suite — nothing else may break**

Run: `npm test`
Expected: the pre-existing pass count, plus the new tests. Note the baseline number before you start so you can compare.

- [ ] **Step 6: Commit**

```bash
git add src/connections/fg-list.js tests/fg-list-grid.test.js
git commit -m "feat(fg): adapt fetchSheet rows into the grid parseListRows reads"
```

---

### Task 3: Teach the main Apps Script the four FG ledger columns

**Files:**
- Modify: `google-apps-script.js` — `FIELD_MAP` (around line 307) and `ALL_MODE_COLUMNS_V2` / `MODE_COLUMNS_V2` (around lines 87–128)
- Test: `tests/apps-script-fg-fields.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces: the `updateRow` action accepts `fgStatus`, `fgInvitedAt`, `fgNote`, `fgMemberId` and routes them to the columns `Status`, `Invited At`, `Note`, `Member ID`

**Why this task exists — read before starting.** `writeFields` **ignores unknown fields silently**. FG's ledger fields are not in `FIELD_MAP`, so without this task Task 5's writeback would appear to succeed and write nothing. This is the highest-risk task in the plan for exactly that reason: the failure is invisible.

Field names are prefixed `fg*` deliberately. A bare `status` already means `'Connection Request Status'` in `FIELD_MAP`, and `Member ID` is not `LinkedIn Membership ID`. Reusing either name would cross FG's writeback with CC's.

- [ ] **Step 1: Write the failing test**

Create `tests/apps-script-fg-fields.test.js`, mirroring the vm-based pattern already used by `tests/apps-script-ensure-columns.test.js` (read that file first for the fake-sheet helper style):

```js
// Follower Growth stamps its results into the operator's OWN sheet through the
// main Apps Script's updateRow action. writeFields drops unknown fields
// SILENTLY, so a missing FIELD_MAP entry does not fail — it just never writes.
// These tests are the only thing standing between that and a run that reports
// success while stamping nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(__dirname, '..', 'google-apps-script.js'), 'utf8');

function load() {
  const ctx = { console, Session: { getScriptTimeZone: () => 'UTC' }, Utilities: { formatDate: () => '' } };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return ctx;
}

test('the four FG ledger fields map to their own columns', () => {
  const { FIELD_MAP } = load();
  assert.equal(FIELD_MAP.fgStatus, 'Status');
  assert.equal(FIELD_MAP.fgInvitedAt, 'Invited At');
  assert.equal(FIELD_MAP.fgNote, 'Note');
  assert.equal(FIELD_MAP.fgMemberId, 'Member ID');
});

test('FG fields do not collide with the CC fields that already exist', () => {
  const { FIELD_MAP } = load();
  // `status` is Connection Request Status and must stay that way; Member ID is
  // NOT LinkedIn Membership ID. Crossing these would stamp CC columns on an FG
  // run and vice versa.
  assert.equal(FIELD_MAP.status, 'Connection Request Status');
  assert.equal(FIELD_MAP.linkedinMemberId, 'LinkedIn Membership ID');
  assert.notEqual(FIELD_MAP.fgStatus, FIELD_MAP.status);
  assert.notEqual(FIELD_MAP.fgMemberId, FIELD_MAP.linkedinMemberId);
});

test('the FG columns are provisioned for the follower_growth mode only', () => {
  const { MODE_COLUMNS_V2, ALL_MODE_COLUMNS_V2 } = load();
  assert.deepEqual(MODE_COLUMNS_V2.follower_growth, ['Status', 'Invited At', 'Note', 'Member ID']);
  for (const col of ['Status', 'Invited At', 'Note', 'Member ID']) {
    assert.ok(ALL_MODE_COLUMNS_V2.includes(col), `${col} must be in ALL_MODE_COLUMNS_V2`);
  }
});

test('no other mode gained or lost a column', () => {
  const { MODE_COLUMNS_V2 } = load();
  // Pin the CC modes so an edit here cannot quietly change what a CC run
  // provisions on an operator's sheet.
  assert.deepEqual(MODE_COLUMNS_V2.connect_only, ['Connection Request Status']);
  assert.deepEqual(MODE_COLUMNS_V2.connect_and_introduce,
    ['Connection Request Status', 'Connection Accepted Status', 'Introduction Status']);
  assert.deepEqual(MODE_COLUMNS_V2.connect_and_message,
    ['Connection Request Status', 'Connection Accepted Status', 'DM Status']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/apps-script-fg-fields.test.js`
Expected: FAIL — `FIELD_MAP.fgStatus` is `undefined`

- [ ] **Step 3: Write minimal implementation**

In `google-apps-script.js`, inside `FIELD_MAP` (immediately before the closing `};` at roughly line 341, after the `ReplyPreview` entry) add:

```js
  ,
  // ── Follower Growth ledger (2026-08-10) ──
  // FG now fires from the operator's OWN sheet rather than a tab in the central
  // FG spreadsheet (fg-apps-script.js is container-bound and cannot reach it),
  // so its writeback comes through this deployment's updateRow action.
  // Prefixed `fg*` on purpose: bare `status` is already Connection Request
  // Status, and FG's `Member ID` is NOT LinkedIn Membership ID.
  fgStatus:        'Status',
  fgInvitedAt:     'Invited At',
  fgNote:          'Note',
  fgMemberId:      'Member ID'
```

In `MODE_COLUMNS_V2` add a final entry:

```js
  ,
  // Follower Growth: the four ledger columns stamped back into the operator's
  // own invite-list sheet.
  follower_growth: ['Status', 'Invited At', 'Note', 'Member ID']
```

Extend `ALL_MODE_COLUMNS_V2` with the same four names so a CC run on a sheet that once held an FG list hides them rather than leaving them visible:

```js
var ALL_MODE_COLUMNS_V2 = [
  'Connection Request Status', 'DM Status', 'OP Status',
  'InM Status', 'Intro Status', 'Connection Accepted Status',
  'Open Profile', 'Introduction Status',
  'Status', 'Invited At', 'Note', 'Member ID'
];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/apps-script-fg-fields.test.js`
Expected: PASS, 4 tests

- [ ] **Step 5: Confirm the existing Apps Script tests still pass**

Run: `node --test tests/apps-script-*.test.js`
Expected: PASS — in particular `apps-script-ensure-columns.test.js`, which guards against columns being deleted.

- [ ] **Step 6: Commit**

```bash
git add google-apps-script.js tests/apps-script-fg-fields.test.js
git commit -m "feat(apps-script): route the four FG ledger fields to their own columns"
```

- [ ] **Step 7: STOP — hand the redeploy to Antonio**

Editing `google-apps-script.js` in the repo changes nothing in production. The deployed web app at `SHEETS_WEBAPP_URL` must be updated by hand, by Antonio, under his Google account:

1. Open the Apps Script project behind `SHEETS_WEBAPP_URL` (`src/sheets-webapp-url.js`).
2. Paste the full contents of `google-apps-script.js`.
3. Deploy → **Manage deployments** → edit the existing deployment → **New version** → Deploy. Creating a *new* deployment mints a different `/exec` URL and would silently orphan every operator.
4. Verify by read-back, not by the deploy dialog: run a single FG list run end to end (Task 8) and confirm `Status` / `Invited At` land in the sheet. A stale deployment is this repo's most repeated failure mode.

Do not start Task 5 expecting production writeback to work until this is done. Tasks 4–7 can all be built and unit-tested before the redeploy.

---

### Task 4: Read the invite list from any sheet URL

**Files:**
- Modify: `server.js` — the `if (b.source === 'list')` branch inside `app.post('/api/fg/team-launch/start', …)`
- Test: `tests/fg-list-source.test.js`

**Interfaces:**
- Consumes: `gridFromSheetRows` (Task 2), `pageById` (Task 1)
- Produces: the route accepts `{ source: 'list', sheetUrl, pageId, pairs, target: 'cloud' }`; the run record gains `sheetUrl` and `pageId`

**Locate the code** by searching `server.js` for the string `Sheet-driven flow (new two-option FG)`. Line numbers in this repo shift between sessions.

- [ ] **Step 1: Write the failing test**

The route itself is not unit-testable without booting Express, so test the pure decision it makes. Create `tests/fg-list-source.test.js`:

```js
// Which source a launch request names, and what to do when it names none.
// The "none" case is the whole bug: today an absent source falls through to the
// roles builder and generates a list nobody asked for.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveListSource } from '../src/connections/fg-list-launch.js';

test('a sheet URL is accepted and carried through', () => {
  const r = resolveListSource({ source: 'list', sheetUrl: 'https://docs.google.com/spreadsheets/d/abc123/edit#gid=99' });
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'sheet');
  assert.equal(r.sheetUrl, 'https://docs.google.com/spreadsheets/d/abc123/edit#gid=99');
});

test('a legacy central-sheet tab name still works', () => {
  // The builder door still writes a tab in the central FG sheet, and Auto-Pilot
  // fires through it. Removing this would break the 1st & 15th cron.
  const r = resolveListSource({ source: 'list', tab: 'FG List 2026-08-15' });
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'tab');
  assert.equal(r.tab, 'FG List 2026-08-15');
});

test('a sheet URL wins when both are present', () => {
  const r = resolveListSource({ source: 'list', sheetUrl: 'https://docs.google.com/spreadsheets/d/abc123/edit', tab: 'Old tab' });
  assert.equal(r.kind, 'sheet');
});

test('NO source is refused — it must never build a list', () => {
  for (const body of [{}, { source: '' }, { source: 'list' }, { source: 'list', sheetUrl: '   ' }, null]) {
    const r = resolveListSource(body);
    assert.equal(r.ok, false, JSON.stringify(body));
    assert.match(r.error, /choose where the list comes from/i);
  }
});

test('a URL that is not a Google Sheet is refused with a useful message', () => {
  const r = resolveListSource({ source: 'list', sheetUrl: 'https://example.com/not-a-sheet' });
  assert.equal(r.ok, false);
  assert.match(r.error, /Google Sheet/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/fg-list-source.test.js`
Expected: FAIL — `resolveListSource is not a function`

- [ ] **Step 3: Write minimal implementation**

Add to `src/connections/fg-list-launch.js`:

```js
import { spreadsheetIdFromUrl } from '../utils.js';

/**
 * Decide where a launch's invite list comes from.
 *
 * Two doors, and NO third: an absent source is an error, never a licence to
 * build one. Before 2026-08-10 a request with no `source` fell through to the
 * roles builder, which is why an operator who had prepared a list offline kept
 * getting a freshly generated one instead.
 *
 * @param {object} body  the launch request body
 * @returns {{ ok: true, kind: 'sheet', sheetUrl: string }
 *          |{ ok: true, kind: 'tab', tab: string }
 *          |{ ok: false, error: string }}
 */
export function resolveListSource(body) {
  const b = body || {};
  const sheetUrl = String(b.sheetUrl || '').trim();
  const tab = String(b.tab || '').trim();

  if (sheetUrl) {
    if (!spreadsheetIdFromUrl(sheetUrl)) {
      return { ok: false, error: `That does not look like a Google Sheet link: ${sheetUrl}` };
    }
    return { ok: true, kind: 'sheet', sheetUrl };
  }
  if (tab) return { ok: true, kind: 'tab', tab };

  return {
    ok: false,
    error: 'Choose where the list comes from — paste a Google Sheet link, or build one from the team\'s connections.',
  };
}
```

Then rewrite the head of the `source === 'list'` branch in `server.js`. Replace the existing `const tab = …; let rows; try { rows = await readFgList(tab); } …` block with:

```js
      const owner = getOperatorEmail() || req.user || '';
      const runKey = b.cycleKey || fgNextRunCycleKey(b.days);
      const page = pageById(b.pageId);

      const src = resolveListSource(b);
      if (!src.ok) return res.status(400).json({ error: src.error });

      // The operator's OWN sheet (src.kind === 'sheet') is read straight over
      // the public CSV endpoint — no Apps Script involved, so it works on any
      // spreadsheet. The legacy tab path still goes through the container-bound
      // FG script, which can only ever see the central FG spreadsheet.
      let rows;
      const label = src.kind === 'sheet' ? src.sheetUrl : `tab "${src.tab}"`;
      try {
        rows = src.kind === 'sheet'
          ? gridFromSheetRows(await fetchSheet(src.sheetUrl))
          : await readFgList(src.tab);
      } catch (e) {
        return res.status(502).json({ error: `Could not read ${label}: ${e.message}` });
      }
      if (!rows || rows.length < 2) {
        const n = Array.isArray(rows) ? rows.length : 0;
        return res.status(400).json({
          error: n === 0
            ? `Nothing came back from ${label}. If the sheet is private, share it "anyone with the link can view" and try again.`
            : `${label} has a header but no people in it.`,
        });
      }
```

Then in the same branch, pass the page through to the campaign config and store the source on the run record. Change the `dispatchFromRows` call's `config` to:

```js
        campaign: { name: `Team Follower Growth · ${runKey}`, owner,
                    config: { inviteUrl: page.inviteUrl, pageId: page.id, pageLabel: page.label,
                              monthlyBudget: FG_DEFAULT_MONTHLY_ALLOWANCE } },
```

and in the `_fgCloudRunStore.add({ … })` call add, alongside the existing `tab`:

```js
        sheetUrl: src.kind === 'sheet' ? src.sheetUrl : '',
        pageId: page.id, pageLabel: page.label,
```

Keep `tab` in the record — set it to `src.tab || ''` — so old records and the builder door still reconcile.

Add to the imports at the top of `server.js`:

```js
import { pageById } from './src/fg-pages.js';
```

extend the existing `fg-list.js` import to include `gridFromSheetRows`, extend the `fg-list-launch.js` import to include `resolveListSource`, and confirm `fetchSheet` is already imported from `./src/sheets.js` (it is — the CC path uses it).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/fg-list-source.test.js`
Expected: PASS, 5 tests

- [ ] **Step 5: Confirm the server still boots**

Run: `node --check server.js && npm test`
Expected: no syntax error; suite at or above the Task 2 baseline.

- [ ] **Step 6: Commit**

```bash
git add server.js src/connections/fg-list-launch.js tests/fg-list-source.test.js
git commit -m "feat(fg): fire from any pasted Google Sheet, and refuse a launch with no source"
```

---

### Task 5: Stamp the ledger back into the operator's own sheet

**Files:**
- Modify: `server.js` — `async function reconcileListRun(record)`
- Test: `tests/fg-ledger-writeback.test.js`

**Interfaces:**
- Consumes: `ledgerUpdatesFromLeads` (existing, `src/connections/fg-list.js`), the `sheetUrl` field added to run records in Task 4
- Produces: `fgLedgerTracking(update) -> { fgStatus, fgInvitedAt, fgNote, fgMemberId }` — exported from `src/connections/fg-list.js`

**Locate the code** by searching `server.js` for `Sheet-driven (list) run reconcile`.

**Depends on Task 3 being deployed** for the production effect. The unit test below passes regardless; the end-to-end check in Task 8 does not.

- [ ] **Step 1: Write the failing test**

Create `tests/fg-ledger-writeback.test.js`:

```js
// ledgerUpdatesFromLeads speaks FG's own vocabulary ({url,status,invitedAt,
// note,memberId}); the main Apps Script's updateRow speaks FIELD_MAP keys.
// This is the translation between them. It has to be exact — writeFields drops
// unknown keys without complaining, so a typo here writes nothing at all and
// reports success.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fgLedgerTracking, ledgerUpdatesFromLeads } from '../src/connections/fg-list.js';

test('an invited lead translates to all four FIELD_MAP keys', () => {
  const [u] = ledgerUpdatesFromLeads([
    { leadUrl: 'https://www.linkedin.com/in/ada', stage: 'Invited', sentAt: '2026-08-10T09:00:00.000Z' },
  ]);
  const t = fgLedgerTracking(u);
  assert.equal(t.fgStatus, 'Invited');
  assert.ok(t.fgInvitedAt, 'an invited row must carry a timestamp');
  assert.equal(typeof t.fgNote, 'string');
  assert.equal(typeof t.fgMemberId, 'string');
});

test('a skipped lead carries its reason into the Note column', () => {
  const [u] = ledgerUpdatesFromLeads([
    { leadUrl: 'https://www.linkedin.com/in/bob', status: 'skipped', error: 'already follows' },
  ]);
  const t = fgLedgerTracking(u);
  assert.equal(t.fgStatus, 'Skipped');
  assert.equal(t.fgNote, 'already follows');
});

test('a failed lead is Failed, not silently Skipped', () => {
  const [u] = ledgerUpdatesFromLeads([
    { leadUrl: 'https://www.linkedin.com/in/cy', status: 'error', error: 'profile not found' },
  ]);
  assert.equal(fgLedgerTracking(u).fgStatus, 'Failed');
});

test('missing optional fields become empty strings, never undefined', () => {
  // undefined would be dropped from the JSON POST body entirely, leaving a
  // stale value in the cell from a previous run.
  const t = fgLedgerTracking({ url: 'https://www.linkedin.com/in/dee', status: 'Skipped' });
  assert.equal(t.fgInvitedAt, '');
  assert.equal(t.fgNote, '');
  assert.equal(t.fgMemberId, '');
});

test('the keys are exactly the four FG FIELD_MAP keys and nothing else', () => {
  const t = fgLedgerTracking({ url: 'https://www.linkedin.com/in/dee', status: 'Invited' });
  assert.deepEqual(Object.keys(t).sort(), ['fgInvitedAt', 'fgMemberId', 'fgNote', 'fgStatus']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/fg-ledger-writeback.test.js`
Expected: FAIL — `fgLedgerTracking is not a function`

- [ ] **Step 3: Write minimal implementation**

Append to `src/connections/fg-list.js`:

```js
/**
 * Translate one ledgerUpdatesFromLeads() entry into the tracking object the
 * main Apps Script's `updateRow` action understands.
 *
 * Every key is always present, as a string. An absent key would be dropped
 * from the JSON body and leave whatever a previous run wrote in the cell —
 * which reads as "this row was never touched" when in fact it was.
 *
 * @param {{status?:string, invitedAt?:string, note?:string, memberId?:string}} u
 * @returns {{fgStatus:string, fgInvitedAt:string, fgNote:string, fgMemberId:string}}
 */
export function fgLedgerTracking(u) {
  const s = (v) => (v === null || v === undefined ? '' : String(v));
  return {
    fgStatus:    s((u || {}).status),
    fgInvitedAt: s((u || {}).invitedAt),
    fgNote:      s((u || {}).note),
    fgMemberId:  s((u || {}).memberId),
  };
}
```

In `server.js`, replace the ledger-stamp block inside `reconcileListRun` — currently:

```js
  const updates = ledgerUpdatesFromLeads(leads);
  if (updates.length) {
    const r = await updateFgListLedger(record.tab, updates);
    try { campaignLog(`[FG-cloud] list ledger "${record.tab}": stamped ${r.updated} row(s)`); } catch (_) {}
  }
```

with:

```js
  const updates = ledgerUpdatesFromLeads(leads);
  if (updates.length) {
    if (record.sheetUrl) {
      // The operator's own sheet — one updateRow per changed row through the
      // MAIN Apps Script (openById, so it can reach any spreadsheet). The FG
      // script cannot: it is container-bound to the central FG spreadsheet.
      // Sequential on purpose — Apps Script serialises writes to one sheet
      // anyway, and a burst just earns 429s.
      let ok = 0;
      for (const u of updates) {
        try {
          if (await updateSheetRow(record.sheetUrl, u.url, fgLedgerTracking(u), '')) ok += 1;
        } catch (e) {
          try { campaignLog(`[FG-cloud] ledger row failed (${u.url}): ${e.message}`); } catch (_) {}
        }
      }
      try { campaignLog(`[FG-cloud] list ledger → operator sheet: stamped ${ok}/${updates.length} row(s)`); } catch (_) {}
    } else {
      const r = await updateFgListLedger(record.tab, updates);
      try { campaignLog(`[FG-cloud] list ledger "${record.tab}": stamped ${r.updated} row(s)`); } catch (_) {}
    }
  }
```

Extend the `fg-list.js` import in `server.js` to include `fgLedgerTracking`, and confirm `updateSheetRow` is imported from `./src/sheets-writer.js` (the CC writeback path already imports it).

Note the empty `linkedinColumn` argument: `updateSheetRow` falls back to finding the URL column itself when it is blank, which is what a BYO sheet needs since its URL header could be any alias.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/fg-ledger-writeback.test.js`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add server.js src/connections/fg-list.js tests/fg-ledger-writeback.test.js
git commit -m "feat(fg): stamp Status/Invited At/Note/Member ID into the operator's own sheet"
```

---

### Task 6: The page dropdown and the two doors in the UI

**Files:**
- Modify: `public/index.html` — the FG wizard's step 1 and step 2
- Modify: `public/js/app.js` — `fgtlUseByoTab`, `fgtlLaunch`, `fgapRunNow`, `fgtlLoadTabs`
- Reference: `public/fg-sketch-b.html` — the approved layout, built from the real CSS

**Interfaces:**
- Consumes: `GET /api/fg/pages` (added in this task), the request shape from Task 4
- Produces: the launch request body `{ source: 'list', sheetUrl, pageId, pairs, target }`

**Locate the markup** by searching `public/index.html` for these exact strings — not by line number:
- `STEP 1 · WHO TO INVITE` — the block to replace
- `id="fgw-step-review"` — the review-gate step to delete
- `rv-byo-line` — the "use a tab you filled in yourself" line to delete
- `LIVE STATUS` — **the boundary. Nothing at or after this may change except the `fgw-num` badge text.**

- [ ] **Step 1: Add the pages endpoint and verify it by hand**

In `server.js`, beside the other `/api/fg/*` routes:

```js
// The company pages FG can grow. Static, but served so the dropdown and the
// launch path can never disagree about the ids.
app.get('/api/fg/pages', (_req, res) => {
  res.json({ pages: FG_PAGE_LIST.map((p) => ({ id: p.id, label: p.label })) });
});
```

Add `FG_PAGE_LIST` to the `src/fg-pages.js` import.

Run: `npm start` then `curl -s localhost:3000/api/fg/pages`
Expected: `{"pages":[{"id":"ortus","label":"Ortus Club"},{"id":"apex","label":"Apex Guesting Partner"}]}` — Ortus first.

- [ ] **Step 2: Replace step 1 with the page dropdown**

Take the markup verbatim from `public/fg-sketch-b.html` (the `sk-page` block and its `fgw-step` wrapper), and its CSS from the same file's `<style>` — the `#nav-follower-growth .sk-page*` rules. Populate the `<select>` from `/api/fg/pages` on load; select `ortus` when nothing is stored.

- [ ] **Step 3: Replace the list step with the two doors**

Again from `fg-sketch-b.html`: the two `.sk-door` blocks, the `.sk-url` input, and the format note. Delete the roles chips (`#fgtl-chips`, `#fgtl-presets`, `.filter-foot`), the whole `#fgw-step-review` step, and the `rv-byo-line` paragraph with `#fg-byo-panel`.

Keep `#fgtl-search`, `#fgtl-people`, `#fgtl-ready` and the hidden `.fgtl-cart` — the accounts panel and the launch plumbing depend on them.

- [ ] **Step 4: Persist the choices and delete the fallback**

In `public/js/app.js`:

```js
// The chosen sheet + page survive a reload. _fgtlListTab was in-memory only,
// so a restart silently reverted a bring-your-own list to the roles builder —
// the single most confusing thing about the old flow.
const FG_STORE_KEY = 'fg.launch.source.v1';

function fgLoadSource() {
  try { return JSON.parse(localStorage.getItem(FG_STORE_KEY) || '{}') || {}; }
  catch (_) { return {}; }
}
function fgSaveSource(patch) {
  const next = { ...fgLoadSource(), ...patch };
  try { localStorage.setItem(FG_STORE_KEY, JSON.stringify(next)); } catch (_) {}
  return next;
}
```

In `fgtlLaunch`, replace:

```js
  const listPayload = _fgtlListTab ? { source: 'list', tab: _fgtlListTab } : {};
```

with:

```js
  // No source → refuse here, and let the server refuse too. There is no third
  // branch: the app must never build a list nobody asked for.
  const saved = fgLoadSource();
  if (!saved.sheetUrl && !saved.tab) {
    alert('Choose where the list comes from first — paste a Google Sheet link, or build one from the team\'s connections.');
    if (goBtn) goBtn.disabled = false;
    return;
  }
  const listPayload = { source: 'list', sheetUrl: saved.sheetUrl || '', tab: saved.tab || '', pageId: saved.pageId || 'ortus' };
```

Apply the same guard and the same `pageId` to `fgapRunNow`'s POST body, and add the page label to its confirm dialog:

```js
  if (!confirm(`Invite ${n} people to follow ${pageLabel}? This dispatches to the cloud VM immediately.`)) return;
```

- [ ] **Step 5: Check it against the sketch, in the app**

Run: `npm start`, open the FG section, and compare side by side with `http://localhost:8848/fg-sketch-b.html`.

Verify by hand:
1. The page dropdown shows both pages, Ortus selected.
2. Pasting a sheet URL, reloading the app, and reopening FG keeps the URL and the page.
3. With nothing chosen, **Run it now** refuses and no list is generated. Confirm by watching the log — no `buildFgTargets` activity.
4. The Live status card, log, per-account board and FG Master collapsible look and behave exactly as before.

- [ ] **Step 6: Commit**

```bash
git add public/index.html public/js/app.js server.js
git commit -m "feat(fg): page dropdown, two-door list source, persisted across reloads"
```

---

### Task 7: Show which page a run is inviting to

**Files:**
- Modify: `public/js/app.js` — the FG card status builder (`_fgtlBuildCloudStatus`) and `fgtlRenderCard`
- Modify: `server.js` — the `campaignLog` line at dispatch in the `source === 'list'` branch

**Interfaces:**
- Consumes: `pageLabel` on the campaign config (Task 4)
- Produces: nothing downstream

The dropdown makes it possible to point an Ortus account at the Apex page. Nothing blocks that — Sam wants the freedom — but a wrong pick must be obvious in seconds rather than after 400 invites.

- [ ] **Step 1: Log the page at dispatch**

In the `source === 'list'` branch of `/api/fg/team-launch/start`, immediately after a successful `dispatchFromRows`:

```js
      try { campaignLog(`[FG-cloud] inviting ${out.leadCount} people to follow ${page.label} (${page.inviteUrl})`); } catch (_) {}
```

- [ ] **Step 2: Put the label in the card eyebrow**

`#fgtl-eyebrow` currently reads "Ready to launch" / the run status. Append the page label when the campaign config carries one:

```js
  // Which page this run invites to. An FG run pointed at the wrong page is
  // indistinguishable from a correct one until the invites land, so it is
  // stated on the card rather than left implicit.
  const pageLabel = (campaign && campaign.config && campaign.config.pageLabel) || '';
  if (pageLabel) status.eyebrow = `${status.eyebrow} · ${pageLabel}`;
```

This is the one permitted edit inside the Live status block. Do not restructure the card.

- [ ] **Step 3: Verify by hand**

Run: `npm start`, dispatch an FG run with **Apex Guesting Partner** selected.
Expected: the card eyebrow reads `… · Apex Guesting Partner`, and the log's first FG line names the page and its URL.

- [ ] **Step 4: Commit**

```bash
git add public/js/app.js server.js
git commit -m "feat(fg): state the target page on the live card, the log and the confirm"
```

---

### Task 8: End-to-end verification and release

**Files:**
- Modify: `package.json` (version), `public/index.html` (every `?v=` occurrence)

This task is the one that catches a stale Apps Script deployment. Do not skip it.

- [ ] **Step 1: Run the whole suite**

Run: `npm test`
Expected: all new tests pass; the pre-existing failure set is unchanged from the baseline noted in Task 2. Report the before/after counts.

- [ ] **Step 2: End-to-end, on a real sheet, with a real account**

1. Make a Google Sheet with two columns — `LinkedIn URL`, `Account Email` — and **three** rows, using an account that has FG credits left.
2. Share it "anyone with the link can view".
3. Paste its URL into door 1. Pick **Ortus Club**.
4. Run it now.
5. Watch the campaign log: it must name Ortus Club and the lead count.
6. When the run reconciles, open the sheet.

Expected: `Status`, `Invited At`, `Note` and `Member ID` columns now exist and are filled, **in your sheet**, and no new tab was created anywhere.

**If the columns do not appear:** the main Apps Script was not redeployed (Task 3, Step 7), or a new deployment was created instead of a new version of the existing one. Check that first — `writeFields` drops unknown fields silently, so nothing will have errored.

- [ ] **Step 3: Confirm the Ortus path is unchanged**

Run an FG launch through door 2 (build one for me) with the page left on Ortus.
Expected: identical behaviour to before this work — a tab written in the central FG sheet, invites to the Ortus page, FG Invites updated.

- [ ] **Step 4: Bump the version**

Patch-bump `package.json`, and update **every** `?v=` occurrence in `public/index.html` to match. Operators run a packaged app; an unbumped asset query means they keep the cached old `app.js`.

- [ ] **Step 5: Commit**

```bash
git add package.json public/index.html
git commit -m "chore: bump version for FG sheet-input release"
```

---

## What this plan does NOT do

Stated so a reviewer does not read them as omissions:

- **The roles builder stays.** Door 2 still searches the connections DB and still writes a tab in the central FG spreadsheet via `writeFgList`. Auto-Pilot's scheduled runs go through `generateListRows` and are untouched — deleting the builder would break the 1st & 15th cron. Antonio decided to keep it (2026-08-10).
- **The FG Invites de-dupe ledger stays central.** `markFgInvited` still writes to the central FG sheet after every run. A per-run sheet has no memory of what other runs invited, so this is the one part that cannot go fully offline. Sam should be told.
- **No access isolation.** Every operator sees and can run every page. Sam accepted this explicitly.
- **Nothing pairs a page with an account's org.** An Ortus account can be pointed at the Apex page. Task 7 makes that visible; it does not prevent it.
