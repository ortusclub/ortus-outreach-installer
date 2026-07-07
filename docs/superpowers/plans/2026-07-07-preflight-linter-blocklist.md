# Pre-flight Lead-Sheet Linter + Company Blocklist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A hard validation gate between the wizard's Start click and campaign launch: scan lead-sheet rows for wrong-person data, blocklisted companies, malformed URLs, wrong tab/column config, and broken personalization — before any browser opens.

**Architecture:** A pure lint module (`src/preflight-lint.js`) + a local blocklist store (`src/blocklist.js` → `data/blocklist.json`) + a `POST /api/preflight` endpoint that fetches the sheet and lints it + a client overlay (per approved sketch `public/sketches/preflight-linter-B.html`) + a server-side gate in `/api/campaign/start` that refuses un-acknowledged blockers and ALWAYS excludes blocklisted rows.

**Tech Stack:** Node ≥22 ES modules, Express 4, `node --test`, vanilla JS frontend. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-07-preflight-linter-blocklist-design.md` — read it first.

## Global Constraints

- **NEVER modify `src/linkedin/outreach.js` or `src/linkedin/actions.js`** (off-limits).
- **NEVER `git add data/monitoring-campaign.json`** (tracked foot-gun; it will show modified — leave it).
- `.env` holds real credentials — never commit it.
- Blocklist matches have **no "launch anyway"** — blocklisted rows are always excluded and stamped.
- Stamp texts, verbatim: `Skipped: blocklist — <entry.value>` and `Skipped: name≠URL`.
- Name↔URL check applies to **vanity URLs only**; encoded `/in/ACwAA…` / `/sales/lead|people/ACwAA…` URLs are silently not checked.
- Blocklist check applies only to cold modes: `connect_only`, `connect_and_introduce`, `connect_and_message`, `inmail_only`, `open_profile_only`.
- Tests: `node --test tests/<file>.test.js` (no Jest/Vitest).
- Patch-bump `package.json` version before relaunching `npm run dev:app` (final task).
- UI must match the approved sketches (real classes, Bugatti command-deck: monochrome, hairlines, gold sparingly).
- Work on branch `preflight-linter-2135` off the current branch (`integrate/cloud-2.126`).

## Existing interfaces you will consume (verified 2026-07-07)

- `src/paths.js:17` — `dataPath(...segments)` → absolute path under the app data dir.
- `src/campaign.js:447` — `export function extractLinkedInUrl(row, linkedinColumn)` → URL string or null/''.
- `src/sheets.js:192` — `fetchSheetWithRows(sheetUrl)` → `[{ rowNumber, row }]` (rowNumber is 1-based sheet row).
- `src/sheets.js:263` — `listSheetTabs(sheetUrl)` → array of tab objects `{ gid, name, ... }` (throws if SHEETS_WEBAPP_URL unset).
- `src/sheets-writer.js:222` — `updateSheetRow(sheetUrl, linkedinUrl, tracking, linkedinColumn)`; pass `{ stage: '<stamp>' }` as `tracking` (this is exactly how campaign.js:3515 stamps Stage).
- `src/linkedin/helpers.js:1346` — `findUnresolvedPlaceholders(template, data)`.
- `server.js:1298` — `app.post('/api/campaign/start', …)`; `server.js:949` — `buildCampaignConfig(body)`.
- `public/js/app.js:4887` — `async function startCampaign(opts = {})`; its fetch to `/api/campaign/start` / `/api/campaign/queue-only` is at ~line 6235.

---

### Task 1: Blocklist store (`src/blocklist.js`) + API routes

**Files:**
- Create: `src/blocklist.js`
- Create: `tests/blocklist.test.js`
- Modify: `server.js` (add 3 routes near the other small JSON-store routes)

**Interfaces:**
- Consumes: `dataPath` from `src/paths.js`.
- Produces: `readBlocklist() → Entry[]`, `addEntry({value, reason, addedBy}) → Entry`, `removeEntry(value) → boolean`, `inferKind(value) → 'company'|'domain'`, where `Entry = { value: string, kind: 'company'|'domain', reason: string, addedBy: string, addedAt: string(ISO) }`. Routes: `GET /api/blocklist` → `{ entries }`, `POST /api/blocklist` body `{ value, reason }` → `{ ok, entry }`, `DELETE /api/blocklist` body `{ value }` → `{ ok }`.

- [ ] **Step 1: Write the failing test**

```js
// tests/blocklist.test.js
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Point the data dir at a temp folder BEFORE importing the module under test.
process.env.ORTUS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'blocklist-test-'));
const { readBlocklist, addEntry, removeEntry, inferKind, BLOCKLIST_FILE } =
  await import('../src/blocklist.js');

beforeEach(() => { try { fs.unlinkSync(BLOCKLIST_FILE); } catch {} });

test('inferKind: dot means domain, otherwise company', () => {
  assert.equal(inferKind('ortusclub.com'), 'domain');
  assert.equal(inferKind('IBM'), 'company');
  assert.equal(inferKind('J.P. Morgan'), 'company'); // dot but spaces → company
});

test('addEntry persists and readBlocklist round-trips', () => {
  const e = addEntry({ value: 'IBM', reason: 'existing client', addedBy: 'antonio@ortusclub.com' });
  assert.equal(e.kind, 'company');
  assert.ok(e.addedAt);
  const list = readBlocklist();
  assert.equal(list.length, 1);
  assert.equal(list[0].value, 'IBM');
});

test('addEntry is case-insensitively idempotent', () => {
  addEntry({ value: 'IBM', reason: 'client', addedBy: 'a' });
  addEntry({ value: 'ibm', reason: 'dup', addedBy: 'b' });
  assert.equal(readBlocklist().length, 1);
});

test('removeEntry removes case-insensitively and reports', () => {
  addEntry({ value: 'ortusclub.com', reason: 'employees', addedBy: 'a' });
  assert.equal(removeEntry('ORTUSCLUB.COM'), true);
  assert.equal(removeEntry('ORTUSCLUB.COM'), false);
  assert.equal(readBlocklist().length, 0);
});

