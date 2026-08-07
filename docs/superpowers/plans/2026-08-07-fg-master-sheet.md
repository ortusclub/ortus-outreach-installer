# FG Master Sheet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate an `FG Master` tab in the app's central Follower Growth Google Sheet — one row per warm contact (name, title, company, geo, LinkedIn URL, every connected account) — and stamp `Invited` / `Invited At` / `Invited By` onto each person's row as the bot sends invites.

**Architecture:** A pure module (`src/connections/fg-master.js`) turns the already-annotated Connections DB records into rectangular string rows and joins the historical `FG Invites` ledger onto them. `src/connections/fg-sync.js` posts them to a new chunked Apps Script action (`fgWriteMaster`), because one `setValues` cannot carry ~279k rows. The per-invite stamp lives inside the Apps Script `fgMarkInvited_` — the single choke point every send path already routes through — so no JS send-path call site changes.

**Tech Stack:** Node ≥22 ESM, Express 4, `node --test`, Google Apps Script (`fg-apps-script.js`), vanilla JS UI (`public/js/app.js`, `public/index.html`).

## Global Constraints

- Runtime: Node ≥22, ESM (`import`/`export`), no bundler, no new dependencies.
- Tests: `node --test tests/<file>.test.js`. Pure-helper unit tests, no framework, no fixtures directory.
- Every cell posted to Apps Script must be a **string** — `setValues` needs rectangular string data, no `undefined`/`null`.
- Off-limits files: `src/linkedin/outreach.js`, `src/linkedin/actions.js`. Do not touch.
- `fg-apps-script.js` is the shared source of truth for every operator; it is ES5-style Apps Script (`var`, `function`), not modern ESM. Match the surrounding style.
- Never `git add` `data/**` (`data/connections-cache.json`, `data/fg-cloud-runs.json`, …).
- Identity rule everywhere in this plan: **Member ID when non-empty, else the normalised LinkedIn URL** (`normUrl` from `src/connections/fg-list.js`: lower-cased, `https?://` and `www.` stripped, query/fragment dropped, trailing slashes dropped).
- Column order constant `FG_MASTER_HEADER` must stay identical in `src/connections/fg-master.js` and `fg-apps-script.js`.

---

### Task 1: Pure master-row module

**Files:**
- Create: `src/connections/fg-master.js`
- Test: `tests/fg-master.test.js`

**Interfaces:**
- Consumes: `normUrl` from `src/connections/fg-list.js` (already exists, exported).
- Produces:
  - `FG_MASTER_HEADER: string[]` — 11 column names.
  - `masterKey({ memberId, url }): string`
  - `invitedIndexFromFgInvites(invites: object[]): Map<string, { invitedAt: string, invitedBy: string }>`
  - `masterRowFromRecord(record, invitedIndex?): string[] | null` — `null` when the contact has no LinkedIn URL.
  - `buildMasterRows(annotated: object[], invitedIndex?): { rows: string[][], count: number, droppedNoUrl: number }`
  - `chunkRows(rows: string[][], size: number): string[][][]`

An `annotated` record is `{ contact, warmVia: string[], hasWarm: boolean, dnc: boolean }` as produced by `annotate()` in `src/connections/match.js`. `contact` has `firstname, lastname, jobtitle, company, city, state, country, linkedinbio, linkedin_membership_id`.

- [ ] **Step 1: Write the failing test**

Create `tests/fg-master.test.js`:

```js
// tests/fg-master.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FG_MASTER_HEADER, masterKey, invitedIndexFromFgInvites,
  masterRowFromRecord, buildMasterRows, chunkRows,
} from '../src/connections/fg-master.js';

const rec = (contact, warmVia = ['ada@ortus.example'], extra = {}) =>
  ({ contact, warmVia, hasWarm: warmVia.length > 0, dnc: false, ...extra });

const ADA = {
  firstname: 'Ada', lastname: 'Lovelace', jobtitle: 'Head of Marketing',
  company: 'Analytical', city: 'London', state: null, country: 'United Kingdom',
  linkedinbio: 'https://www.linkedin.com/in/ada/', linkedin_membership_id: '12345',
};

test('FG_MASTER_HEADER is the agreed 11 columns in order', () => {
  assert.deepEqual(FG_MASTER_HEADER, [
    'First Name', 'Last Name', 'Job Title', 'Company', 'Geo',
    'LinkedIn URL', 'Member ID', 'Connected Accounts',
    'Invited', 'Invited At', 'Invited By',
  ]);
});

test('masterKey prefers Member ID and falls back to the normalised URL', () => {
  assert.equal(masterKey({ memberId: '12345', url: 'https://linkedin.com/in/ada' }), '12345');
  assert.equal(masterKey({ memberId: '', url: 'https://www.linkedin.com/in/Ada/' }), 'linkedin.com/in/ada');
  assert.equal(masterKey({ memberId: '', url: '' }), '');
});

test('masterRowFromRecord fills geo, joins every connected account, and stringifies', () => {
  const row = masterRowFromRecord(rec(ADA, ['ada@ortus.example', 'bo@ortus.example']));
  assert.deepEqual(row, [
    'Ada', 'Lovelace', 'Head of Marketing', 'Analytical', 'London, United Kingdom',
    'https://www.linkedin.com/in/ada/', '12345', 'ada@ortus.example, bo@ortus.example',
    '', '', '',
  ]);
  for (const cell of row) assert.equal(typeof cell, 'string');
});

test('masterRowFromRecord returns null when the contact has no LinkedIn URL', () => {
  assert.equal(masterRowFromRecord(rec({ ...ADA, linkedinbio: '' })), null);
});

test('invitedIndexFromFgInvites indexes only Invited rows, by member id then url', () => {
  const idx = invitedIndexFromFgInvites([
    { 'Member ID': '12345', 'LinkedIn URL': 'https://linkedin.com/in/ada', Status: 'Invited', 'Invited At': '2026-07-01 09:00 UTC', Account: 'ada@ortus.example' },
    { 'Member ID': '', 'LinkedIn URL': 'https://www.linkedin.com/in/Bo/', Status: 'Invited', 'Invited At': '2026-07-02 09:00 UTC', Account: 'bo@ortus.example' },
    { 'Member ID': '999', 'LinkedIn URL': 'https://linkedin.com/in/cy', Status: 'Failed', 'Invited At': '', Account: 'cy@ortus.example' },
  ]);
  assert.equal(idx.size, 2);
  assert.deepEqual(idx.get('12345'), { invitedAt: '2026-07-01 09:00 UTC', invitedBy: 'ada@ortus.example' });
  assert.deepEqual(idx.get('linkedin.com/in/bo'), { invitedAt: '2026-07-02 09:00 UTC', invitedBy: 'bo@ortus.example' });
  assert.equal(idx.has('999'), false, 'Failed rows must not count as invited');
});

test('masterRowFromRecord stamps the ledger columns from the invited index', () => {
  const idx = invitedIndexFromFgInvites([
    { 'Member ID': '12345', 'LinkedIn URL': '', Status: 'Invited', 'Invited At': '2026-07-01 09:00 UTC', Account: 'ada@ortus.example' },
  ]);
  const row = masterRowFromRecord(rec(ADA), idx);
  assert.deepEqual(row.slice(8), ['Invited', '2026-07-01 09:00 UTC', 'ada@ortus.example']);
});

test('buildMasterRows drops DNC, no-warm and URL-less records and counts them', () => {
  const out = buildMasterRows([
    rec(ADA),
    rec({ ...ADA, linkedinbio: 'https://linkedin.com/in/bo' }, [], { hasWarm: false }),
    rec({ ...ADA, linkedinbio: 'https://linkedin.com/in/cy' }, ['ada@ortus.example'], { dnc: true }),
    rec({ ...ADA, linkedinbio: '' }),
  ]);
  assert.equal(out.count, 1);
  assert.equal(out.rows.length, 1);
  assert.equal(out.droppedNoUrl, 1);
  assert.equal(out.rows[0][0], 'Ada');
});

test('chunkRows splits into fixed-size chunks with a short tail', () => {
  const rows = Array.from({ length: 7 }, (_, i) => [String(i)]);
  const chunks = chunkRows(rows, 3);
  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks[0], [['0'], ['1'], ['2']]);
  assert.deepEqual(chunks[2], [['6']]);
  assert.deepEqual(chunkRows([], 3), []);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/fg-master.test.js`
Expected: FAIL — `Cannot find module '.../src/connections/fg-master.js'`

- [ ] **Step 3: Write the implementation**

Create `src/connections/fg-master.js`:

```js
// src/connections/fg-master.js
// The FG Master tab — the whole warm network as one flat, human-readable table.
// One row per person: who they are, every Ortus account that holds them as a
// 1st-degree connection, and whether we have invited them yet. Generated from the
// annotated Connections DB (the same join the FG target builder uses), with the
// FG Invites ledger folded in so a rebuild never loses invite history.
// Pure module: no I/O, unit-testable.
import { normUrl } from './fg-list.js';

// KEEP IN SYNC with FG_MASTER_HEADER in fg-apps-script.js.
export const FG_MASTER_HEADER = [
  'First Name', 'Last Name', 'Job Title', 'Company', 'Geo',
  'LinkedIn URL', 'Member ID', 'Connected Accounts',
  'Invited', 'Invited At', 'Invited By',
];

const norm = (v) => String(v == null ? '' : v).trim();

// Identity for a person: the numeric Member ID when we have one (load-bearing
// everywhere else in FG), else the normalised URL. Same rule as inviteIdentity()
// in fg-list.js — a person must key identically on both sides of the stamp.
export function masterKey({ memberId = '', url = '' } = {}) {
  return norm(memberId) || normUrl(url);
}

// FG Invites rows → key → { invitedAt, invitedBy } for rows actually Invited.
// Both the Member ID and the URL of an invited row are indexed, so a master row
// keyed either way finds it.
export function invitedIndexFromFgInvites(invites = []) {
  const idx = new Map();
  for (const r of invites || []) {
    if (!r || String(r.Status || '') !== 'Invited') continue;
    const entry = { invitedAt: norm(r['Invited At']), invitedBy: norm(r.Account) };
    const memberId = norm(r['Member ID']);
    const url = normUrl(r['LinkedIn URL']);
    if (memberId) idx.set(memberId, entry);
    if (url) idx.set(url, entry);
  }
  return idx;
}

// One FG_MASTER_HEADER-order row from an annotated record, or null when the
// contact has no LinkedIn URL (it can never be invited, and cannot be keyed).
export function masterRowFromRecord(record = {}, invitedIndex = null) {
  const c = (record && record.contact) || {};
  const url = norm(c.linkedinbio);
  if (!url) return null;
  const memberId = norm(c.linkedin_membership_id);
  const geo = [c.city, c.state, c.country].map(norm).filter(Boolean).join(', ');
  const accounts = (record.warmVia || []).map(norm).filter(Boolean).join(', ');
  const hit = invitedIndex ? invitedIndex.get(masterKey({ memberId, url })) : null;
  return [
    norm(c.firstname), norm(c.lastname), norm(c.jobtitle), norm(c.company), geo,
    url, memberId, accounts,
    hit ? 'Invited' : '', hit ? norm(hit.invitedAt) : '', hit ? norm(hit.invitedBy) : '',
  ];
}

// Every warm, non-DNC, URL-bearing contact as rectangular string rows.
export function buildMasterRows(annotated = [], invitedIndex = null) {
  const rows = [];
  let droppedNoUrl = 0;
  for (const r of annotated || []) {
    if (!r || r.dnc || !r.hasWarm) continue;
    const row = masterRowFromRecord(r, invitedIndex);
    if (!row) { droppedNoUrl += 1; continue; }
    rows.push(row);
  }
  return { rows, count: rows.length, droppedNoUrl };
}

// Split rows into POST-sized chunks. ~279k rows cannot go over the wire (or into
// one setValues) in a single call.
export function chunkRows(rows = [], size = 5000) {
  const out = [];
  const n = Math.max(1, size);
  for (let i = 0; i < rows.length; i += n) out.push(rows.slice(i, i + n));
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/fg-master.test.js`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/connections/fg-master.js tests/fg-master.test.js
git commit -m "feat(fg): pure FG Master row builder + FG Invites backfill index"
```

---

### Task 2: Chunked `writeFgMaster` transport

**Files:**
- Modify: `src/connections/fg-sync.js` (append a new exported function after `updateFgListLedger`)
- Test: `tests/fg-master-sync.test.js`

**Interfaces:**
- Consumes: `postFg` (already in `fg-sync.js`), `chunkRows` + `FG_MASTER_HEADER` from Task 1.
- Produces: `writeFgMaster(rows, { tab, header, chunkSize, post, onProgress }): Promise<{ tab, written, chunks }>`
  - `tab` defaults to `'FG Master'`, `header` to `FG_MASTER_HEADER`, `chunkSize` to `5000`.
  - `post` defaults to the module's `postFg` — injected in tests.
  - Posts `{ action: 'fgWriteMaster', tab, header, rows: chunk, mode }` with `mode: 'replace'` for the first call and `'append'` thereafter. With zero rows it still posts one `replace` (header-only) so a rebuild that matches nothing empties the tab.
  - `onProgress({ done, total })` is called after each chunk, `done`/`total` counted in rows.
  - Throws on the first chunk error, with the chunk index in the message.

- [ ] **Step 1: Write the failing test**

Create `tests/fg-master-sync.test.js`:

```js
// tests/fg-master-sync.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFgMaster } from '../src/connections/fg-sync.js';
import { FG_MASTER_HEADER } from '../src/connections/fg-master.js';

const rows = (n) => Array.from({ length: n }, (_, i) => [String(i), '', '', '', '', `u${i}`, '', '', '', '', '']);

test('writeFgMaster replaces on the first chunk and appends after', async () => {
  const calls = [];
  const post = async (payload) => { calls.push(payload); return { tab: payload.tab, written: payload.rows.length }; };
  const out = await writeFgMaster(rows(7), { chunkSize: 3, post });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].action, 'fgWriteMaster');
  assert.equal(calls[0].tab, 'FG Master');
  assert.deepEqual(calls[0].header, FG_MASTER_HEADER);
  assert.deepEqual(calls.map((c) => c.mode), ['replace', 'append', 'append']);
  assert.deepEqual(calls.map((c) => c.rows.length), [3, 3, 1]);
  assert.deepEqual(out, { tab: 'FG Master', written: 7, chunks: 3 });
});

test('writeFgMaster posts one header-only replace when there are no rows', async () => {
  const calls = [];
  const post = async (payload) => { calls.push(payload); return { written: 0 }; };
  const out = await writeFgMaster([], { post });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].mode, 'replace');
  assert.deepEqual(calls[0].rows, []);
  assert.equal(out.written, 0);
});

