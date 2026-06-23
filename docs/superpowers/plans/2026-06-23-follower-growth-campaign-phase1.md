# Follower Growth Campaign — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Follower Growth campaign type that builds a per-operator, function-filtered, DNC-safe, budget-capped LinkedIn-page-follow invite list from the Connections DB, writes it to a purpose-built central FG sheet, surfaces it as an in-app database view, and reports invites sent. No invite-click automation in Phase 1 (manual click = the fallback).

**Architecture:** Reuse the existing Connections DB join (`src/connections/match.js` + `search-service.js`) as the source. Add a per-operator scope (`warmVia`) + dedupe + budget cap to produce FG rows. A new central FG sheet (3 tabs) is the cross-operator backend, reached via its own Apps Script web app (operators run separate app installs, so a central sheet is the only shared state). The campaign-tab UI renders that sheet as an in-app DB view.

**Tech Stack:** Node ≥22, Express 4, vanilla JS (ESM, no bundler), `node --test`. New central FG Apps Script (Google Apps Script). Monochrome Bugatti CSS.

**Spec:** `docs/superpowers/specs/2026-06-23-follower-growth-campaign-design.md`

---

## File Structure

| File | Create/Modify | Responsibility |
|---|---|---|
| `src/connections/fg-export.js` | Create | `FG_HEADER`, `fgRow()`, `functionMatch()`, `inviteKey()` — the FG Invites row schema + pure helpers. Mirror of `export.js`. |
| `src/connections/search-service.js` | Modify | Add `buildFgTargets()` — operator-scoped, function-filtered, DNC-safe, deduped, budget-capped target builder. Reuses the memoized `getAnnotated`/`getColleagues`. |
| `src/connections/fg-sync.js` | Create | Central FG sheet I/O via its own web app: `getFgState()`, `queueFgInvites()`, `markFgInvited()`, plus `FG_DEFAULT_MONTHLY_ALLOWANCE`. Mirror of `drive-sync.js`'s 302-safe `postWebApp`. |
| `src/sheets-webapp-url.js` | Modify | Add the hard-coded `FG_WEBAPP_URL` constant (placeholder until the FG Apps Script is deployed). |
| `server.js` | Modify | Add `/api/fg/db`, `/api/fg/build`, `/api/fg/queue`, `/api/fg/mark-invited` routes + an `fgCriteria()` helper. |
| `fg-apps-script.js` | Create | The new central FG Apps Script (3-tab sheet: `FG Invites` / `FG Budgets` / `FG Funnel`). Antonio pastes + deploys; its URL goes in `sheets-webapp-url.js`. |
| `public/index.html` | Modify | Follower Growth campaign type + in-app FG database view markup. |
| `public/js/app.js` | Modify | FG client: build → queue → mark-invited flow, budget meter, DB view render. |
| `public/css/style.css` | Modify | FG view styles (monochrome Bugatti). |
| `tests/connections/fg-export.test.js` | Create | Unit tests for `fgRow`/`functionMatch`/`inviteKey`. |
| `tests/connections/fg-targets.test.js` | Create | Unit tests for `buildFgTargets` (scope, filter, dedupe, budget, DNC). |
| `tests/connections/fg-sync.test.js` | Create | Smoke tests: exports present + graceful error when URL unset. |

DNC handling, `matchesCriteria`, and the slug→colleague join are reused unchanged. The function/title filter rides the existing `jobTitles` chip mechanism (`matchesCriteria` already does substring `hasAny` on `jobtitle`), so no new matching logic is needed — "marketers" is just a pre-seeded set of title keywords.

---

## Task 1: FG Invites row schema + pure helpers (`fg-export.js`)