test('corrupt file → empty list, no throw', () => {
  fs.mkdirSync(path.dirname(BLOCKLIST_FILE), { recursive: true });
  fs.writeFileSync(BLOCKLIST_FILE, '{not json');
  assert.deepEqual(readBlocklist(), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/blocklist.test.js`
Expected: FAIL — `Cannot find module '../src/blocklist.js'`

- [ ] **Step 3: Write the implementation**

```js
// src/blocklist.js
// Local company/domain blocklist — companies the app must never cold-contact.
// Stored per-machine in data/blocklist.json (spec decision 2026-07-07).
import fs from 'node:fs';
import path from 'node:path';
import { dataPath } from './paths.js';

export const BLOCKLIST_FILE = dataPath('blocklist.json');

export function inferKind(value) {
  const v = String(value || '').trim();
  return v.includes('.') && !v.includes(' ') ? 'domain' : 'company';
}

export function readBlocklist() {
  try {
    const raw = fs.readFileSync(BLOCKLIST_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
}

function writeBlocklist(entries) {
  fs.mkdirSync(path.dirname(BLOCKLIST_FILE), { recursive: true });
  const tmp = BLOCKLIST_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ entries }, null, 2));
  fs.renameSync(tmp, BLOCKLIST_FILE);
}

export function addEntry({ value, reason = '', addedBy = '' }) {
  const v = String(value || '').trim();
  if (!v) throw new Error('blocklist: value required');
  const entries = readBlocklist();
  const existing = entries.find((e) => e.value.toLowerCase() === v.toLowerCase());
  if (existing) return existing;
  const entry = { value: v, kind: inferKind(v), reason, addedBy, addedAt: new Date().toISOString() };
  entries.push(entry);
  writeBlocklist(entries);
  return entry;
}

export function removeEntry(value) {
  const v = String(value || '').trim().toLowerCase();
  const entries = readBlocklist();
  const next = entries.filter((e) => e.value.toLowerCase() !== v);
  if (next.length === entries.length) return false;
  writeBlocklist(next);
  return true;
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `node --test tests/blocklist.test.js`
Expected: PASS (5/5)

- [ ] **Step 5: Add the API routes in server.js**

Place next to the other small JSON routes (search for `app.get('/api/` cluster after the auth middleware — same protection level as `/api/schedules`). Import at top with the other `./src/` imports:

```js
import { readBlocklist, addEntry as addBlocklistEntry, removeEntry as removeBlocklistEntry } from './src/blocklist.js';
```

```js
// ── Company/domain blocklist (pre-flight linter) ─────────────────────────
app.get('/api/blocklist', (req, res) => {
  res.json({ entries: readBlocklist() });
});

app.post('/api/blocklist', (req, res) => {
  try {
    const entry = addBlocklistEntry({
      value: req.body?.value,
      reason: req.body?.reason || '',
      addedBy: req.body?.addedBy || '',
    });
    res.json({ ok: true, entry });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.delete('/api/blocklist', (req, res) => {
  res.json({ ok: removeBlocklistEntry(req.body?.value) });
});
```

- [ ] **Step 6: Full test suite + commit**

Run: `node --test tests/*.test.js` — expected: all pass (pre-existing failures, if any, must be noted, not introduced).

```bash
git add src/blocklist.js tests/blocklist.test.js server.js
git commit -m "feat: local company/domain blocklist store + API (preflight linter)"
```

---

### Task 2: Lint core — name↔URL mismatch, malformed URL, duplicates (`src/preflight-lint.js`)

**Files:**
- Create: `src/preflight-lint.js`
- Create: `tests/preflight-lint.test.js`

**Interfaces:**
- Consumes: `extractLinkedInUrl(row, linkedinColumn)` from `src/campaign.js`.
- Produces (used by Tasks 3–5):
  - `lintLeads({ rows, linkedinColumn, mode, templates, blocklist, tabCount, gidExplicit }) → { blockers, warnings, passed, targetCount }` where `rows = [{ rowNumber, row }]` (the `fetchSheetWithRows` shape).
  - `Finding = { check, severity, rowIndex, leadName, detail, stampText, url }` (sheet-level findings have `rowIndex: null`).
  - Pure helpers exported for tests: `vanitySlug(url)` → slug string or null (null for encoded/unparseable), `nameMatchesSlug(firstName, lastName, slug)` → boolean.

- [ ] **Step 1: Write the failing tests**

```js
// tests/preflight-lint.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintLeads, vanitySlug, nameMatchesSlug } from '../src/preflight-lint.js';

const R = (rowNumber, row) => ({ rowNumber, row });
const BASE = { linkedinColumn: 'LinkedIn URL', mode: 'connect_only', templates: {}, blocklist: [], tabCount: 1, gidExplicit: true };

test('vanitySlug extracts vanity, rejects encoded', () => {
  assert.equal(vanitySlug('https://www.linkedin.com/in/leonkatsnelson/'), 'leonkatsnelson');
  assert.equal(vanitySlug('https://linkedin.com/in/jane-doe-123abc'), 'jane-doe-123abc');
  assert.equal(vanitySlug('https://www.linkedin.com/in/ACwAAB3xYz_encoded'), null);
  assert.equal(vanitySlug('https://www.linkedin.com/sales/people/ACwAAB3xYz,NAME'), null);
  assert.equal(vanitySlug('not a url'), null);
});

test('nameMatchesSlug: real incident cases', () => {
  // Row 413: Lavanya Vemula + leonkatsnelson → mismatch
  assert.equal(nameMatchesSlug('Lavanya', 'Vemula', 'leonkatsnelson'), false);
  // Mohammed (Sajid) Omer + msajidomer → "omer" token present → match
  assert.equal(nameMatchesSlug('Sajid', 'Omer', 'msajidomer'), true);
  // hyphenated slug
  assert.equal(nameMatchesSlug('Jane', 'Doe', 'jane-doe-1a2b3c'), true);
  // single-name overlap is enough
  assert.equal(nameMatchesSlug('Leon', 'Katsnelson', 'leonkatsnelson'), true);
  // diacritics normalize
  assert.equal(nameMatchesSlug('José', 'García', 'jose-garcia'), true);
  // missing names → cannot judge → treated as match (no false alarm)
  assert.equal(nameMatchesSlug('', '', 'leonkatsnelson'), true);
});

test('lintLeads flags name_url_mismatch as blocker with stamp text', () => {
  const out = lintLeads({ ...BASE, rows: [
    R(413, { 'First Name': 'Lavanya', 'Last Name': 'Vemula', 'LinkedIn URL': 'https://www.linkedin.com/in/leonkatsnelson/' }),
  ]});
  assert.equal(out.blockers.length, 1);
  const f = out.blockers[0];
  assert.equal(f.check, 'name_url_mismatch');
  assert.equal(f.rowIndex, 413);
  assert.equal(f.leadName, 'Lavanya Vemula');
  assert.equal(f.stampText, 'Skipped: name≠URL');
});

test('encoded URLs are not name-checked', () => {
  const out = lintLeads({ ...BASE, rows: [
    R(5, { 'First Name': 'Alice', 'Last Name': 'Wong', 'LinkedIn URL': 'https://www.linkedin.com/in/ACwAAB3xYzTest' }),
  ]});
  assert.equal(out.blockers.filter(f => f.check === 'name_url_mismatch').length, 0);
});

test('malformed_url blocker for junk in the URL cell', () => {
  const out = lintLeads({ ...BASE, rows: [
    R(87, { 'First Name': 'Bob', 'Last Name': 'Ray', 'LinkedIn URL': 'htp:/linkedin,com/bob' }),
  ]});
  assert.equal(out.blockers.length, 1);
  assert.equal(out.blockers[0].check, 'malformed_url');
});

test('duplicate_url warning lists both rows', () => {
  const url = 'https://www.linkedin.com/in/vito-manzari/';
  const out = lintLeads({ ...BASE, rows: [
    R(109, { 'First Name': 'Vito', 'Last Name': 'Manzari', 'LinkedIn URL': url }),
    R(110, { 'First Name': 'Vito', 'Last Name': 'Manzari', 'LinkedIn URL': url }),
  ]});
  const dups = out.warnings.filter(f => f.check === 'duplicate_url');
  assert.equal(dups.length, 1);
  assert.match(dups[0].detail, /109/);
  assert.match(dups[0].detail, /110/);
});

test('clean rows produce no findings and count targets', () => {
  const out = lintLeads({ ...BASE, rows: [
    R(2, { 'First Name': 'Leon', 'Last Name': 'Katsnelson', 'LinkedIn URL': 'https://www.linkedin.com/in/leonkatsnelson/' }),
  ]});
  assert.equal(out.blockers.length, 0);
  assert.equal(out.warnings.length, 0);
  assert.equal(out.targetCount, 1);
});

test('rows with terminal Stage are ignored entirely', () => {
  const out = lintLeads({ ...BASE, rows: [
    R(3, { 'First Name': 'Lavanya', 'Last Name': 'Vemula', Stage: 'Done',
           'LinkedIn URL': 'https://www.linkedin.com/in/leonkatsnelson/' }),
  ]});
  assert.equal(out.blockers.length, 0);
  assert.equal(out.targetCount, 0);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/preflight-lint.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```js
// src/preflight-lint.js
// Pure pre-flight lead-sheet linter. No I/O, no browser — takes rows already
// fetched by sheets.js and returns structured findings for the launch gate.
// Spec: docs/superpowers/specs/2026-07-07-preflight-linter-blocklist-design.md
import { extractLinkedInUrl } from './campaign.js';

const COLD_MODES = new Set([
  'connect_only', 'connect_and_introduce', 'connect_and_message',
  'inmail_only', 'open_profile_only',
]);

const STAMP_NAME_MISMATCH = 'Skipped: name≠URL';

// ── helpers ────────────────────────────────────────────────────────────────

/** Vanity slug from a LinkedIn URL, or null when encoded/unparseable. */
export function vanitySlug(url) {
  const m = String(url || '').match(/linkedin\.com\/(?:in|pub)\/([^/?#,]+)/i);
  if (!m) return null;
  const slug = decodeURIComponent(m[1]).trim();
  // Encoded member IDs start with ACw/ACo etc. — never a vanity slug.
  if (/^AC[a-zA-Z0-9_-]{6,}/.test(slug)) return null;
  return slug.toLowerCase();
}

function norm(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip diacritics
    .toLowerCase().replace(/[^a-z]/g, '');
}

/**
 * True when the slug plausibly belongs to this person: ANY name token of
 * length ≥3 appears in the slug. Missing/short names → true (cannot judge —
 * never false-alarm on partial data).
 */
export function nameMatchesSlug(firstName, lastName, slug) {
  const s = norm(slug);
  const tokens = [
    ...String(firstName || '').split(/\s+/),
    ...String(lastName || '').split(/\s+/),
  ].map(norm).filter((t) => t.length >= 3);
  if (!tokens.length || !s) return true;
  return tokens.some((t) => s.includes(t));
}

function leadName(row) {
  const f = row['First Name'] || row.firstName || row.first_name || '';
  const l = row['Last Name'] || row.lastName || row.last_name || '';
  return `${f} ${l}`.trim();
}

function stageOf(row) {
  return String(row.Stage || row.stage || '').trim();
}

function normalizeUrl(url) {
  return String(url || '').toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/\/+$/, '').split('?')[0];
}

// ── main ───────────────────────────────────────────────────────────────────

export function lintLeads({ rows, linkedinColumn, mode, templates = {}, blocklist = [], tabCount = 1, gidExplicit = true }) {
  const blockers = [];
  const warnings = [];
  const passed = [];

  // Only rows the campaign would process: blank Stage (cold) / non-terminal.
  const targets = (rows || []).filter(({ row }) => !stageOf(row));

  const seenUrls = new Map(); // normalized url → [rowNumbers]
  for (const { rowNumber, row } of targets) {
    const name = leadName(row);
    const rawCell = linkedinColumn ? row[linkedinColumn] : '';
    let url = '';
    try { url = extractLinkedInUrl(row, linkedinColumn) || ''; } catch { url = ''; }

    if (!url) {
      if (String(rawCell || '').trim()) {
        blockers.push({
          check: 'malformed_url', severity: 'blocker', rowIndex: rowNumber, leadName: name,
          detail: `URL cell contains "${String(rawCell).slice(0, 60)}" — not a LinkedIn profile URL`,
          stampText: 'Skipped: malformed URL', url: '',
        });
      }
      continue; // empty cell rows are simply not targets
    }

    const nu = normalizeUrl(url);
    if (!seenUrls.has(nu)) seenUrls.set(nu, []);
    seenUrls.get(nu).push(rowNumber);

    const slug = vanitySlug(url);
    if (slug && !nameMatchesSlug(
      row['First Name'] || row.firstName || row.first_name,
      row['Last Name'] || row.lastName || row.last_name,
      slug,
    )) {
      blockers.push({
        check: 'name_url_mismatch', severity: 'blocker', rowIndex: rowNumber, leadName: name,
        detail: `Name "${name}" doesn't match URL slug "${slug}"`,
        stampText: STAMP_NAME_MISMATCH, url,
      });
    }
  }

  for (const [nu, rowNums] of seenUrls) {
    if (rowNums.length > 1) {
      warnings.push({
        check: 'duplicate_url', severity: 'warning', rowIndex: rowNums[0], leadName: '',
        detail: `Same profile in rows ${rowNums.join(', ')} (${nu}) — only the first would be contacted`,
        stampText: '', url: nu,
      });
    }
  }

  return {
    blockers, warnings, passed,
    targetCount: targets.length,
    _targets: targets, // consumed internally by Task 3's checks
  };
}
```

(Note: `passed`, blocklist, template and sheet-level checks are Task 3 — this task must leave `blocklist`, `templates`, `tabCount`, `gidExplicit` accepted-but-unused so the signature is final now.)

- [ ] **Step 4: Run tests, verify pass**

Run: `node --test tests/preflight-lint.test.js` — expected: PASS. Also `node --test tests/*.test.js` to confirm nothing else broke (importing campaign.js pulls its module graph; if that import has side effects that break under test, wrap the import: `const { extractLinkedInUrl } = await import('./campaign.js')` is NOT acceptable — instead verify `node --test` passes; if campaign.js side effects are a problem, copy the 24-line `extractLinkedInUrl` body into preflight-lint.js with a comment `// mirrored from campaign.js:447 — campaign.js import is side-effectful` and add a test asserting both produce identical output for 3 sample rows).

- [ ] **Step 5: Commit**

```bash
git add src/preflight-lint.js tests/preflight-lint.test.js
git commit -m "feat: preflight lint core — name↔URL mismatch, malformed URL, duplicates"
```

---

### Task 3: Lint completion — blocklist matching, template vars, sheet-level checks, passed list

**Files:**
- Modify: `src/preflight-lint.js`
- Modify: `tests/preflight-lint.test.js` (append tests)

**Interfaces:**
- Consumes: `findUnresolvedPlaceholders(template, data)` from `src/linkedin/helpers.js`; `Entry` shape from Task 1.
- Produces: final `lintLeads` behavior — adds `blocklist_match` blockers, `empty_template_var` + `list_vs_limit` warnings, `column_invalid` + `ambiguous_tab` sheet-level blockers, and `passed` entries `{ check, detail }`. New optional args used: `dailyLimit`, `accountCount`.

- [ ] **Step 1: Append failing tests**

```js
// append to tests/preflight-lint.test.js
const IBM = { value: 'IBM', kind: 'company', reason: 'existing client', addedBy: '', addedAt: '' };
const ORTUS = { value: 'ortusclub.com', kind: 'domain', reason: 'employees', addedBy: '', addedAt: '' };

test('blocklist company match is a blocker with the exact stamp, word-boundary safe', () => {
  const out = lintLeads({ ...BASE, blocklist: [IBM], rows: [
    R(44, { 'First Name': 'Ann', 'Last Name': 'Lee', Company: 'IBM', 'LinkedIn URL': 'https://linkedin.com/in/ann-lee-ibm' }),
    R(45, { 'First Name': 'Zed', 'Last Name': 'Ka', Company: 'Ibmara Consulting', 'LinkedIn URL': 'https://linkedin.com/in/zed-ka' }),
  ]});
  const hits = out.blockers.filter(f => f.check === 'blocklist_match');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].rowIndex, 44);
  assert.equal(hits[0].stampText, 'Skipped: blocklist — IBM');
});

test('blocklist domain match on email column, suffix-safe', () => {
  const out = lintLeads({ ...BASE, blocklist: [ORTUS], rows: [
    R(7, { 'First Name': 'Dion', 'Last Name': 'X', Email: 'dion@mail.ortusclub.com', 'LinkedIn URL': 'https://linkedin.com/in/dion-x' }),
    R(8, { 'First Name': 'Ok', 'Last Name': 'Y', Email: 'ok@notortusclub.com.example', 'LinkedIn URL': 'https://linkedin.com/in/ok-y' }),
  ]});
  const hits = out.blockers.filter(f => f.check === 'blocklist_match');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].rowIndex, 7);
});

test('blocklist does NOT apply to non-cold modes', () => {
  const out = lintLeads({ ...BASE, mode: 'message_only', blocklist: [IBM], rows: [
    R(44, { 'First Name': 'Ann', 'Last Name': 'Lee', Company: 'IBM', 'LinkedIn URL': 'https://linkedin.com/in/ann-lee-ibm' }),
  ]});
  assert.equal(out.blockers.filter(f => f.check === 'blocklist_match').length, 0);
});

test('empty_template_var warning counts affected rows', () => {
  const out = lintLeads({ ...BASE,
    templates: { connectionNote: 'Hi {first name} from {company}!' },
    rows: [
      R(2, { 'First Name': 'A', 'Last Name': 'B', Company: '', 'LinkedIn URL': 'https://linkedin.com/in/a-b1' }),
      R(3, { 'First Name': 'C', 'Last Name': 'D', Company: 'Acme', 'LinkedIn URL': 'https://linkedin.com/in/c-d2' }),
    ]});
  const w = out.warnings.find(f => f.check === 'empty_template_var');
  assert.ok(w);
  assert.match(w.detail, /\{company\}/);
  assert.match(w.detail, /1 row/);
});

test('column_invalid when the configured column is missing from headers', () => {
  const out = lintLeads({ ...BASE, linkedinColumn: 'LinkedIn Url' /* typo */, rows: [
    R(2, { 'First Name': 'A', 'Last Name': 'B', 'LinkedIn URL': 'https://linkedin.com/in/a-b1' }),
  ]});
  assert.ok(out.blockers.find(f => f.check === 'column_invalid' && f.rowIndex === null));
});

test('ambiguous_tab blocker when no explicit gid and multiple tabs', () => {
  const out = lintLeads({ ...BASE, gidExplicit: false, tabCount: 4, rows: [
    R(2, { 'First Name': 'A', 'Last Name': 'B', 'LinkedIn URL': 'https://linkedin.com/in/a-b1' }),
  ]});
  assert.ok(out.blockers.find(f => f.check === 'ambiguous_tab'));
});

test('passed list confirms column + target count on a clean run', () => {
  const out = lintLeads({ ...BASE, rows: [
    R(2, { 'First Name': 'Leon', 'Last Name': 'Katsnelson', 'LinkedIn URL': 'https://www.linkedin.com/in/leonkatsnelson/' }),
  ]});
  assert.ok(out.passed.find(p => p.check === 'column_found'));
  assert.ok(out.passed.find(p => p.check === 'targets_found' && /1/.test(p.detail)));
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `node --test tests/preflight-lint.test.js` — expected: the 7 new tests FAIL, prior ones still pass.

- [ ] **Step 3: Implement in `src/preflight-lint.js`**

Add near the top:

```js
import { findUnresolvedPlaceholders } from './linkedin/helpers.js';

const COMPANY_ALIASES = ['Company', 'company', 'Company Name', 'Organization'];
const EMAIL_ALIASES = ['Email', 'email', 'E-mail', 'Email Address'];

function firstCell(row, aliases) {
  for (const a of aliases) if (row[a] != null && String(row[a]).trim()) return String(row[a]).trim();
  return '';
}

function companyMatches(company, entryValue) {
  // Word-boundary match: "IBM" hits "IBM" / "IBM Corp", not "Ibmara".
  const re = new RegExp(`(^|[^a-z0-9])${entryValue.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i');
  return re.test(company);
}

function domainMatches(email, entryValue) {
  const at = email.lastIndexOf('@');
  if (at < 0) return false;
  const dom = email.slice(at + 1).toLowerCase();
  const v = entryValue.toLowerCase();
  return dom === v || dom.endsWith('.' + v);
}
```

Inside `lintLeads`, in the per-target loop (after the URL is resolved), add:

```js
    // Blocklist — cold modes only, no override, exact stamp text.
    if (COLD_MODES.has(mode)) {
      for (const entry of blocklist) {
        const hit = entry.kind === 'domain'
          ? domainMatches(firstCell(row, EMAIL_ALIASES), entry.value)
          : companyMatches(firstCell(row, COMPANY_ALIASES), entry.value);
        if (hit) {
          blockers.push({
            check: 'blocklist_match', severity: 'blocker', rowIndex: rowNumber, leadName: name,
            detail: `${entry.kind === 'domain' ? 'Email domain' : 'Company'} matches blocklist entry "${entry.value}"${entry.reason ? ` (${entry.reason})` : ''}`,
            stampText: `Skipped: blocklist — ${entry.value}`, url,
          });
          break; // one blocklist finding per row is enough
        }
      }
    }
```

After the duplicate loop, add the remaining checks:

```js
  // Template variables that resolve empty for target rows.
  const activeTemplates = Object.values(templates).filter((t) => typeof t === 'string' && t.includes('{'));
  if (activeTemplates.length && targets.length) {
    const missCount = new Map(); // token → { rows: [] }
    for (const { rowNumber, row } of targets) {
      for (const tpl of activeTemplates) {
        for (const token of findUnresolvedPlaceholders(tpl, row)) {
          // campaign-level tokens are filled at send time, not from the row
          if (/primary|event|intro/i.test(token)) continue;
          if (!missCount.has(token)) missCount.set(token, []);
          const arr = missCount.get(token);
          if (!arr.includes(rowNumber)) arr.push(rowNumber);
        }
      }
    }
    for (const [token, rowNums] of missCount) {
      warnings.push({
        check: 'empty_template_var', severity: 'warning', rowIndex: rowNums[0], leadName: '',
        detail: `${token} is empty in ${rowNums.length} row(s) (${rowNums.slice(0, 10).join(', ')}${rowNums.length > 10 ? ', …' : ''}) — the message would render with a gap`,
        stampText: '', url: '',
      });
    }
  }

  // Sheet-level: configured LinkedIn column must exist in the headers.
  const headerSample = rows?.[0]?.row || {};
  if (linkedinColumn && !(linkedinColumn in headerSample)) {
    blockers.push({
      check: 'column_invalid', severity: 'blocker', rowIndex: null, leadName: '',
      detail: `Column "${linkedinColumn}" not found — headers are: ${Object.keys(headerSample).slice(0, 12).join(', ')}`,
      stampText: '', url: '',
    });
  } else {
    passed.push({ check: 'column_found', detail: `LinkedIn column "${linkedinColumn || '(auto)'}" found` });
  }

  // Sheet-level: ambiguous tab (no explicit gid on a multi-tab spreadsheet).
  if (!gidExplicit && tabCount > 1) {
    blockers.push({
      check: 'ambiguous_tab', severity: 'blocker', rowIndex: null, leadName: '',
      detail: `Sheet URL has no explicit tab (#gid) and the spreadsheet has ${tabCount} tabs — the FIRST tab would be read`,
      stampText: '', url: '',
    });
  } else {
    passed.push({ check: 'tab_resolved', detail: gidExplicit ? 'Tab explicitly selected' : 'Single-tab sheet' });
  }

  if (targets.length) passed.push({ check: 'targets_found', detail: `${targets.length} target row(s) ready` });

  // Sanity: list far larger than 2 weeks of capacity.
  if (dailyLimit && accountCount && targets.length > 14 * dailyLimit * accountCount) {
    warnings.push({
      check: 'list_vs_limit', severity: 'warning', rowIndex: null, leadName: '',
      detail: `${targets.length} targets vs ~${dailyLimit * accountCount}/day capacity — over two weeks of sending`,
      stampText: '', url: '',
    });
  }
```

Update the signature to `lintLeads({ rows, linkedinColumn, mode, templates = {}, blocklist = [], tabCount = 1, gidExplicit = true, dailyLimit = 0, accountCount = 0 })` and remove the `_targets` internal export (no longer needed once checks are inline).

- [ ] **Step 4: Run tests, verify pass**

Run: `node --test tests/preflight-lint.test.js` — expected: ALL pass.

- [ ] **Step 5: Commit**

```bash
git add src/preflight-lint.js tests/preflight-lint.test.js
git commit -m "feat: preflight lint — blocklist, template vars, column/tab checks, passed list"
```

---

### Task 4: Server — `POST /api/preflight` + launch gate in `/api/campaign/start`

**Files:**
- Modify: `server.js` (new endpoint + gate inside the `/api/campaign/start` handler at line ~1298; the queue path reuses the same handler body via `buildCampaignConfig`)
- Create: `tests/preflight-gate.test.js` (pure gate-decision helper test)

**Interfaces:**
- Consumes: `lintLeads` (Task 3), `readBlocklist` (Task 1), `fetchSheetWithRows`/`listSheetTabs` from `src/sheets.js`, `extractSheetGid` from `src/utils.js` (verify export name with `grep -n "extractSheetGid" src/utils.js`; it's also imported by `src/sheets-writer.js:8` — copy that import style).
- Produces: `POST /api/preflight` → `{ ok, findings: { blockers, warnings, passed, targetCount }, ack }`; gate helper `decidePreflightGate({ findings, ackProvided, ackExpected }) → { allow, excludeRows, reason }` exported from a new small module `src/preflight-gate.js` so it's unit-testable.

- [ ] **Step 1: Write the failing gate test**

```js
// tests/preflight-gate.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decidePreflightGate, ackFor } from '../src/preflight-gate.js';

const BL = { check: 'blocklist_match', severity: 'blocker', rowIndex: 44, stampText: 'Skipped: blocklist — IBM', url: 'https://x/in/a' };
const NM = { check: 'name_url_mismatch', severity: 'blocker', rowIndex: 413, stampText: 'Skipped: name≠URL', url: 'https://x/in/b' };

test('no blockers → allow, nothing excluded', () => {
  const d = decidePreflightGate({ findings: { blockers: [] }, ackProvided: '', ackExpected: '' });
  assert.equal(d.allow, true);
  assert.deepEqual(d.excludeRows, []);
});

test('blockers without ack → refuse', () => {
  const findings = { blockers: [NM] };
  const d = decidePreflightGate({ findings, ackProvided: '', ackExpected: ackFor(findings) });
  assert.equal(d.allow, false);
});

test('blockers with matching ack → allow, but blocklist rows ALWAYS excluded', () => {
  const findings = { blockers: [BL, NM] };
  const ack = ackFor(findings);
  const d = decidePreflightGate({ findings, ackProvided: ack, ackExpected: ack });
  assert.equal(d.allow, true);
  // ack acknowledges name-mismatch (operator chose launch-anyway) but blocklist is never overridable
  assert.deepEqual(d.excludeRows, [BL]);
});

test('stale ack (findings changed) → refuse', () => {
  const findings = { blockers: [BL, NM] };
  const d = decidePreflightGate({ findings, ackProvided: ackFor({ blockers: [NM] }), ackExpected: ackFor(findings) });
  assert.equal(d.allow, false);
});
```

- [ ] **Step 2: Run to verify failure**, then **Step 3: implement `src/preflight-gate.js`**

```js
// src/preflight-gate.js
// Pure launch-gate decision for pre-flight findings. The ack token proves the
// operator saw EXACTLY these findings; blocklist rows are excluded regardless.
import crypto from 'node:crypto';

export function ackFor(findings) {
  const keys = (findings?.blockers || [])
    .map((f) => `${f.check}:${f.rowIndex}:${f.url || ''}`)
    .sort()
    .join('|');
  return crypto.createHash('sha256').update(keys).digest('hex').slice(0, 16);
}

export function decidePreflightGate({ findings, ackProvided, ackExpected }) {
  const blockers = findings?.blockers || [];
  const blocklistRows = blockers.filter((f) => f.check === 'blocklist_match');
  if (!blockers.length) return { allow: true, excludeRows: [], reason: 'clean' };
  if (!ackProvided || ackProvided !== ackExpected) {
    return { allow: false, excludeRows: [], reason: 'unacknowledged blockers — run pre-flight first' };
  }
  return { allow: true, excludeRows: blocklistRows, reason: 'acknowledged' };
}
```

- [ ] **Step 4: Run gate tests — PASS**, commit checkpoint:

```bash
git add src/preflight-gate.js tests/preflight-gate.test.js
git commit -m "feat: preflight gate decision helper (ack token, blocklist always excluded)"
```

- [ ] **Step 5: Add `/api/preflight` to server.js**

Imports at top (with the other src imports):

```js
import { lintLeads } from './src/preflight-lint.js';
import { ackFor, decidePreflightGate } from './src/preflight-gate.js';
import { fetchSheetWithRows, listSheetTabs } from './src/sheets.js';
```

(`readBlocklist` already imported in Task 1. If `fetchSheetWithRows`/`listSheetTabs` are already imported, extend the existing import line instead.)

Endpoint — place directly above `app.post('/api/campaign/start', …)` (server.js:1298):

```js
// ── Pre-flight lead-sheet linter (runs on Start click, before launch) ─────
// In-memory ack registry: token → expiry. Proves the operator saw exactly
// these findings when /api/campaign/start later carries preflightAck.
const _preflightAcks = new Map();
function _registerAck(token) {
  _preflightAcks.set(token, Date.now() + 15 * 60 * 1000); // 15-min validity
  for (const [t, exp] of _preflightAcks) if (exp < Date.now()) _preflightAcks.delete(t);
}

app.post('/api/preflight', async (req, res) => {
  try {
    const body = req.body || {};
    const sheetUrl = String(body.sheetUrl || '');
    if (!sheetUrl) return res.status(400).json({ ok: false, error: 'sheetUrl required' });

    const rows = await fetchSheetWithRows(sheetUrl);

    // Tab ambiguity: explicit gid in the URL? how many tabs?
    const gidExplicit = /[#&?]gid=\d+/.test(sheetUrl);
    let tabCount = 1;
    if (!gidExplicit) {
      try { tabCount = (await listSheetTabs(sheetUrl)).length || 1; }
      catch { tabCount = 1; } // tabs unlistable → don't invent a blocker
    }

    const findings = lintLeads({
      rows,
      linkedinColumn: body.linkedinColumn || '',
      mode: body.mode || 'connect_only',
      templates: body.templates || {},
      blocklist: readBlocklist(),
      tabCount,
      gidExplicit,
      dailyLimit: Number(body.dailyLimit) || 0,
      accountCount: Array.isArray(body.profileIds) ? body.profileIds.length : 0,
    });
    delete findings._targets;

    const ack = ackFor(findings);
    _registerAck(ack);
    res.json({ ok: true, findings, ack });
  } catch (err) {
    // Sheet unreachable/429 etc. — surfaced now instead of at campaign start.
    res.status(502).json({ ok: false, error: `Pre-flight could not read the sheet: ${err.message}` });
  }
});
```

- [ ] **Step 6: Gate inside `/api/campaign/start`**

At the TOP of the `app.post('/api/campaign/start', …)` handler body (before `buildCampaignConfig` is called at ~line 1330), insert:

```js
  // ── Pre-flight gate (spec 2026-07-07): refuse un-acknowledged blockers;
  // blocklisted rows are excluded server-side regardless of the client.
  try {
    const gateRows = await fetchSheetWithRows(String(req.body?.sheetUrl || ''));
    const gateGidExplicit = /[#&?]gid=\d+/.test(String(req.body?.sheetUrl || ''));
    let gateTabs = 1;
    if (!gateGidExplicit) { try { gateTabs = (await listSheetTabs(req.body.sheetUrl)).length || 1; } catch {} }
    const gateFindings = lintLeads({
      rows: gateRows,
      linkedinColumn: req.body?.linkedinColumn || '',
      mode: req.body?.mode || 'connect_only',
      templates: req.body?.templates || {},
      blocklist: readBlocklist(),
      tabCount: gateTabs,
      gidExplicit: gateGidExplicit,
    });
    const expected = ackFor(gateFindings);
    const provided = String(req.body?.preflightAck || '');
    const ackKnown = _preflightAcks.has(provided) && provided === expected;
    const gate = decidePreflightGate({ findings: gateFindings, ackProvided: ackKnown ? provided : '', ackExpected: expected });
    if (!gate.allow) {
      return res.status(409).json({ error: `Pre-flight blockers found (${gateFindings.blockers.length}) — run the pre-flight check`, preflight: true });
    }
    // Hard exclusion: blocklisted URLs never reach the campaign, ever.
    if (gate.excludeRows.length) {
      req.body._preflightExcludedUrls = gate.excludeRows.map((f) => f.url).filter(Boolean);
    }
  } catch (gateErr) {
    // If the sheet cannot be read the campaign couldn't run anyway — refuse loudly.
    return res.status(502).json({ error: `Pre-flight gate could not read the sheet: ${gateErr.message}` });
  }
```

Then thread the exclusion into the campaign: in `buildCampaignConfig(body)` (server.js:949) add to the returned config object:

```js
    excludedUrls: Array.isArray(body._preflightExcludedUrls) ? body._preflightExcludedUrls : [],
```

And in `src/campaign.js`, in the pre-filter where targets are selected (the `_isTarget` filter around line 2486 — search for `rows.filter(_isTarget)`), add immediately before it:

```js
  // Pre-flight hard exclusions (blocklist) — normalized-URL match.
  const _pfExcluded = new Set((config.excludedUrls || []).map((u) =>
    String(u).toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/\/+$/, '').split('?')[0]));
  if (_pfExcluded.size) {
    const before = rows.length;
    rows = rows.filter((r) => {
      const u = extractLinkedInUrl(r, linkedinColumn) || '';
      const nu = u.toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/\/+$/, '').split('?')[0];
      return !_pfExcluded.has(nu);
    });
    if (rows.length !== before) log(`Pre-flight: ${before - rows.length} blocklisted row(s) excluded`);
  }
```

(Adjust `rows`/`linkedinColumn`/`config` to the actual local variable names at that point in `startCampaign` — read the surrounding 30 lines first. If `rows` is `const`, filter into a new variable and use it downstream consistently.)

- [ ] **Step 7: Verify + commit**

Run: `node --test tests/*.test.js` — all pass. Start the app (`npm run dev:app`), then from a shell:
`curl -s -X POST localhost:7847/api/preflight -H 'Content-Type: application/json' -d '{"sheetUrl":"<a real test sheet URL>","linkedinColumn":"LinkedIn URL","mode":"connect_only"}' | head -c 600`
Expected: JSON with `ok:true`, findings arrays, and an `ack` hex string.

```bash
git add server.js src/campaign.js
git commit -m "feat: /api/preflight endpoint + server-side launch gate with ack token"
```

---

### Task 5: Client — overlay UI, exclude-and-launch stamping, blocklist panel

**Files:**
- Modify: `public/index.html` (overlay + blocklist panel markup)
- Modify: `public/js/app.js` (wire Start click through preflight; overlay logic; blocklist panel logic)
- Modify: `public/css/style.css` (overlay styles — port from the approved sketch)

**Interfaces:**
- Consumes: `POST /api/preflight` → `{ ok, findings, ack }` (Task 4); `GET/POST/DELETE /api/blocklist` (Task 1); existing `startCampaign(opts)` at app.js:4887 whose fetch to `/api/campaign/start` is at ~6235; `updateSheetRow`-equivalent stamping goes through a new endpoint below.
- Produces: `POST /api/preflight/stamp` (server.js) body `{ sheetUrl, linkedinColumn, stamps: [{ url, stampText }] }` → `{ ok, stamped, failed }` (uses `updateSheetRow(sheetUrl, url, { stage: stampText }, linkedinColumn)` per row — same call shape as campaign.js:3515).

**Visual contract:** `public/sketches/preflight-linter-B.html` (overlay: `#pf-scrim` full-screen scrim, solid `var(--bg,#fff)` panel, tally chips, three collapsible groups with counts, one 3-column row per finding — row # | lead | one-line reason) and `public/sketches/company-blocklist-A.html` (management panel). Copy the sketch markup/classes; do not redesign.

- [ ] **Step 1: Add the stamp endpoint (server.js, next to /api/preflight)**

```js
app.post('/api/preflight/stamp', async (req, res) => {
  const { sheetUrl, linkedinColumn, stamps } = req.body || {};
  if (!sheetUrl || !Array.isArray(stamps)) return res.status(400).json({ ok: false, error: 'sheetUrl and stamps required' });
  let stamped = 0; const failed = [];
  for (const s of stamps) {
    try {
      const ok = await updateSheetRow(sheetUrl, s.url, { stage: s.stampText }, linkedinColumn || '');
      if (ok) stamped++; else failed.push(s.url);
    } catch { failed.push(s.url); }
  }
  res.json({ ok: failed.length === 0, stamped, failed });
});
```

(`updateSheetRow` is already imported in server.js? Verify with `grep -n "updateSheetRow" server.js` — if not, import from `./src/sheets-writer.js`.)

- [ ] **Step 2: Overlay markup in `public/index.html`**

Port the `#pf-scrim` overlay block from `public/sketches/preflight-linter-B.html` (the panel with tally chips, `❌ Blockers`, `⚠ Warnings`, `✓ Passed` groups and the action row) into `index.html`, just before `</body>`, with empty group containers (`<div id="pf-blockers">` etc.) — content is rendered by JS. Keep the sketch's four buttons with ids: `pf-fix`, `pf-exclude`, `pf-anyway`, `pf-cancel`. Add a "Manage blocklist" link (`id="pf-manage-bl"`) in the blocklist group header. Port the blocklist management panel from `company-blocklist-A.html` as a second overlay `#bl-scrim` (list container `#bl-list`, inputs `#bl-value`, `#bl-reason`, add button `#bl-add`).

- [ ] **Step 3: Overlay + blocklist logic in `public/js/app.js`**

Add near the other campaign helpers:

```js
// ── Pre-flight linter (spec 2026-07-07) ────────────────────────────────────
let _pfState = null; // { findings, ack, payload }

async function runPreflight(payload) {
  const r = await fetch('/api/preflight', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) throw new Error(data.error || r.statusText);
  return data;
}

function renderPreflight({ findings }) {
  const fill = (id, list, isFinding) => {
    const el = document.getElementById(id);
    el.innerHTML = list.map((f) => isFinding
      ? `<div class="pf-row"><span class="pf-rownum">${f.rowIndex ?? '—'}</span><span class="pf-lead">${escapeHtml(f.leadName || '')}</span><span class="pf-why">${escapeHtml(f.detail)}</span></div>`
      : `<div class="pf-row pf-pass"><span class="pf-why">✓ ${escapeHtml(f.detail)}</span></div>`
    ).join('') || '<div class="pf-row pf-empty">none</div>';
  };
  fill('pf-blockers', findings.blockers, true);
  fill('pf-warnings', findings.warnings, true);
  fill('pf-passed', findings.passed, false);
  document.getElementById('pf-count-blockers').textContent = findings.blockers.length;
  document.getElementById('pf-count-warnings').textContent = findings.warnings.length;
  document.getElementById('pf-count-passed').textContent = findings.passed.length;
  // Blocklist findings are never overridable: relabel "Launch anyway" accordingly.
  const hasBl = findings.blockers.some((f) => f.check === 'blocklist_match');
  const onlyBl = hasBl && findings.blockers.every((f) => f.check === 'blocklist_match');
  const anyway = document.getElementById('pf-anyway');
  anyway.textContent = hasBl ? 'Exclude blocklisted & launch anyway' : 'Launch anyway';
  anyway.style.display = findings.blockers.length || findings.warnings.length ? '' : 'none';
  document.getElementById('pf-scrim').style.display = 'flex';
}

function closePreflight() { document.getElementById('pf-scrim').style.display = 'none'; }

async function stampExcluded(stampables) {
  if (!stampables.length) return { ok: true, stamped: 0, failed: [] };
  const r = await fetch('/api/preflight/stamp', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sheetUrl: _pfState.payload.sheetUrl,
      linkedinColumn: _pfState.payload.linkedinColumn,
      stamps: stampables.map((f) => ({ url: f.url, stampText: f.stampText })),
    }),
  });
  return r.json().catch(() => ({ ok: false, stamped: 0, failed: [] }));
}
```

Button wiring (same section):

```js
document.getElementById('pf-cancel').onclick = closePreflight;
document.getElementById('pf-fix').onclick = () => {
  if (_pfState?.payload?.sheetUrl) window.open(_pfState.payload.sheetUrl, '_blank');
};
document.getElementById('pf-exclude').onclick = async () => {
  const stampables = _pfState.findings.blockers.filter((f) => f.url && f.stampText);
  const res = await stampExcluded(stampables);
  if (!res.ok) showCampaignToast(`${res.failed.length} of ${stampables.length} stamps failed — those rows may reappear next launch`, 7000);
  closePreflight();
  _launchWithAck();
};
document.getElementById('pf-anyway').onclick = async () => {
  // Blocklisted rows are stamped+excluded even on "anyway" (never overridable).
  const bl = _pfState.findings.blockers.filter((f) => f.check === 'blocklist_match');
  if (bl.length) await stampExcluded(bl);
  closePreflight();
  _launchWithAck();
};
function _launchWithAck() {
  startCampaign({ ..._pfState.opts, _preflightAck: _pfState.ack, _skipPreflight: true });
}
```

- [ ] **Step 4: Wire the Start click through preflight**

In `startCampaign(opts = {})` (app.js:4887) the request body is built deep inside the function. The clean insertion point is immediately BEFORE the `fetch(url, …)` at ~6235 — at that point the assembled request-body object exists (read the 20 surrounding lines to learn its local name; called `body` below). Insert there:

```js
    // ── Pre-flight gate (spec 2026-07-07) ──────────────────────────────
    if (!opts._skipPreflight) {
      try {
        const pf = await runPreflight({
          sheetUrl: body.sheetUrl, linkedinColumn: body.linkedinColumn,
          mode: body.mode, templates: body.templates,
          dailyLimit: body.dailyLimit, profileIds: body.profileIds,
        });
        _pfState = { findings: pf.findings, ack: pf.ack, payload: body, opts };
        if (pf.findings.blockers.length || pf.findings.warnings.length) {
          renderPreflight(pf);   // overlay takes over; its buttons re-enter with _skipPreflight
          return;
        }
        body.preflightAck = pf.ack; // clean run — attach ack and continue
      } catch (err) {
        showCampaignToast(`Pre-flight failed: ${err.message}`, 7000);
        return;
      }
    } else if (opts._preflightAck) {
      body.preflightAck = opts._preflightAck;
    }
```

(Adapt the local variable name if it isn't `body` — read the 20 lines around the fetch first. `_launchWithAck` must re-invoke `startCampaign` with the SAME opts the original call had — store them in `_pfState.opts` as shown.)

- [ ] **Step 5: Blocklist panel logic**

```js
async function openBlocklistPanel() {
  const r = await fetch('/api/blocklist').then((x) => x.json()).catch(() => ({ entries: [] }));
  const list = document.getElementById('bl-list');
  list.innerHTML = (r.entries || []).map((e) =>
    `<div class="bl-row"><b>${escapeHtml(e.value)}</b><span>${escapeHtml(e.reason || '')}</span><span class="bl-meta">${escapeHtml(e.addedBy || '')} · ${(e.addedAt || '').slice(0, 10)}</span><button class="bl-remove" data-v="${escapeHtml(e.value)}">Remove</button></div>`
  ).join('') || '<div class="bl-row bl-empty">No entries yet</div>';
  list.querySelectorAll('.bl-remove').forEach((btn) => btn.onclick = async () => {
    await fetch('/api/blocklist', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: btn.dataset.v }) });
    openBlocklistPanel();
  });
  document.getElementById('bl-scrim').style.display = 'flex';
}
document.getElementById('pf-manage-bl').onclick = openBlocklistPanel;
document.getElementById('bl-add').onclick = async () => {
  const value = document.getElementById('bl-value').value.trim();
  if (!value) return;
  await fetch('/api/blocklist', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value, reason: document.getElementById('bl-reason').value.trim(), addedBy: (window.operatorEmail || '') }) });
  document.getElementById('bl-value').value = ''; document.getElementById('bl-reason').value = '';
  openBlocklistPanel();
};
```

(If `escapeHtml` doesn't exist in app.js, `grep -n "function escapeHtml" public/js/app.js`; if absent, add the standard 5-replacement implementation next to these helpers.)

- [ ] **Step 6: Styles**

Port the `.pf-*` and `.bl-*` rules from the two sketches into `public/css/style.css` under a clearly-commented section `/* ── Pre-flight linter overlay (spec 2026-07-07) ── */`. Solid panel background `var(--bg, #fff)` (NOT `--card-bg` — it's translucent). Monochrome; gold only on warning accents.

- [ ] **Step 7: Manual verification (mandatory, with screenshots via playwright or by hand)**

1. `npm run dev:app`, open the wizard, configure a TEST sheet (make one with: a Lavanya/leonkatsnelson-style row, a malformed URL row, two duplicate rows, one row with Company=IBM after adding IBM to the blocklist, and clean rows).
2. Click Start → overlay appears with the right groups/counts; visual match vs `preflight-linter-B.html`.
3. "Exclude flagged rows & launch" → sheet shows `Skipped: blocklist — IBM` / `Skipped: name≠URL` in Stage on the right rows; campaign starts with only clean rows.
4. Re-run: previously stamped rows no longer appear as findings (terminal Stage → not targets).
5. "Launch anyway" with a blocklist row present → blocklisted row STILL stamped+excluded.
6. `curl -X POST localhost:7847/api/campaign/start` with the same config but no `preflightAck` → 409 with `preflight: true`.

- [ ] **Step 8: Commit**

```bash
git add public/index.html public/js/app.js public/css/style.css server.js
git commit -m "feat: pre-flight linter overlay + blocklist panel + exclude-and-launch stamping"
```

---

### Task 6: Version bump, suite, relaunch, branch wrap-up

**Files:**
- Modify: `package.json` (version → `2.135.0`)

- [ ] **Step 1:** Set `"version": "2.135.0"` in package.json.
- [ ] **Step 2:** Run the FULL suite: `node --test tests/*.test.js` — everything passes (note any pre-existing failures separately; do not fix unrelated ones).
- [ ] **Step 3:** Relaunch for the operator to verify (repo rule):

```bash
pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "Electron.*ortus" 2>/dev/null
npm run dev:app > /tmp/dev-app.log 2>&1 &
```

- [ ] **Step 4:** Commit + report:

```bash
git add package.json
git commit -m "chore: bump to v2.135.0 — pre-flight linter + blocklist"
```

Report to Antonio: what shipped, the manual-verification results from Task 5 Step 7 (with screenshots), and that NO release was cut (company stays on v2.120.2).
