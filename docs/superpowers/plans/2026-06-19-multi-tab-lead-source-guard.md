# Multi-Tab Lead-Source Guard — Implementation Plan (Fix A)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.
> Steps use checkbox (`- [ ]`) syntax. Spec: `docs/superpowers/specs/2026-06-19-multi-tab-lead-source-guard-design.md`.
> UI reference sketch: `public/sketches/2026-06-19-lead-source-and-429-ui.html` (A1–A3).

**Goal:** A campaign can only connect to the sheet tab the operator explicitly chose —
at paste time (picker), across reruns/restores (gid locked + change-confirm), and as a
runtime backstop (hard-stop on system/gid-less/non-lead tabs).

**Architecture:** Read path stays CSV-export (gid-aware); a new Apps Script `listTabs`
action enumerates tabs for the picker. An explicit `sheetGid` is persisted alongside
`sheetUrl` everywhere. A pure validator decides "is this a lead tab?". Frontend gains a
required tab chooser + preview + rerun change-confirm.

**Tech stack:** Node ≥22, `node --test`, Express 4, vanilla JS frontend, Google Apps
Script web app.

**Hard constraints (every task):**
- Do **NOT** modify `src/linkedin/outreach.js` or `src/linkedin/actions.js`.
- Never `git add -A`/`git add .`; stage only the files the task names. Never stage `data/`.
- Pure helpers get `node --test` unit tests; UI is manual-verify.

---

### Task 1: URL helpers (pure)

**Files:** Modify `src/utils.js`; Test `tests/sheet-url.test.js` (create).

- [ ] **Step 1 — failing tests.** `tests/sheet-url.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractSheetGid, spreadsheetIdFromUrl, withGid } from '../src/utils.js';

test('spreadsheetIdFromUrl pulls the /d/<id>/ segment', () => {
  assert.equal(
    spreadsheetIdFromUrl('https://docs.google.com/spreadsheets/d/1GHILabc/edit?gid=5#gid=5'),
    '1GHILabc');
  assert.equal(spreadsheetIdFromUrl('not a url'), '');
});

test('extractSheetGid handles #gid=, ?gid=, &gid=', () => {
  assert.equal(extractSheetGid('…/edit#gid=1249624821'), '1249624821');
  assert.equal(extractSheetGid('…/edit?gid=42'), '42');
  assert.equal(extractSheetGid('…/edit'), '');
});

test('withGid guarantees the gid in the URL, replacing any existing one', () => {
  const u = 'https://docs.google.com/spreadsheets/d/1GHILabc/edit';
  assert.match(withGid(u, '99'), /[?#]gid=99/);
  assert.match(withGid('…/edit#gid=1', '99'), /gid=99/);
  assert.doesNotMatch(withGid('…/edit#gid=1', '99'), /gid=1\b/);
  assert.equal(withGid(u, ''), u); // no gid → unchanged
});
```

- [ ] **Step 2 — run, expect FAIL** (`spreadsheetIdFromUrl`/`withGid` not exported): `node --test tests/sheet-url.test.js`
- [ ] **Step 3 — implement** in `src/utils.js` (keep existing `extractSheetGid`):

```js
export function spreadsheetIdFromUrl(url) {
  const m = String(url || '').match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : '';
}

// Return a URL that definitely carries gid=<gid>. Replaces any existing gid in
// both the query and hash. Empty gid → url unchanged.
export function withGid(url, gid) {
  const g = String(gid || '').replace(/\D/g, '');
  if (!g) return url;
  let u = String(url || '');
  u = u.replace(/([?&])gid=\d+/g, '$1gid=' + g).replace(/#gid=\d+/g, '#gid=' + g);
  if (!/[?&]gid=/.test(u) && !/#gid=/.test(u)) {
    u += (u.includes('#') ? '' : '#') + 'gid=' + g;
  }
  return u;
}
```

- [ ] **Step 4 — run, expect PASS.**
- [ ] **Step 5 — commit** (`git add src/utils.js tests/sheet-url.test.js`).

---

### Task 2: Lead-tab validators + list/fetch hardening

**Files:** Modify `src/sheets.js`; Test `tests/lead-tab-guard.test.js` (create).

- [ ] **Step 1 — failing tests** for the two PURE validators:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { isSystemTabName, looksLikeLeadRows } from '../src/sheets.js';