**Files:**
- Create: `src/connections/fg-export.js`
- Test: `tests/connections/fg-export.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/connections/fg-export.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FG_HEADER, fgRow, functionMatch, inviteKey } from '../../src/connections/fg-export.js';

const MARKETER_KEYWORDS = ['marketing', 'brand', 'growth', 'content', 'demand', 'comms', 'cmo'];

test('FG_HEADER is the agreed 13-column order', () => {
  assert.deepEqual(FG_HEADER, [
    'Target Name', 'LinkedIn URL', 'Member ID', 'Company', 'Job Title',
    'Function Match', 'Geo', 'Invited By', 'Account', 'Status',
    'Invited At', 'FG Note', 'Month',
  ]);
});

test('functionMatch returns the first matching keyword, case-insensitive', () => {
  assert.equal(functionMatch('Head of Brand Marketing', MARKETER_KEYWORDS), 'marketing');
  assert.equal(functionMatch('Chief Marketing Officer', MARKETER_KEYWORDS), 'marketing');
  assert.equal(functionMatch('Software Engineer', MARKETER_KEYWORDS), '');
  assert.equal(functionMatch('', MARKETER_KEYWORDS), '');
});

test('inviteKey prefers Member ID, falls back to URL', () => {
  assert.equal(inviteKey({ linkedin_membership_id: '4185', linkedinbio: 'https://x/in/a' }), '4185');
  assert.equal(inviteKey({ linkedin_membership_id: '', linkedinbio: 'https://x/in/a' }), 'https://x/in/a');
  assert.equal(inviteKey({}), '');
});

test('fgRow builds a rectangular all-string row in FG_HEADER order', () => {
  const record = { contact: {
    firstname: 'Alice', lastname: 'Ng', linkedinbio: 'https://x/in/alice',
    linkedin_membership_id: '41857001', company: 'Acme', jobtitle: 'Head of Growth',
    city: 'London', state: '', country: 'United Kingdom',
  } };
  const row = fgRow(record, {}, { operatorName: 'Sam', account: 'sam@li', month: '2026-06', keywords: MARKETER_KEYWORDS });
  assert.equal(row.length, FG_HEADER.length);
  assert.ok(row.every((c) => typeof c === 'string'));
  assert.equal(row[0], 'Alice Ng');
  assert.equal(row[2], '41857001');
  assert.equal(row[5], 'growth');          // Function Match
  assert.equal(row[6], 'London, United Kingdom'); // Geo (city, country; empty state dropped)
  assert.equal(row[7], 'Sam');             // Invited By
  assert.equal(row[8], 'sam@li');          // Account
  assert.equal(row[9], 'Queued');          // Status defaults to Queued
  assert.equal(row[10], '');               // Invited At blank while queued
  assert.equal(row[12], '2026-06');        // Month
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/connections/fg-export.test.js`
Expected: FAIL — `Cannot find module '.../fg-export.js'`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/connections/fg-export.js
// FG Invites row schema + pure helpers for the Follower Growth campaign.
// One row per target × operator, written to the central FG sheet's `FG Invites`
// tab. Every cell is coerced to a string (Apps Script setValues needs
// rectangular string data — no undefineds). Mirror of export.js.

// Column order of the `FG Invites` tab. KEEP IN SYNC with fg-apps-script.js.
export const FG_HEADER = [
  'Target Name', 'LinkedIn URL', 'Member ID', 'Company', 'Job Title',
  'Function Match', 'Geo', 'Invited By', 'Account', 'Status',
  'Invited At', 'FG Note', 'Month',
];

// Which function/title keyword matched this job title (first hit), for the
// Function Match column. v1 function filter = keyword-on-title.
export function functionMatch(jobTitle, keywords = []) {
  const t = (jobTitle || '').toLowerCase();
  return keywords.find((k) => t.includes(String(k).toLowerCase())) || '';
}

// Dedupe identity for a contact: numeric Member ID when present (the load-bearing
// identifier), else the raw LinkedIn URL. Used both to dedupe a build against
// already-invited rows and by the Apps Script to reject duplicate queue writes.
export function inviteKey(contact = {}) {
  return String(contact.linkedin_membership_id || '') || (contact.linkedinbio || '');
}

// One `FG Invites` row in FG_HEADER order. `record` is an annotated row
// ({ contact, warmVia, ... }); operatorName/account/month come from the campaign.
export function fgRow(record, colleagues = {}, { operatorName = '', account = '', month = '', keywords = [], status = 'Queued', note = '' } = {}) {
  const c = record.contact || {};
  const geo = [c.city, c.state, c.country].filter(Boolean).join(', ');
  return [
    `${c.firstname || ''} ${c.lastname || ''}`.trim(),
    c.linkedinbio || '',
    c.linkedin_membership_id || '',
    c.company || '',
    c.jobtitle || '',
    functionMatch(c.jobtitle, keywords),
    geo,
    operatorName,
    account,
    status,
    '',     // Invited At — stamped when marked invited
    note,   // FG Note
    month,
  ].map((v) => (v == null ? '' : String(v)));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/connections/fg-export.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/connections/fg-export.js tests/connections/fg-export.test.js
git commit -m "feat(fg): FG Invites row schema + pure helpers"
```

---

## Task 2: Per-operator target builder (`buildFgTargets`)

**Files:**
- Modify: `src/connections/search-service.js` (add `buildFgTargets`; import from `fg-export.js`)
- Test: `tests/connections/fg-targets.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/connections/fg-targets.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildFgTargets } from '../../src/connections/search-service.js';