test('writeFgMaster reports progress per chunk', async () => {
  const seen = [];
  const post = async () => ({ written: 0 });
  await writeFgMaster(rows(5), { chunkSize: 2, post, onProgress: (p) => seen.push(p) });
  assert.deepEqual(seen, [{ done: 2, total: 5 }, { done: 4, total: 5 }, { done: 5, total: 5 }]);
});

test('writeFgMaster throws with the chunk index when a chunk fails', async () => {
  let n = 0;
  const post = async () => { n += 1; return n === 2 ? { error: 'boom' } : { written: 0 }; };
  await assert.rejects(
    () => writeFgMaster(rows(6), { chunkSize: 2, post }),
    /chunk 2\/3.*boom/,
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/fg-master-sync.test.js`
Expected: FAIL — `writeFgMaster is not a function` / import error.

- [ ] **Step 3: Write the implementation**

In `src/connections/fg-sync.js`, add the import at the top (next to the existing `FG_WEBAPP_URL` import):

```js
import { FG_MASTER_HEADER, chunkRows } from './fg-master.js';
```

and append at the end of the file:

```js
// Write the FG Master tab in chunks. One setValues (and one POST) cannot carry
// ~279k rows, so the first chunk REPLACES the tab (clear + header) and every
// later chunk APPENDS. Re-running rebuilds the tab from scratch, so a failed
// build is fixed by running it again — there is no partial-repair path.
export async function writeFgMaster(rows, {
  tab = 'FG Master', header = FG_MASTER_HEADER, chunkSize = 5000,
  post = postFg, onProgress = null,
} = {}) {
  const all = Array.isArray(rows) ? rows : [];
  const chunks = chunkRows(all, chunkSize);
  // No rows still needs one replace so a rebuild that matches nothing empties the tab.
  if (!chunks.length) chunks.push([]);
  let done = 0;
  for (let i = 0; i < chunks.length; i++) {
    const mode = i === 0 ? 'replace' : 'append';
    const r = await post({ action: 'fgWriteMaster', tab, header, rows: chunks[i], mode }, { timeoutMs: 120000 });
    if (r && r.error) throw new Error(`FG Master chunk ${i + 1}/${chunks.length} failed: ${r.error}`);
    done += chunks[i].length;
    if (onProgress) onProgress({ done, total: all.length });
  }
  return { tab, written: all.length, chunks: chunks.length };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/fg-master-sync.test.js tests/fg-master.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/connections/fg-sync.js tests/fg-master-sync.test.js
git commit -m "feat(fg): chunked writeFgMaster transport for the FG Master tab"
```

---

### Task 3: Apps Script — `fgWriteMaster` action + per-invite stamp

**Files:**
- Modify: `fg-apps-script.js`

**Interfaces:**
- Consumes: the payloads produced in Tasks 2 and 5.
- Produces (Apps Script actions):
  - `fgWriteMaster` — `{ tab, header, rows, mode }` → `{ tab, written, mode }`.
  - `fgMarkInvited` — now also accepts `invited: [{ memberId, url }]` and stamps `FG Master`. Returns `{ invited, sent, master }` where `master` is the number of master rows stamped.

There is no Node test harness for Apps Script (it runs in Google's V8, not this repo). This task is verified manually in Step 4; the JS-side identity rule it mirrors is already covered by Task 1's tests.

- [ ] **Step 1: Add the header constant and the `fgWriteMaster` action**

In `fg-apps-script.js`, below `var BUDGET_HEADER = [...]`, add:

```js
// KEEP IN SYNC with FG_MASTER_HEADER in src/connections/fg-master.js.
var FG_MASTER_HEADER = [
  'First Name', 'Last Name', 'Job Title', 'Company', 'Geo',
  'LinkedIn URL', 'Member ID', 'Connected Accounts',
  'Invited', 'Invited At', 'Invited By'
];
var FG_MASTER_TAB = 'FG Master';
```

In `doPost`, add the route next to the other `fg*` actions (after the `fgUpdateListLedger` line):

```js
    else if (data.action === 'fgWriteMaster') out = fgWriteMaster_(data);
```

Add the function after `fgUpdateListLedger_`:

```js
// Chunked build of the FG Master tab. mode 'replace' clears the tab and writes
// the header; mode 'append' adds a chunk at the bottom. The app posts ~5k rows
// per call because one setValues cannot hold the whole network.
function fgWriteMaster_(data) {
  var name = String(data.tab || FG_MASTER_TAB).trim();
  var header = data.header || FG_MASTER_HEADER;
  var rows = data.rows || [];
  var mode = String(data.mode || 'append');
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (mode === 'replace') {
    sh.clear();
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  if (rows.length) {
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, header.length).setValues(rows);
  }
  return { tab: name, written: rows.length, mode: mode };
}
```

- [ ] **Step 2: Add the master stamp to `fgMarkInvited_`**

Add these helpers above `fgMarkInvited_`:

```js
// Normalised LinkedIn URL — mirror of normUrl() in src/connections/fg-list.js.
function fgNormUrl_(url) {
  var s = String(url == null ? '' : url).trim().toLowerCase();
  if (!s) return '';
  s = s.split('?')[0].split('#')[0];
  s = s.replace(/^https?:\/\//, '').replace(/^www\./, '');
  return s.replace(/\/+$/, '');
}

// Stamp Invited / Invited At / Invited By onto FG Master rows.
// `people` is [{ memberId, url }]. Reads ONLY the two key columns (not the whole
// ~3M-cell grid) so this stays far inside the 6-minute execution limit. A missing
// tab is a no-op: a deployment that has not built the master yet is fine.
function fgStampMaster_(people, invitedBy, whenText) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(FG_MASTER_TAB);
  if (!sh) return 0;
  var last = sh.getLastRow();
  if (last < 2) return 0;
  var iUrl = FG_MASTER_HEADER.indexOf('LinkedIn URL');
  var iMember = FG_MASTER_HEADER.indexOf('Member ID');
  var iInvited = FG_MASTER_HEADER.indexOf('Invited');
  var urls = sh.getRange(2, iUrl + 1, last - 1, 1).getValues();
  var members = sh.getRange(2, iMember + 1, last - 1, 1).getValues();
  var byKey = {};
  for (var i = 0; i < urls.length; i++) {
    var mid = String(members[i][0] || '').trim();
    var key = mid || fgNormUrl_(urls[i][0]);
    if (key && !(key in byKey)) byKey[key] = i + 2; // sheet row number
    var uKey = fgNormUrl_(urls[i][0]);
    if (uKey && !(uKey in byKey)) byKey[uKey] = i + 2; // also findable by URL alone
  }
  var n = 0;
  for (var j = 0; j < people.length; j++) {
    var p = people[j] || {};
    var k = String(p.memberId || '').trim() || fgNormUrl_(p.url);
    var row = byKey[k];
    if (!row) row = byKey[fgNormUrl_(p.url)];
    if (!row) continue;
    sh.getRange(row, iInvited + 1, 1, 3).setValues([['Invited', whenText, invitedBy]]);
    n++;
  }
  return n;
}
```

Then change `fgMarkInvited_` so it collects the URL of every row it flips and stamps the master. Replace its body's loop and return with:

```js
function fgMarkInvited_(data) {
  var ids = {}; (data.memberIds || []).forEach(function (id) { ids[String(id)] = true; });
  var sh = sheet_('FG Invites', FG_HEADER);
  var r = rows_(sh);
  var iMember = FG_HEADER.indexOf('Member ID');
  var iStatus = FG_HEADER.indexOf('Status');
  var iWhen = FG_HEADER.indexOf('Invited At');
  var iUrl = FG_HEADER.indexOf('LinkedIn URL');
  var now = new Date();
  var n = 0;
  var people = [];  // [{ memberId, url }] for the FG Master stamp
  for (var i = 0; i < r.data.length; i++) {
    var row = r.data[i];
    if (ids[String(row[iMember])] && row[iStatus] !== 'Invited') {
      sh.getRange(i + 2, iStatus + 1).setValue('Invited');
      sh.getRange(i + 2, iWhen + 1).setValue(now).setNumberFormat('dd mmm yyyy, HH:mm');
      people.push({ memberId: String(row[iMember] || ''), url: String(row[iUrl] || '') });
      n++;
    }
  }
  // Callers that know the URL (cloud + list runs) pass `invited` so people whose
  // Member ID is blank — a large share of the DB — still stamp on the master.
  (data.invited || []).forEach(function (p) {
    if (p && (p.memberId || p.url)) people.push({ memberId: String(p.memberId || ''), url: String(p.url || '') });
  });
  var sent = bumpBudget_(data.account, data.operator, data.month, n);
  var master = 0;
  try {
    if (people.length) {
      master = fgStampMaster_(people, String(data.account || ''), Utilities.formatDate(now, 'UTC', "yyyy-MM-dd HH:mm 'UTC'"));
    }
  } catch (err) {
    // A reporting tab must never cost us an invite record.
    master = 0;
  }
  return { invited: n, sent: sent, master: master };
}
```

- [ ] **Step 3: Redeploy the FG Apps Script**

Open the FG Apps Script project (the deployment behind `FG_WEBAPP_URL` in `src/sheets-webapp-url.js`), paste the full new `fg-apps-script.js`, then **Deploy → Manage deployments → edit → New version → Deploy**. Pasting alone does not ship it.

- [ ] **Step 4: Verify manually**

Run from the repo:

```bash
node --input-type=module -e "
import { postFg } from './src/connections/fg-sync.js';
console.log(await postFg({ action: 'fgWriteMaster', tab: 'FG Master TEST', header: ['First Name','Last Name','Job Title','Company','Geo','LinkedIn URL','Member ID','Connected Accounts','Invited','Invited At','Invited By'], rows: [['Ada','Lovelace','Head of Marketing','Analytical','London','https://linkedin.com/in/ada','12345','ada@ortus.example','','','']], mode: 'replace' }));
"
```

Expected: `{ tab: 'FG Master TEST', written: 1, mode: 'replace' }`, and the tab visible in the FG sheet with a bold frozen header row. Delete the test tab by hand afterwards.

- [ ] **Step 5: Commit**

```bash
git add fg-apps-script.js
git commit -m "feat(fg): fgWriteMaster action + FG Master stamp inside fgMarkInvited"
```

---

### Task 4: Carry the LinkedIn URL into `markFgInvited`

**Files:**
- Modify: `src/connections/fg-sync.js` (the `markFgInvited` signature)
- Modify: `src/connections/fg-cloud-launch.js` (`invitedWritebackFromLeads`)
- Test: `tests/fg-master-invited-urls.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `markFgInvited({ memberIds, invited, account, operator, month })` — `invited` is an optional `[{ memberId, url }]`, passed straight through to the Apps Script.
  - `invitedWritebackFromLeads(leads, record)` groups gain an `invited: [{ memberId, url }]` array alongside the existing `memberIds`.

Read `src/connections/fg-cloud-launch.js` around `invitedWritebackFromLeads` before editing — the existing group shape is `{ account, operator, month, memberIds }` and the leads carry `leadUrl`.

- [ ] **Step 1: Write the failing test**

Create `tests/fg-master-invited-urls.test.js`:

```js
// tests/fg-master-invited-urls.test.js
// Invited write-back must carry the LinkedIn URL, not just the Member ID: a large
// share of the Connections DB has a null linkedin_membership_id, and those people
// can only be stamped on FG Master by URL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { invitedWritebackFromLeads } from '../src/connections/fg-cloud-launch.js';

const record = {
  perAccount: [{ profileId: 'pid_ada', account: 'ada@ortus.example', operator: 'ada@ortus.example', rowsByUrl: { 'https://linkedin.com/in/bo': '', 'https://linkedin.com/in/cy': '777' } }],
  month: '2026-08',
};

test('invitedWritebackFromLeads carries { memberId, url } per invited lead', () => {
  const groups = invitedWritebackFromLeads([
    { leadUrl: 'https://linkedin.com/in/bo', account: 'pid_ada', status: 'sent', stage: 'Invited' },
    { leadUrl: 'https://linkedin.com/in/cy', account: 'pid_ada', status: 'sent', stage: 'Invited' },
  ], record);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].invited, [
    { memberId: '', url: 'https://linkedin.com/in/bo' },
    { memberId: '777', url: 'https://linkedin.com/in/cy' },
  ]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/fg-master-invited-urls.test.js`
Expected: FAIL — `groups[0].invited` is `undefined`.

- [ ] **Step 3: Write the implementation**

In `src/connections/fg-cloud-launch.js`, inside `invitedWritebackFromLeads`, populate an `invited` array on each group in the same loop that pushes to `memberIds`, using the lead's `leadUrl` and the Member ID already looked up from `rowsByUrl`:

```js
      // Member ID stays the FG Invites key; the URL is what lets FG Master stamp
      // people whose linkedin_membership_id is null (a large share of the DB).
      group.invited = group.invited || [];
      group.invited.push({ memberId: String(memberId || ''), url: String(lead.leadUrl || '') });
```

(Use the surrounding code's actual variable names for the group and the lead — read the function first; do not rename anything.)

In `src/connections/fg-sync.js`, widen `markFgInvited`:

```js
export async function markFgInvited({ memberIds, invited, account, operator, month }) {
  const r = await postFg({ action: 'fgMarkInvited', memberIds, invited, account, operator, month }, { timeoutMs: 90000 });
  if (r?.error) throw new Error(r.error);
  return r; // { invited, sent, master }
}
```

Then pass it through at the three call sites that have the data:
- `server.js:2768` (cloud reconcile group loop) — add `invited: g.invited`
- `services/fg-roster/reconcile.js:86` — add `invited: g.invited`
- `src/connections/fg-cloud-launch.js:124` — add `invited: g.invited`

Leave `server.js:2682` (local send) and `server.js:3128` (team launch) unchanged — they stamp by Member ID, which the Apps Script resolves to a URL from the `FG Invites` row itself.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/fg-master-invited-urls.test.js tests/fg-cloud-launch.test.js tests/fg-autopilot-reconcile.test.js`
Expected: PASS — including the pre-existing cloud-launch and reconcile suites, which must not regress.

- [ ] **Step 5: Commit**

```bash
git add src/connections/fg-cloud-launch.js src/connections/fg-sync.js server.js services/fg-roster/reconcile.js tests/fg-master-invited-urls.test.js
git commit -m "feat(fg): carry LinkedIn URLs into markFgInvited for the master stamp"
```

---

### Task 5: Expose the warm records + the build route

**Files:**
- Modify: `src/connections/search-service.js` (add one export)
- Modify: `server.js` (add a status object + two routes near the other `/api/fg/*` routes, around line 2880)
- Test: `tests/fg-master-records.test.js`

**Interfaces:**
- Consumes: `getAnnotated()` (module-private in `search-service.js`), `buildMasterRows` + `invitedIndexFromFgInvites` (Task 1), `writeFgMaster` (Task 2), `getFgState` (existing).
- Produces:
  - `listMasterRecords({ dir, cachePath }): object[]` in `search-service.js` — the annotated records the master is built from (non-DNC, `hasWarm`).
  - `GET /api/fg/master/status` → the `_fgMaster` progress object.
  - `POST /api/fg/master/build` → `{ started: true }`, work continues in the background (same fire-and-forget shape as `/api/fg/send/start`).

- [ ] **Step 1: Write the failing test**

Create `tests/fg-master-records.test.js`:

```js
// tests/fg-master-records.test.js
// listMasterRecords must hand back exactly the population the master tab shows:
// warm, non-DNC records — no role filtering (the master is the whole network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listMasterRecords } from '../src/connections/search-service.js';

test('listMasterRecords is exported and returns an array', () => {
  assert.equal(typeof listMasterRecords, 'function');
  // No local DB in CI: an empty cache yields an empty list, not a throw.
  const out = listMasterRecords({ dir: 'tests/does-not-exist', cachePath: 'tests/does-not-exist.json' });
  assert.ok(Array.isArray(out));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/fg-master-records.test.js`
Expected: FAIL — `listMasterRecords is not a function`.

- [ ] **Step 3: Write the implementation**

In `src/connections/search-service.js`, add after `listFgColleagues`:

```js
// The population behind the FG Master tab: every warm, non-DNC record in the
// Connections DB. No role filter — the master is the WHOLE network, and the FG
// builder's keyword chips only ever narrowed a single run's target list.
export function listMasterRecords({ dir, cachePath } = {}) {
  return getAnnotated(dir, cachePath).filter((r) => r && !r.dnc && r.hasWarm);
}
```

In `server.js`, add the imports to the existing import lines:

```js
// alongside the other fg-sync imports (line ~97)
import { ..., writeFgMaster } from './src/connections/fg-sync.js';
// new
import { buildMasterRows, invitedIndexFromFgInvites } from './src/connections/fg-master.js';
// add to the existing search-service import
import { ..., listMasterRecords } from './src/connections/search-service.js';
```

Add the status object next to `_fgSend` and the routes near `/api/fg/sheet-url`:

```js
// FG Master build progress — polled by the UI, same shape as _fgSend.
let _fgMaster = { running: false, phase: 'idle', done: 0, total: 0, written: 0, droppedNoUrl: 0, backfilled: 0, error: null, finishedAt: null };

app.get('/api/fg/master/status', (_req, res) => res.json(_fgMaster));

// Rebuild the FG Master tab: every warm contact, with the FG Invites ledger
// folded in so a rebuild never loses invite history. Fire-and-forget — the build
// is ~56 chunked POSTs and far outlives an HTTP request.
app.post('/api/fg/master/build', async (_req, res) => {
  if (_fgMaster.running) return res.status(409).json({ error: 'A master build is already running.' });
  res.json({ started: true });
  _fgMaster = { running: true, phase: 'reading', done: 0, total: 0, written: 0, droppedNoUrl: 0, backfilled: 0, error: null, finishedAt: null };
  (async () => {
    try {
      let invitedIndex = new Map();
      try {
        const { invites } = await getFgState();
        invitedIndex = invitedIndexFromFgInvites(invites);
      } catch (e) {
        campaignLog(`[FG-master] could not read FG Invites for backfill (${e.message}) — building without it`);
      }
      _fgMaster.backfilled = invitedIndex.size;
      _fgMaster.phase = 'building';
      const records = listMasterRecords({});
      const { rows, count, droppedNoUrl } = buildMasterRows(records, invitedIndex);
      _fgMaster = { ..._fgMaster, phase: 'writing', total: count, droppedNoUrl };
      campaignLog(`[FG-master] writing ${count} row(s) (${droppedNoUrl} dropped for no LinkedIn URL)`);
      const out = await writeFgMaster(rows, { onProgress: ({ done, total }) => { _fgMaster.done = done; _fgMaster.total = total; } });
      _fgMaster = { ..._fgMaster, running: false, phase: 'done', written: out.written, finishedAt: new Date().toISOString() };
      campaignLog(`[FG-master] done — ${out.written} row(s) in "${out.tab}"`);
    } catch (err) {
      _fgMaster = { ..._fgMaster, running: false, phase: 'error', error: err.message, finishedAt: new Date().toISOString() };
      campaignLog(`[FG-master] failed: ${err.message}`);
    }
  })();
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/fg-master-records.test.js && node -e "import('./server.js').then(()=>console.log('server imports OK')).catch(e=>{console.error(e);process.exit(1)})"`
Expected: test PASS, and the server module imports without error (catches a typo'd import name).

Kill the server process afterwards if it stays up (`pkill -f "node -e"`).

- [ ] **Step 5: Commit**

```bash
git add src/connections/search-service.js server.js tests/fg-master-records.test.js
git commit -m "feat(fg): /api/fg/master/build route + warm-record selector"
```

---

### Task 6: UI button + progress

**Files:**
- Modify: `public/index.html` (FG section, next to the "Open the FG Sheet" link at line ~2301)
- Modify: `public/js/app.js` (next to `fgtlOpenSheet`, line ~2090 of the FG block)

**Interfaces:**
- Consumes: `GET /api/fg/master/status`, `POST /api/fg/master/build` (Task 5).
- Produces: no exports — DOM ids `fg-master-build`, `fg-master-status`.

- [ ] **Step 1: Add the control to `public/index.html`**

Immediately after the `<p class="fgw-lead">` that holds the "Open the FG Sheet" button (line ~2301), add:

```html
      <p class="fgw-lead" style="margin-top:6px">
        <button type="button" id="fg-master-build" class="fgw-sheet-link">Rebuild the FG Master tab</button>
        <span id="fg-master-status" class="hint"></span>
      </p>
```

- [ ] **Step 2: Wire it up in `public/js/app.js`**

Add next to `fgtlOpenSheet`:

```js
/** Rebuild the FG Master tab (whole warm network + invite ledger) and poll progress. */
async function fgMasterBuild() {
  const btn = document.getElementById('fg-master-build');
  const status = document.getElementById('fg-master-status');
  if (btn) btn.disabled = true;
  if (status) status.textContent = 'Starting…';
  try {
    const r = await fetch('/api/fg/master/build', { method: 'POST' });
    const d = await r.json();
    if (!r.ok || d.error) { if (status) status.textContent = d.error || r.statusText; if (btn) btn.disabled = false; return; }
    fgMasterPoll();
  } catch (e) {
    if (status) status.textContent = 'Could not start: ' + (e && e.message ? e.message : String(e));
    if (btn) btn.disabled = false;
  }
}

/** Poll the master build until it finishes; re-enables the button at the end. */
async function fgMasterPoll() {
  const btn = document.getElementById('fg-master-build');
  const status = document.getElementById('fg-master-status');
  try {
    const d = await (await fetch('/api/fg/master/status')).json();
    if (status) {
      if (d.phase === 'done') status.textContent = `✓ ${d.written} people written (${d.backfilled} already invited).`;
      else if (d.phase === 'error') status.textContent = 'Failed: ' + (d.error || 'unknown error');
      else if (d.total) status.textContent = `${d.phase}… ${d.done}/${d.total}`;
      else status.textContent = d.phase + '…';
    }
    if (d.running) { setTimeout(fgMasterPoll, 2000); return; }
  } catch (_) { if (status) status.textContent = 'Lost contact with the build.'; }
  if (btn) btn.disabled = false;
}
```

Bind it where the other FG buttons are bound (search `fgtl-open-sheet` for the existing `addEventListener` block and follow that pattern):

```js
  const fgMasterBtn = document.getElementById('fg-master-build');
  if (fgMasterBtn) fgMasterBtn.addEventListener('click', fgMasterBuild);
```

- [ ] **Step 3: Verify in the app**

```bash
pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "Electron.*ortus" 2>/dev/null
npm run dev:app > /tmp/dev-app.log 2>&1 &
```

Open the Follower Growth section, click **Rebuild the FG Master tab**, and confirm:
- the status line counts up (`writing… 5000/278979`, …),
- the FG sheet gains an `FG Master` tab whose row count matches the reported total,
- people invited in past runs already show `Invited` / time / account.

- [ ] **Step 4: Commit**

```bash
git add public/index.html public/js/app.js
git commit -m "feat(fg): FG Master rebuild button with live progress"
```

---

### Task 7: End-to-end verification and version bump

**Files:**
- Modify: `package.json` (version), `public/index.html` (both `?v=` query strings)

- [ ] **Step 1: Run the full test suite**

Run: `node --test tests/*.test.js`
Expected: PASS, no regressions.

- [ ] **Step 2: Verify a real stamp**

With `FG Master` built, run one FG invite (Team Launch with a single account, or the cloud reconcile of an existing pending run via the **SYNC NOW** button). Then confirm in the sheet that the invited person's `FG Master` row shows `Invited`, a UTC timestamp, and the sending account email — and that the same person's `FG Invites` row flipped as before.

- [ ] **Step 3: Bump the version**

Patch-bump `version` in `package.json` and both `?v=` query strings in `public/index.html` so operators get the new UI on relaunch.

- [ ] **Step 4: Commit**

```bash
git add package.json public/index.html
git commit -m "chore: bump version for the FG Master sheet"
```

---

## Notes for the implementer

- `data/connections-cache.json` is ~153MB and gitignored. It exists only on Antonio's machine — remote operators fall back to the central roster service, so `/api/fg/master/build` is a **local-only** action. Do not add a cloud path for it in this plan.
- The build is ~56 sequential POSTs and takes minutes. That is expected; do not add parallelism (the Apps Script serialises on a script lock anyway).
- `fgWriteMaster`'s `append` mode uses `sh.getLastRow() + 1`. If a build is interrupted, re-run it from the start — `replace` clears the tab first, so there is no double-write.