test('isSystemTabName flags known system tabs (case-insensitive)', () => {
  ['Recent Connections','recent messages','SavedSearch/Batches','SoO','LinkedIn Accounts','Ops Log','Events','Config']
    .forEach(n => assert.equal(isSystemTabName(n), true, n));
  assert.equal(isSystemTabName('HTECHxDELLxINT leads'), false);
});

test('looksLikeLeadRows requires First Name + a LinkedIn URL column', () => {
  const lead = [{ 'First Name':'Ryan','Last Name':'Rooijen','LinkedIn URL':'https://www.linkedin.com/in/ACwAAADy' }];
  assert.equal(looksLikeLeadRows(lead), true);
  const sys = [{ Account:'a@x.com','First Name':'Adriano','Last Name':'Lucchesi','Public ID':'adriano','Connected At':'…' }];
  assert.equal(looksLikeLeadRows(sys), false);  // no LinkedIn URL column
  assert.equal(looksLikeLeadRows([]), false);
});
```

- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement** in `src/sheets.js`:
  - `export function isSystemTabName(name)` → lowercase/trim, test against a Set:
    `recent connections, recent messages, savedsearch/batches, savedsearch, batches, soo, linkedin accounts, ops log, events, config`.
  - `export function looksLikeLeadRows(rows)` → `false` if empty; read `Object.keys(rows[0])`;
    require a first-name header (`/^first ?name$/i` across known spellings) AND a column whose
    header matches `/linkedin|url|profile|slug/i` OR whose first row value yields a URL via the
    existing `extractLinkedInUrl`. Reuse `extractLinkedInUrl` (already imported/available in campaign;
    import from its module if needed).
  - `export async function listSheetTabs(sheetUrl)` → POST `{ action:'listTabs', sheetId }` to the
    Apps Script webapp URL (same transport `sheets-writer.js` uses); return
    `[{ name, gid, rowCount, header }]`; throw a clear Error on failure.
  - **Harden `fetchSheetCsv`:** when `extractSheetGid(sheetUrl)` is empty, do **not** silently fall
    back to the first tab. Throw `Error('NO_GID: multi-tab-unsafe — sheet URL is missing #gid=')`.
    (Single-tab callers will have a gid written by the picker; legacy single-tab still works because
    the picker auto-selects + writes the gid. The run-guard in Task 5 catches anything that slips.)

- [ ] **Step 4 — run, expect PASS.**
- [ ] **Step 5 — commit** (`git add src/sheets.js tests/lead-tab-guard.test.js`).

---

### Task 3: Apps Script `listTabs` action

**Files:** Modify `google-apps-script.js`.

- [ ] **Step 1 — add action** near the existing gid-aware router (~line 361). On
  `data.action === 'listTabs'`: `SpreadsheetApp.openById(data.sheetId).getSheets()` →
  map to `{ name: s.getName(), gid: String(s.getSheetId()), rowCount: s.getLastRow(), header: <row 1 values> }`;
  return JSON `{ ok:true, tabs:[…] }`. Guard missing `sheetId` with a clear error.
- [ ] **Step 2 — no unit test** (Apps Script). Add a one-line comment: operators must
  re-paste + redeploy the script for the picker to work.
- [ ] **Step 3 — commit** (`git add google-apps-script.js`).

---

### Task 4: Server — tabs endpoint + thread sheetGid + run-guard intake

**Files:** Modify `server.js`.

- [ ] **Step 1 — endpoint** `GET /api/sheet/tabs?sheetUrl=…`: `spreadsheetIdFromUrl` → `listSheetTabs`
  → `{ tabs }`; 400 on missing/invalid url; surface listTabs errors as a clear message.
- [ ] **Step 2 — accept `sheetGid`** in the start/rerun/restore bodies (`buildCampaignConfig` and the
  re-run/queue-only paths around `server.js:879`/`:989`/`:1274`). Coerce to digits; if absent, derive
  from `extractSheetGid(sheetUrl)`. Pass `sheetGid` to `startCampaign`.
- [ ] **Step 3 — run-guard intake:** before launch, if the workbook is multi-tab (tabs>1 via a cached
  listTabs OR the request flags it) and no `sheetGid`, reject `400 { error: 'Pick the lead tab — this
  workbook has multiple tabs.' }`. (Deep guard also runs in campaign.js Task 5.)
- [ ] **Step 4 — manual check:** `curl 'localhost:7847/api/sheet/tabs?sheetUrl=<real HTECH url>'`
  returns the 4 tabs. Commit (`git add server.js`).

---

### Task 5: Campaign — persist gid, thread through rerun/restore/monitoring, run-guard

**Files:** Modify `src/campaign.js`; Test `tests/lead-source-guard.test.js` (create) for any pure decision helper.

- [ ] **Step 1 — accept `sheetGid`** in `startCampaign({…})` signature; store `campaign.sheetGid`.
  Apply `sheetUrl = withGid(sheetUrl, sheetGid)` before any `fetchSheet`.
- [ ] **Step 2 — persist** `sheetGid` into `_lastRunSettings`, the `history.json` snapshot, the
  monitoring snapshot, and read it back in `restoreCampaign` (mirror how `sheetUrl` is carried at
  `:1671`/`:4438`/`:4876`). Backfill `sheetGid` from `extractSheetGid(sheetUrl)` when an old snapshot
  lacks it.
- [ ] **Step 3 — run-guard** (pure helper `decideLeadSource({ tabCount, gid, tabName, rows })` →
  `{ ok, reason }`): abort the run (clear surfaced error, no sends) when
  `tabCount>1 && !gid`, or `isSystemTabName(tabName)`, or `!looksLikeLeadRows(rows)`. Call it right
  after the lead fetch in the start path, before the worker loop. Unit-test `decideLeadSource`.
- [ ] **Step 4 — run tests, expect PASS.** Commit (`git add src/campaign.js tests/lead-source-guard.test.js`).

---

### Task 6: Frontend — tab picker, preview, launch lock, rerun confirm

**Files:** Modify `public/index.html`, `public/js/app.js`. Manual verify. Match sketch A1–A3.

- [ ] **Step 1 — picker markup** in the Data step (after `#sheet-url`, inside `.sheet-hero`):
  a hidden `#sheet-tab-picker` (`<select id="sheet-tab-select">` + preview host `#sheet-tab-preview`),
  styled with the sketch's `.tabpick*` classes (port them into `style.css`).
- [ ] **Step 2 — populate** on `#sheet-url` input/blur (debounced): call `GET /api/sheet/tabs`; if
  `tabs.length > 1` show the picker, list `name · gid · NN rows`, mark system tabs "(not leads)";
  if `tabs.length === 1` auto-select + hide picker. On select, `previewSheet()` the chosen tab and
  render the 3-row preview + detected columns. Store the chosen gid in a field the start payload reads.
- [ ] **Step 3 — launch hard-lock:** extend the existing launch gate (same pattern as the mandatory
  primary-URL lock) — block launch when a multi-tab workbook has no tab chosen, or the chosen tab
  fails the lead-look check; show the red `.leadblock` reason (sketch A2).
- [ ] **Step 4 — start payload** carries `sheetGid` (chosen tab) alongside `sheetUrl`.
- [ ] **Step 5 — rerun confirm:** when opening/re-running a saved campaign, if the operator's chosen
  tab gid differs from the saved `sheetGid`, show the confirm modal (sketch A3) — *"You changed the
  tab from `<old>` to `<new>` — are you sure?"*; proceed only on confirm.
- [ ] **Step 6 — manual verify** in `npm run dev:app`: paste the HTECH multi-tab URL → picker lists 4
  tabs → system tab shows block → lead tab previews → launch unlocks → rerun with a different tab
  shows the confirm.

---

### Task 7: Version bump, relaunch, verification

- [ ] **Step 1 — bump** `package.json` patch version (operator rule: bump before relaunch).
- [ ] **Step 2 — full suite:** `node --test tests/*.test.js` green.
- [ ] **Step 3 — relaunch dev:app** (`pkill -f "npm.*dev:app"; pkill -f "Electron.*ortus"; npm run dev:app > /tmp/dev-app.log 2>&1 &`); confirm the version badge.
- [ ] **Step 4 — commit** version bump (`git add package.json`).
- [ ] **Step 5 — note for release:** A ships only via a manual reinstall (auto-update #15) AND requires
  every operator to re-paste + redeploy the Apps Script (Task 3).

---

## Self-review (coverage vs spec)

- Layer 1 (picker) → Tasks 3,4,6. Layer 2 (gid locked) → Tasks 1,4,5. Layer 3 (hard-stop) → Tasks 2,5,6.
- Rerun tab-change confirm → Task 6 Step 5. System-tab + lead-column guard → Tasks 2,5.
- Off-limits files untouched; gid honored on read already (Task 2 only removes the silent fallback).