// Two operators' networks: alice@ and bob@ . Carol is connected via BOTH.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-targets-'));
const dir = path.join(tmp, 'connections');
fs.mkdirSync(dir, { recursive: true });
const cachePath = path.join(tmp, 'cache.json');

const HDR = 'First Name,Last Name,URL,Email Address,Company,Position,Connected On\n';
fs.writeFileSync(path.join(dir, 'alice@ortus.solutions.csv'),
  `Notes:\n\n${HDR}` +
  `Mara,Lee,https://www.linkedin.com/in/mara-m,,Acme,Head of Marketing,01 Jan 2025\n` +
  `Carol,Fox,https://www.linkedin.com/in/carol-c,,Globex,Engineer,01 Jan 2025\n` +
  `Dan,Roe,https://www.linkedin.com/in/dan-d,,Initech,Brand Lead,01 Jan 2025\n`);
fs.writeFileSync(path.join(dir, 'bob@ortus.solutions.csv'),
  `Notes:\n\n${HDR}` +
  `Carol,Fox,https://www.linkedin.com/in/carol-c,,Globex,Engineer,01 Jan 2025\n`);

fs.writeFileSync(cachePath, JSON.stringify({
  builtAt: '2026-06-23T00:00:00.000Z', slugsProcessed: 4, totalSlugs: 4,
  contacts: [
    { id: '1', firstname: 'Mara', lastname: 'Lee', linkedinbio: 'https://www.linkedin.com/in/mara-m', linkedin_membership_id: '100', company: 'Acme', jobtitle: 'Head of Marketing', country: 'United Kingdom', state: '', city: 'London', hs_lead_status: 'OPEN', lastmodifieddate: '1' },
    { id: '2', firstname: 'Carol', lastname: 'Fox', linkedinbio: 'https://www.linkedin.com/in/carol-c', linkedin_membership_id: '200', company: 'Globex', jobtitle: 'Engineer', country: 'United Kingdom', state: '', city: 'London', hs_lead_status: 'OPEN', lastmodifieddate: '1' },
    { id: '3', firstname: 'Dan', lastname: 'Roe', linkedinbio: 'https://www.linkedin.com/in/dan-d', linkedin_membership_id: '300', company: 'Initech', jobtitle: 'Brand Lead', country: 'United Kingdom', state: '', city: 'London', hs_lead_status: 'OPEN', lastmodifieddate: '1' },
    { id: '4', firstname: 'Eve', lastname: 'Sky', linkedinbio: 'https://www.linkedin.com/in/eve-e', linkedin_membership_id: '400', company: 'Umbrella', jobtitle: 'CMO', country: 'United Kingdom', state: '', city: 'London', hs_lead_status: 'UNSUBSCRIBED', lastmodifieddate: '1' },
  ],
}));

const opts = { dir, cachePath };
const MARKETER = ['marketing', 'brand', 'growth', 'cmo'];

test('scopes to one operator network via warmVia', () => {
  const r = buildFgTargets({}, { operator: 'bob@ortus.solutions', ...opts });
  // bob only knows Carol
  assert.equal(r.count, 1);
  assert.equal(r.rows[0][0], 'Carol Fox');
});

test('applies the function/title filter (jobTitles keywords)', () => {
  const r = buildFgTargets({ jobTitles: MARKETER }, { operator: 'alice@ortus.solutions', ...opts });
  // alice knows Mara (Marketing), Carol (Engineer - excluded), Dan (Brand)
  const names = r.rows.map((row) => row[0]).sort();
  assert.deepEqual(names, ['Dan Roe', 'Mara Lee']);
});

test('excludes DNC contacts', () => {
  // Eve (CMO) is UNSUBSCRIBED and not in any network here, but assert DNC never leaks:
  const r = buildFgTargets({ jobTitles: ['cmo'] }, { operator: 'alice@ortus.solutions', ...opts });
  assert.equal(r.rows.find((row) => row[0] === 'Eve Sky'), undefined);
});

test('dedupes against already-invited Member IDs', () => {
  const r = buildFgTargets({ jobTitles: MARKETER }, { operator: 'alice@ortus.solutions', alreadyInvited: ['100'], ...opts });
  const names = r.rows.map((row) => row[0]);
  assert.deepEqual(names, ['Dan Roe']); // Mara (100) already invited
});

test('caps at remaining budget', () => {
  const r = buildFgTargets({ jobTitles: MARKETER }, { operator: 'alice@ortus.solutions', budget: 1, ...opts });
  assert.equal(r.count, 1);
  assert.equal(r.eligible, 2); // 2 eligible, but only 1 fits the budget
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/connections/fg-targets.test.js`
Expected: FAIL — `buildFgTargets is not a function` / export missing.

- [ ] **Step 3: Write minimal implementation**

Add the import near the top of `src/connections/search-service.js` (next to the existing `export.js` import at line 11):

```js
import { FG_HEADER, fgRow, inviteKey } from './fg-export.js';
```

Append at the end of `src/connections/search-service.js`:

```js
// Per-operator Follower Growth invite list from the Connections DB. Scoped to
// one operator's OWN network (warmVia includes `operator`), filtered by
// matchesCriteria (the function/title chips live in jobTitles), DNC excluded,
// deduped against already-invited keys (Member ID or URL), and capped at the
// remaining monthly budget. Returns FG_HEADER + rectangular string rows + counts.
export function buildFgTargets(criteria = {}, { operator, operatorName, account, month, alreadyInvited = [], budget = Infinity, dir, cachePath } = {}) {
  const annotated = getAnnotated(dir, cachePath);
  const colleagues = getColleagues();
  const norm = normCriteria(criteria);
  const invitedKeys = new Set((alreadyInvited || []).map(String));
  const keywords = norm.jobTitles;
  const eligible = annotated.filter((r) =>
    !r.dnc
    && r.warmVia.includes(operator)
    && matchesCriteria(r.contact, norm)
    && !invitedKeys.has(inviteKey(r.contact)),
  );
  eligible.sort((a, b) => (a.contact.company || '').localeCompare(b.contact.company || ''));
  const capped = Number.isFinite(budget) ? eligible.slice(0, Math.max(0, budget)) : eligible;
  const opName = operatorName || colleagues[operator]?.name || operator || '';
  const rows = capped.map((r) => fgRow(r, colleagues, { operatorName: opName, account, month, keywords }));
  return { header: FG_HEADER, rows, count: rows.length, eligible: eligible.length };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/connections/fg-targets.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Run the whole connections suite (no regressions)**

Run: `node --test tests/connections/*.test.js`
Expected: all PASS (existing + new).

- [ ] **Step 6: Commit**

```bash
git add src/connections/search-service.js tests/connections/fg-targets.test.js
git commit -m "feat(fg): per-operator target builder (scope/filter/dedupe/budget)"
```

---

## Task 3: Central FG sheet I/O (`fg-sync.js`) + `FG_WEBAPP_URL`

**Files:**
- Modify: `src/sheets-webapp-url.js` (add `FG_WEBAPP_URL`)
- Create: `src/connections/fg-sync.js`
- Test: `tests/connections/fg-sync.test.js`

- [ ] **Step 1: Add the FG webapp URL constant**

Append to `src/sheets-webapp-url.js` (after the other webapp URLs):

```js
// v2.113 — Follower Growth campaign. SEPARATE Apps Script deployment from the
// master outreach script: it owns the central FG sheet (FG Invites / FG Budgets
// / FG Funnel). Paste fg-apps-script.js into a NEW Apps Script project, deploy
// as a web app ("execute as me", "anyone with the link"), and put its /exec URL
// here. Until then the app surfaces a friendly "not configured" error.
export const FG_WEBAPP_URL = '';
```

- [ ] **Step 2: Write the failing test**

```js
// tests/connections/fg-sync.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fgSync from '../../src/connections/fg-sync.js';
import { FG_WEBAPP_URL } from '../../src/sheets-webapp-url.js';

test('exports the three sheet I/O functions + default allowance', () => {
  assert.equal(typeof fgSync.getFgState, 'function');
  assert.equal(typeof fgSync.queueFgInvites, 'function');
  assert.equal(typeof fgSync.markFgInvited, 'function');
  assert.equal(typeof fgSync.FG_DEFAULT_MONTHLY_ALLOWANCE, 'number');
});

test('getFgState throws a friendly error when the URL is not configured', async () => {
  if (FG_WEBAPP_URL) return; // skip once Antonio wires the real URL
  await assert.rejects(() => fgSync.getFgState(), /not configured/i);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test tests/connections/fg-sync.test.js`
Expected: FAIL — `Cannot find module '.../fg-sync.js'`.

- [ ] **Step 4: Write minimal implementation**

```js
// src/connections/fg-sync.js
// Central FG sheet I/O for the Follower Growth campaign. Talks to the FG Apps
// Script (a SEPARATE deployment from the master outreach script) via its own
// FG_WEBAPP_URL. The 302-safe postFg mirrors drive-sync.js's postWebApp
// (Apps Script answers POST with a 302 that Node's fetch would turn into a GET).
import { FG_WEBAPP_URL } from '../sheets-webapp-url.js';

// LinkedIn's per-account monthly "Invite to follow" allowance. CONFIRM the real
// current figure before launch (open item in the design doc). Used as the
// fallback when an account has no FG Budgets row yet for the month.
export const FG_DEFAULT_MONTHLY_ALLOWANCE = 250;

async function postFg(payload, { timeoutMs = 30000 } = {}) {
  if (!FG_WEBAPP_URL) return { error: 'FG_WEBAPP_URL not configured — deploy fg-apps-script.js and set its URL in src/sheets-webapp-url.js' };
  const body = JSON.stringify(payload);
  try {
    const initial = await fetch(FG_WEBAPP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    let res = initial;
    if (initial.status >= 300 && initial.status < 400) {
      res = await fetch(initial.headers.get('location'), { signal: AbortSignal.timeout(timeoutMs) });
    }
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      if (text.includes('accounts.google.com') || text.includes('Sign in')) {
        return { error: 'FG Apps Script returned a login page — redeploy it ("anyone with the link")' };
      }
      return { error: 'Unexpected non-JSON response from the FG Apps Script' };
    }
  } catch (err) {
    return { error: err.message };
  }
}

// { invites: [...row objects], budgets: [...], funnel: [...] }
export async function getFgState() {
  const r = await postFg({ action: 'fgState' }, { timeoutMs: 60000 });
  if (r?.error) throw new Error(r.error);
  return { invites: r.invites || [], budgets: r.budgets || [], funnel: r.funnel || [] };
}

// Append queued rows (FG_HEADER order). The Apps Script dedupes server-side by
// Member-ID-or-URL, so concurrent operators can't double-queue the same person.
export async function queueFgInvites(rows) {
  const r = await postFg({ action: 'fgQueue', rows }, { timeoutMs: 90000 });
  if (r?.error) throw new Error(r.error);
  return r; // { queued, skippedDuplicates }
}

// Flip the given Member IDs from Queued → Invited (stamp Invited At) and bump
// the account's FG Budgets row for the month.
export async function markFgInvited({ memberIds, account, operator, month }) {
  const r = await postFg({ action: 'fgMarkInvited', memberIds, account, operator, month }, { timeoutMs: 90000 });
  if (r?.error) throw new Error(r.error);
  return r; // { invited, remaining }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test tests/connections/fg-sync.test.js`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/sheets-webapp-url.js src/connections/fg-sync.js tests/connections/fg-sync.test.js
git commit -m "feat(fg): central FG sheet I/O client + FG_WEBAPP_URL placeholder"
```

---

## Task 4: Server routes (`/api/fg/*`)

**Files:**
- Modify: `server.js` (imports near line 74-75; routes after the `/api/connections/to-workbook` route at ~line 1358)

No unit test (the app has no HTTP test harness; logic is covered by Tasks 1-3). Verified manually in Task 7.

- [ ] **Step 1: Add imports**

After the existing connections imports (`server.js:74-75`), add:

```js
import { buildFgTargets } from './src/connections/search-service.js';
import { getFgState, queueFgInvites, markFgInvited, FG_DEFAULT_MONTHLY_ALLOWANCE } from './src/connections/fg-sync.js';
```

(`buildFgTargets` may be folded into the existing `search-service.js` import line instead of a second import — either is fine.)

- [ ] **Step 2: Add the routes**

Insert after the `/api/connections/to-workbook` route (after `server.js:1358`):

```js
// ── Follower Growth campaign ───────────────────────────────────────
// Targets come from the Connections DB scoped to ONE operator's network
// (warmVia), function/title filtered, DNC-safe, deduped vs already-invited,
// capped at the account's remaining monthly budget. Results live in the central
// FG sheet (FG Invites / FG Budgets / FG Funnel) via the FG Apps Script.
const FG_MARKETER_KEYWORDS = ['marketing', 'brand', 'growth', 'content', 'demand', 'comms', 'cmo'];
function fgCriteria(b = {}) {
  // Function/title filter rides the jobTitles chip mechanism. Default toward
  // marketers when the operator hasn't set their own chips.
  const jobTitles = Array.isArray(b.jobTitles) && b.jobTitles.length ? b.jobTitles : FG_MARKETER_KEYWORDS;
  return { jobTitles, companies: b.companies || [], geo: b.geo || [] };
}
const fgMonth = () => new Date().toISOString().slice(0, 7); // YYYY-MM

// Remaining budget for an account this month = allowance − sent (from FG Budgets).
function fgRemaining(budgets, account, month) {
  const row = (budgets || []).find((r) => r.Account === account && r.Month === month);
  const allowance = row ? Number(row.Allowance) || FG_DEFAULT_MONTHLY_ALLOWANCE : FG_DEFAULT_MONTHLY_ALLOWANCE;
  const sent = row ? Number(row.Sent) || 0 : 0;
  return Math.max(0, allowance - sent);
}

// In-app database view: the central FG sheet, rendered in the campaign tab.
app.get('/api/fg/db', async (_req, res) => {
  try {
    res.json(await getFgState());
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Build (preview) a queued invite list for an operator/account — does NOT write.
app.post('/api/fg/build', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.operator) return res.status(400).json({ error: 'operator (colleague email) is required' });
    const account = b.account || b.operator;
    const month = b.month || fgMonth();
    const { invites, budgets } = await getFgState();
    const alreadyInvited = (invites || []).map((r) => String(r['Member ID'] || '') || (r['LinkedIn URL'] || ''));
    const budget = fgRemaining(budgets, account, month);
    const out = buildFgTargets(fgCriteria(b), { operator: b.operator, operatorName: b.operatorName, account, month, alreadyInvited, budget });
    res.json({ ...out, account, month, budget });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Persist a built list to FG Invites as Queued.
app.post('/api/fg/queue', async (req, res) => {
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
    if (!rows || !rows.length) return res.status(400).json({ error: 'No rows to queue.' });
    res.json(await queueFgInvites(rows));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Flip Queued → Invited (manual send done) + bump the account budget.
app.post('/api/fg/mark-invited', async (req, res) => {
  try {
    const b = req.body || {};
    const memberIds = Array.isArray(b.memberIds) ? b.memberIds : null;
    if (!memberIds || !memberIds.length) return res.status(400).json({ error: 'memberIds required' });
    res.json(await markFgInvited({ memberIds, account: b.account, operator: b.operator, month: b.month || fgMonth() }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
```

- [ ] **Step 3: Verify the server boots**

Run: `node -e "import('./server.js').then(()=>{console.log('boot ok'); process.exit(0)}).catch(e=>{console.error(e); process.exit(1)})"`
Expected: prints `boot ok` (no import/syntax errors). If it hangs on `app.listen`, instead run `node --check server.js` and rely on Task 7 manual boot.

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat(fg): /api/fg build/queue/mark-invited/db routes"
```

---

## Task 5: Central FG Apps Script (`fg-apps-script.js`)

**Files:**
- Create: `fg-apps-script.js` (repo root, mirrors `google-apps-script.js`)

This is Google Apps Script (not Node) — no unit test. Antonio pastes it into a NEW Apps Script project, deploys it as a web app, and puts the `/exec` URL into `src/sheets-webapp-url.js` (`FG_WEBAPP_URL`). Verified manually in Task 7.

- [ ] **Step 1: Write the script**

```js
// fg-apps-script.js — Central Follower Growth sheet (SEPARATE deployment from
// google-apps-script.js). Owns three tabs: "FG Invites", "FG Budgets",
// "FG Funnel". Deploy: new Apps Script project → paste → Deploy as Web app,
// execute as me, access "Anyone with the link". Put the /exec URL in
// src/sheets-webapp-url.js (FG_WEBAPP_URL).

var FG_HEADER = ['Target Name','LinkedIn URL','Member ID','Company','Job Title',
  'Function Match','Geo','Invited By','Account','Status','Invited At','FG Note','Month'];
var BUDGET_HEADER = ['Account','Operator','Month','Allowance','Sent','Remaining'];
var DEFAULT_ALLOWANCE = 250; // keep in sync with FG_DEFAULT_MONTHLY_ALLOWANCE

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000); // serialize concurrent operators
  try {
    var data = JSON.parse(e.postData.contents || '{}');
    var out;
    if (data.action === 'fgState') out = fgState_();
    else if (data.action === 'fgQueue') out = fgQueue_(data.rows || []);
    else if (data.action === 'fgMarkInvited') out = fgMarkInvited_(data);
    else out = { error: 'Unknown action: ' + data.action };
    return json_(out);
  } catch (err) {
    return json_({ error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}
function doGet() { return json_({ ok: true, service: 'fg' }); }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

function sheet_(name, header) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}
function rows_(sh) {
  var rng = sh.getDataRange().getValues();
  if (rng.length < 2) return { header: rng[0] || [], data: [] };
  return { header: rng[0], data: rng.slice(1) };
}
function asObjects_(sh) {
  var r = rows_(sh);
  return r.data.map(function (row) {
    var o = {}; r.header.forEach(function (h, i) { o[h] = row[i]; }); return o;
  });
}
function keyOf_(memberId, url) { return String(memberId || '') || String(url || ''); }

function fgState_() {
  var inv = sheet_('FG Invites', FG_HEADER);
  var bud = sheet_('FG Budgets', BUDGET_HEADER);
  return { invites: asObjects_(inv), budgets: asObjects_(bud), funnel: fgFunnel_() };
}

// Append rows that aren't already present (by Member-ID-or-URL).
function fgQueue_(rows) {
  var sh = sheet_('FG Invites', FG_HEADER);
  var existing = {};
  asObjects_(sh).forEach(function (o) { existing[keyOf_(o['Member ID'], o['LinkedIn URL'])] = true; });
  var fresh = rows.filter(function (r) { return !existing[keyOf_(r[2], r[1])]; }); // r[2]=Member ID, r[1]=URL
  if (fresh.length) sh.getRange(sh.getLastRow() + 1, 1, fresh.length, FG_HEADER.length).setValues(fresh);
  return { queued: fresh.length, skippedDuplicates: rows.length - fresh.length };
}

// Flip Queued → Invited for the given Member IDs, stamp Invited At, bump budget.
function fgMarkInvited_(data) {
  var ids = {}; (data.memberIds || []).forEach(function (id) { ids[String(id)] = true; });
  var sh = sheet_('FG Invites', FG_HEADER);
  var r = rows_(sh);
  var iMember = FG_HEADER.indexOf('Member ID');
  var iStatus = FG_HEADER.indexOf('Status');
  var iWhen = FG_HEADER.indexOf('Invited At');
  var now = new Date().toISOString();
  var n = 0;
  for (var i = 0; i < r.data.length; i++) {
    var row = r.data[i];
    if (ids[String(row[iMember])] && row[iStatus] !== 'Invited') {
      sh.getRange(i + 2, iStatus + 1).setValue('Invited');
      sh.getRange(i + 2, iWhen + 1).setValue(now);
      n++;
    }
  }
  var remaining = bumpBudget_(data.account, data.operator, data.month, n);
  return { invited: n, remaining: remaining };
}

function bumpBudget_(account, operator, month, sentDelta) {
  var sh = sheet_('FG Budgets', BUDGET_HEADER);
  var r = rows_(sh);
  for (var i = 0; i < r.data.length; i++) {
    if (r.data[i][0] === account && r.data[i][2] === month) {
      var allowance = Number(r.data[i][3]) || DEFAULT_ALLOWANCE;
      var sent = (Number(r.data[i][4]) || 0) + sentDelta;
      sh.getRange(i + 2, 5).setValue(sent);       // Sent
      sh.getRange(i + 2, 6).setValue(allowance - sent); // Remaining
      return allowance - sent;
    }
  }
  // No row yet → create one.
  var allowance = DEFAULT_ALLOWANCE;
  sh.appendRow([account, operator || '', month, allowance, sentDelta, allowance - sentDelta]);
  return allowance - sentDelta;
}

// Funnel rollup per operator: eligible-pool isn't known here (lives in the app),
// so the funnel reports Invited counts per operator + total from FG Invites.
function fgFunnel_() {
  var sh = sheet_('FG Invites', FG_HEADER);
  var iBy = FG_HEADER.indexOf('Invited By');
  var iStatus = FG_HEADER.indexOf('Status');
  var byOp = {}; var total = 0;
  asObjects_(sh).forEach(function (o) {
    if (o['Status'] === 'Invited') { var k = o['Invited By'] || '—'; byOp[k] = (byOp[k] || 0) + 1; total++; }
  });
  var out = Object.keys(byOp).map(function (k) { return { operator: k, invited: byOp[k] }; });
  out.push({ operator: 'TOTAL', invited: total });
  return out;
}
```

- [ ] **Step 2: Commit**

```bash
git add fg-apps-script.js
git commit -m "feat(fg): central FG Apps Script (FG Invites/Budgets/Funnel tabs)"
```

> **Manual (Antonio, outside this plan):** create the new Apps Script project + sheet, paste, deploy, paste the `/exec` URL into `FG_WEBAPP_URL`. Until then the in-app DB view shows the friendly "not configured" message.

---

## Task 6: Follower Growth campaign type + in-app DB view (UI)

**Files:**
- Modify: `public/index.html`, `public/js/app.js`, `public/css/style.css`

No automated test (UI has none in this repo — manual verification per CLAUDE.md). Because these are large, tightly-coupled shared files, this task may be implemented directly rather than via a subagent.

- [ ] **Step 1: Add the campaign type + panels (index.html)**

Add a "Follower Growth" option to the campaign mode list (alongside the existing modes), gated to show the FG panel. The FG panel contains:
  - **Account/operator select** (which operator is inviting — drives `warmVia` scope).
  - **Function/title chip filter**, pre-seeded with the marketer keywords (`marketing`, `brand`, `growth`, `content`, `demand`, `comms`, `cmo`) but editable — reuse the existing Connections chip-input component.
  - **Budget meter** (`Sent / Allowance · Remaining` for this account+month).
  - **Build button** → calls `/api/fg/build`, renders the previewed list in a table (Name · Title · Function Match · Company).
  - **Queue button** → `/api/fg/queue`, then **Mark invited** → `/api/fg/mark-invited`.
  - An **in-app Follower Growth database view** with three sub-tabs rendering `/api/fg/db`: Invites, Budgets, Funnel.

- [ ] **Step 2: Add the FG client block (app.js)**

Add functions mirroring the existing Connections client:
  - `fgBuild()` — POST `/api/fg/build` with `{ operator, account, jobTitles }`; render preview + budget meter (`count` queued of `eligible` eligible, `budget` remaining).
  - `fgQueue()` — POST `/api/fg/queue` with the built `rows`; on success refresh the DB view.
  - `fgMarkInvited()` — POST `/api/fg/mark-invited` with the queued `memberIds`; refresh budget + DB view.
  - `fgLoadDb()` — GET `/api/fg/db`; render Invites/Budgets/Funnel tables. Show the friendly error text if the response is a 502/`not configured`.
  - Wire the Follower Growth mode into the existing `onModeChange()` so the FG panel shows only for that campaign type.

- [ ] **Step 3: Add styles (style.css)**

Monochrome Bugatti styles for the FG panel, budget meter (a hairline bar; fill = `--ink`), and DB tables — reuse existing `.cx-*` table/row conventions; no new accent colors.

- [ ] **Step 4: Manual verification**

`npm run dev:app`, open the Follower Growth campaign type, confirm: panel renders, build returns a list (against a seeded local cache), budget meter shows, DB view shows the "not configured" message until `FG_WEBAPP_URL` is set. (Full sheet round-trip verified after Antonio deploys the FG Apps Script.)

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/js/app.js public/css/style.css
git commit -m "feat(fg): Follower Growth campaign type + in-app DB view"
```

---

## Task 7: Version bump, relaunch, full verification

**Files:**
- Modify: `package.json` (version bump)

- [ ] **Step 1: Run the full test suite**

Run: `node --test tests/connections/*.test.js`
Expected: all PASS.

- [ ] **Step 2: Patch-bump the version**

Bump `package.json` `version` (e.g. `2.112.48` → `2.113.0`, a minor bump since this is a new feature) so the UI shows the new build.

- [ ] **Step 3: Relaunch dev:app (operator rule #2)**

```bash
pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "Electron.*ortus" 2>/dev/null
npm run dev:app > /tmp/dev-app.log 2>&1 &
```

- [ ] **Step 4: Manual smoke**

Confirm the version in the UI, the Follower Growth campaign type appears, a build against the local cache returns a scoped+filtered list, and the budget meter renders.

- [ ] **Step 5: Commit**

```bash
git add package.json
git commit -m "chore: bump version for Follower Growth Phase 1"
```

---

## Out of scope (Phase 2 / later — do NOT build here)

- Browser automation of the "Invite to follow" click (Phase 2; a new page-invite path alongside the off-limits `outreach.js`/`actions.js`).
- Follow-conversion / acceptance tracking and credit-refund modeling.
- Bucket C (un-recorded live connections), a clean job-function taxonomy, and migrating legacy standalone-FG-sheet data.

## Open items (confirm before/at implementation — from the spec)

- Real per-account monthly **Allowance** number (the `250` default in `fg-sync.js` + `fg-apps-script.js` is a placeholder).
- Deploy the new FG Apps Script + wire `FG_WEBAPP_URL`.
- `colleagues.json` must map each operator email → name so `warmVia` scoping resolves operator identity (and the operator select shows real names).
