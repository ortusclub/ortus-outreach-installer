# Team Connections — Lean MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A single-operator CLI that ingests the team's LinkedIn connection CSVs, searches HubSpot by geo/title/company, annotates each match with the colleague who can warmly reach them (slug join), drops DNC, and writes a ready-to-run ICB lead sheet.

**Architecture:** Five isolated, unit-tested modules under `src/connections/` (`slug` → `csv-ingest` → `hubspot-client` → `match` → `export`) orchestrated by a thin CLI `scripts/warm-reach.js`. No bundler, CommonJS, Node ≥22 (uses built-in `fetch`). HubSpot is read-only; output is a local CSV. Spec: `docs/superpowers/specs/2026-06-22-team-connections-mvp-spec.md`.

**Tech Stack:** Node ≥22, vanilla CommonJS, `node --test`, `dotenv` (already a dependency). No new npm packages.

**Conventions for the executor:**
- Work on a feature branch `team-connections-mvp` (Task 0). Never commit on the default branch; never `git add -A`/`.`; never stage `data/`.
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Do **not** touch `src/linkedin/*`. This feature adds only new files.
- Tests must not make live network calls — `hubspot-client` takes an injectable `fetchImpl`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/connections/slug.js` | Normalize any LinkedIn URL → bare vanity slug (or null). Shared by both sides. |
| `src/connections/csv-ingest.js` | Read a folder of `<email>.csv` → `Map<slug, [{colleague, connectedOn}]>` + stats. Includes a small CSV parser. |
| `src/connections/hubspot-client.js` | Build CRM-search filterGroups + paginated, retry-safe `searchContacts`. |
| `src/connections/match.js` | Join contacts↔index, dedupe, drop DNC. |
| `src/connections/export.js` | Write annotated rows → lead-schema CSV. |
| `src/connections/colleagues.json` | `{email: {name, linkedinUrl}}` for resolving `Primary`. |
| `scripts/warm-reach.js` | CLI orchestrator. |
| `tests/connections/*.test.js` | Unit tests per module. |
| `.gitignore`, `.env.example` | Add `data/connections/`, `out/`; document `HUBSPOT_TOKEN`. |

---

## Task 0: Branch + scaffold

**Files:** `.gitignore` (modify), `.env.example` (modify), `src/connections/colleagues.json` (create)

- [ ] **Step 1: Create the feature branch**

```bash
git checkout -b team-connections-mvp
```

- [ ] **Step 2: Gitignore the data + output dirs**

Append to `.gitignore` (verify these lines are present; add if missing):

```
# Team Connections (local-only, PII)
data/connections/
out/
```

- [ ] **Step 3: Document the token in `.env.example`**

Append to `.env.example`:

```
# HubSpot Private App / Service Key token (read contacts). Set the real value in .env only.
HUBSPOT_TOKEN=
```

- [ ] **Step 4: Seed the colleagues map**

Create `src/connections/colleagues.json` (seed with the colleagues whose CSVs we ingest; extend later). Use real ones from the spike:

```json
{
  "bea.talusan@ortus.solutions": { "name": "Bea Talusan", "linkedinUrl": "" },
  "meizi.a@ortus.solutions": { "name": "Meizi A.", "linkedinUrl": "" }
}
```

- [ ] **Step 5: Commit**

```bash
git add .gitignore .env.example src/connections/colleagues.json
git commit -m "chore(connections): scaffold MVP — gitignore, env doc, colleagues map

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 1: `slug.js` — URL → vanity slug

**Files:** Create `src/connections/slug.js`; Test `tests/connections/slug.test.js`

- [ ] **Step 1: Write the failing test**

```js
const test = require('node:test');
const assert = require('node:assert');
const { normalizeSlug } = require('../../src/connections/slug');

test('extracts a vanity slug, lowercased', () => {
  assert.strictEqual(
    normalizeSlug('https://www.linkedin.com/in/Elson-Chia'), 'elson-chia');
});
test('strips trailing slash and query', () => {
  assert.strictEqual(
    normalizeSlug('https://www.linkedin.com/in/jolie-small-70bb7a11/?utm=x'), 'jolie-small-70bb7a11');
});
test('handles http, no-www', () => {
  assert.strictEqual(normalizeSlug('http://linkedin.com/in/yashdeshpande'), 'yashdeshpande');
});
test('decodes percent-escapes', () => {
  assert.strictEqual(
    normalizeSlug('https://www.linkedin.com/in/rafaelmu%C3%B1oztorres'), 'rafaelmuñoztorres');
});
test('returns null for sales-navigator and blanks', () => {
  assert.strictEqual(normalizeSlug('https://www.linkedin.com/sales/people/ACwAA,NAME_SEARCH'), null);
  assert.strictEqual(normalizeSlug(''), null);
  assert.strictEqual(normalizeSlug(null), null);
});
```

- [ ] **Step 2: Run it — expect failure**

Run: `node --test tests/connections/slug.test.js`
Expected: FAIL (`Cannot find module … slug`).

- [ ] **Step 3: Implement**

```js
'use strict';

// Normalize a LinkedIn profile URL to its bare vanity slug, lowercased.
// Returns null when there is no /in/<slug> segment (e.g. /sales/people/…, blank, redacted).
function normalizeSlug(url) {
  if (!url || typeof url !== 'string') return null;
  const m = url.trim().match(/\/in\/([^/?#\s]+)/i);
  if (!m) return null;
  let slug = m[1];
  try { slug = decodeURIComponent(slug); } catch { /* keep raw */ }
  return slug.toLowerCase();
}

module.exports = { normalizeSlug };
```

- [ ] **Step 4: Run — expect pass**

Run: `node --test tests/connections/slug.test.js` → PASS (5/5).

- [ ] **Step 5: Commit**

```bash
git add src/connections/slug.js tests/connections/slug.test.js
git commit -m "feat(connections): slug normalization

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `csv-ingest.js` — networks → index

**Files:** Create `src/connections/csv-ingest.js`; Test `tests/connections/csv-ingest.test.js` + fixture `tests/connections/fixtures/sample.csv`

- [ ] **Step 1: Create the fixture** `tests/connections/fixtures/sample.csv`

```
Notes:
"When exporting your connection data, you may notice that some of the email addresses are missing."

First Name,Last Name,URL,Email Address,Company,Position,Connected On
Elson,Chia,https://www.linkedin.com/in/elson-chia,,Fujitsu,Director,16 Oct 2025
"Harry, CEP",Chan,https://www.linkedin.com/in/harry-c-574ab513,,Charter Link,Owner,03 Jan 2025
Redacted,Member,,,,,,01 Jan 2025
Sofia,Dall'Igna,https://www.linkedin.com/in/sofiadalligna,,CRIF Asia,Lead,23 Feb 2026
```

- [ ] **Step 2: Write the failing test**

```js
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { ingestFolder } = require('../../src/connections/csv-ingest');

test('ingests a folder into a slug index with stats', () => {
  const { index, stats } = ingestFolder(path.join(__dirname, 'fixtures'));
  assert.strictEqual(stats.files, 1);
  assert.strictEqual(stats.withUrl, 3);        // 3 rows have a URL
  assert.strictEqual(stats.skippedNoUrl, 1);   // the redacted row
  assert.strictEqual(index.size, 3);
  assert.deepStrictEqual(index.get('elson-chia'), [{ colleague: 'sample', connectedOn: '16 Oct 2025' }]);
  assert.ok(index.has('harry-c-574ab513'));    // quoted-comma name parsed correctly
});
```

- [ ] **Step 3: Run — expect failure**

Run: `node --test tests/connections/csv-ingest.test.js` → FAIL (module missing).

- [ ] **Step 4: Implement**

```js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { normalizeSlug } = require('./slug');

// Minimal RFC4180-ish parser: handles quoted fields, "" escapes, commas, CRLF.
function parseCsv(text) {
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function ingestFile(text, colleague, index, stats) {
  const rows = parseCsv(text);
  const h = rows.findIndex(r => r[0] && r[0].trim() === 'First Name' && r.map(x => x.trim()).includes('URL'));
  if (h === -1) { stats.filesNoHeader++; return; }
  const header = rows[h].map(x => x.trim());
  const urlIdx = header.indexOf('URL');
  const connIdx = header.indexOf('Connected On');
  for (let i = h + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || (r.length === 1 && r[0].trim() === '')) continue;
    stats.rows++;
    const slug = normalizeSlug(r[urlIdx]);
    if (!slug) { stats.skippedNoUrl++; continue; }
    stats.withUrl++;
    if (!index.has(slug)) index.set(slug, []);
    index.get(slug).push({ colleague, connectedOn: connIdx >= 0 ? (r[connIdx] || '').trim() : '' });
  }
}

function ingestFolder(dirPath) {
  const index = new Map();
  const stats = { files: 0, filesNoHeader: 0, rows: 0, withUrl: 0, skippedNoUrl: 0, perColleague: {} };
  for (const f of fs.readdirSync(dirPath).filter(f => f.toLowerCase().endsWith('.csv'))) {
    stats.files++;
    const colleague = f.replace(/\.csv$/i, '');
    const before = stats.withUrl;
    ingestFile(fs.readFileSync(path.join(dirPath, f), 'utf8'), colleague, index, stats);
    stats.perColleague[colleague] = stats.withUrl - before;
  }
  stats.uniqueSlugs = index.size;
  return { index, stats };
}

module.exports = { ingestFolder, parseCsv };
```

- [ ] **Step 5: Run — expect pass.** `node --test tests/connections/csv-ingest.test.js`

- [ ] **Step 6: Commit**

```bash
git add src/connections/csv-ingest.js tests/connections/csv-ingest.test.js tests/connections/fixtures/sample.csv
git commit -m "feat(connections): CSV ingestion → slug index

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `hubspot-client.js` — CRM search

**Files:** Create `src/connections/hubspot-client.js`; Test `tests/connections/hubspot-client.test.js`

- [ ] **Step 1: Confirm the DNC property name (one-time check, no code)**

Using the operator's HubSpot (or `search_properties`), confirm the internal name of the "Priority = DNC" field and the lead-status "Unsubscribed" value. Record findings in a code comment. Default assumptions until confirmed: lead status value `UNSUBSCRIBED`; DNC prop unknown → leave as a documented TODO in `match.js` (Task 4), not a blocker for the slug/search path.

- [ ] **Step 2: Write the failing test (builder + paginated fetch with injected impl)**

```js
const test = require('node:test');
const assert = require('node:assert');
const { buildFilterGroups, searchContacts } = require('../../src/connections/hubspot-client');

test('builds AND base with OR-of-titles across groups', () => {
  const fg = buildFilterGroups({ countries: ['Singapore'], jobTitles: ['Director', 'Head of'] });
  assert.strictEqual(fg.length, 2);
  assert.deepStrictEqual(fg[0].filters[0], { propertyName: 'country', operator: 'IN', values: ['Singapore'] });
  assert.strictEqual(fg[0].filters[1].propertyName, 'jobtitle');
  assert.strictEqual(fg[1].filters[1].value, 'Head of');
});

test('single group when no titles', () => {
  const fg = buildFilterGroups({ companies: ['StarHub'] });
  assert.strictEqual(fg.length, 1);
  assert.strictEqual(fg[0].filters[0].propertyName, 'company');
});

test('paginates with injected fetch and flattens properties', async () => {
  const pages = [
    { results: [{ id: '1', properties: { firstname: 'A', linkedinbio: 'x' } }], paging: { next: { after: '100' } } },
    { results: [{ id: '2', properties: { firstname: 'B' } }] },
  ];
  let call = 0;
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => pages[call++] });
  const out = await searchContacts({ countries: ['SG'] }, { fetchImpl, token: 't' });
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].firstname, 'A');
  assert.strictEqual(out[1].id, '2');
});
```

- [ ] **Step 3: Run — expect failure.** `node --test tests/connections/hubspot-client.test.js`

- [ ] **Step 4: Implement**

```js
'use strict';
const BASE = process.env.HUBSPOT_BASE_URL || 'https://api.hubapi.com';
const PROPS = ['firstname', 'lastname', 'linkedinbio', 'linkedin_membership_id',
  'country', 'state', 'city', 'jobtitle', 'company', 'hs_lead_status', 'lastmodifieddate'];

function buildFilterGroups({ countries = [], regions = [], cities = [], jobTitles = [], companies = [] }) {
  const base = [];
  if (countries.length) base.push({ propertyName: 'country', operator: 'IN', values: countries });
  if (regions.length) base.push({ propertyName: 'state', operator: 'IN', values: regions });
  if (cities.length) base.push({ propertyName: 'city', operator: 'IN', values: cities });
  if (companies.length) base.push({ propertyName: 'company', operator: 'IN', values: companies });
  if (!jobTitles.length) return [{ filters: base }];
  // HubSpot ORs filterGroups, ANDs within. Distribute each title into its own group.
  // Cap at 5 groups (HubSpot max). Titles beyond 5 are dropped — log it in the CLI.
  return jobTitles.slice(0, 5).map(t => ({
    filters: [...base, { propertyName: 'jobtitle', operator: 'CONTAINS_TOKEN', value: t }],
  }));
}

async function postWithRetry(fetchImpl, url, token, body, attempt = 0) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if ((res.status === 429 || res.status >= 500) && attempt < 5) {
    await new Promise(r => setTimeout(r, 1000 * 2 ** attempt));
    return postWithRetry(fetchImpl, url, token, body, attempt + 1);
  }
  if (!res.ok) throw new Error(`HubSpot ${res.status}: ${await res.text()}`);
  return res;
}

async function searchContacts(params, { fetchImpl = fetch, token = process.env.HUBSPOT_TOKEN, maxPages = 50 } = {}) {
  if (!token) throw new Error('HUBSPOT_TOKEN not set — add it to .env');
  const filterGroups = buildFilterGroups(params);
  const out = []; let after;
  for (let page = 0; page < maxPages; page++) {
    const body = { filterGroups, properties: PROPS, limit: params.limit || 100, ...(after ? { after } : {}) };
    const res = await postWithRetry(fetchImpl, `${BASE}/crm/v3/objects/contacts/search`, token, body);
    const json = await res.json();
    for (const r of json.results || []) out.push({ id: r.id, ...r.properties });
    after = json.paging && json.paging.next && json.paging.next.after;
    if (!after) break;
  }
  return out;
}

module.exports = { buildFilterGroups, searchContacts, PROPS };
```

- [ ] **Step 5: Run — expect pass.** `node --test tests/connections/hubspot-client.test.js`

- [ ] **Step 6: Commit**

```bash
git add src/connections/hubspot-client.js tests/connections/hubspot-client.test.js
git commit -m "feat(connections): HubSpot CRM search client (filterGroups + paginate + retry)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `match.js` — join + dedupe + DNC

**Files:** Create `src/connections/match.js`; Test `tests/connections/match.test.js`

- [ ] **Step 1: Write the failing test**

```js
const test = require('node:test');
const assert = require('node:assert');
const { annotate } = require('../../src/connections/match');

const index = new Map([
  ['elson-chia', [{ colleague: 'bea.talusan@ortus.solutions', connectedOn: '16 Oct 2025' }]],
]);

test('annotates warm matches, drops DNC, dedupes by slug', () => {
  const contacts = [
    { id: '1', firstname: 'Elson', linkedinbio: 'https://www.linkedin.com/in/elson-chia', lastmodifieddate: '2025-01-01' },
    { id: '2', firstname: 'Elson', linkedinbio: 'https://www.linkedin.com/in/elson-chia', lastmodifieddate: '2026-01-01' }, // dupe, newer
    { id: '3', firstname: 'Cold', linkedinbio: 'https://www.linkedin.com/in/nobody-x' },
    { id: '4', firstname: 'Gone', linkedinbio: 'https://www.linkedin.com/in/elson-chia', hs_lead_status: 'UNSUBSCRIBED' },
  ];
  const rows = annotate(contacts, index);
  const elson = rows.find(r => r.slug === 'elson-chia');
  assert.ok(elson.hasWarm);
  assert.deepStrictEqual(elson.warmVia, ['bea.talusan@ortus.solutions']);
  assert.strictEqual(elson.contact.id, '2');            // kept the newer record
  assert.ok(rows.find(r => r.slug === 'nobody-x' && !r.hasWarm)); // cold result still returned
  assert.strictEqual(rows.length, 2);                   // DNC row dropped, dupe merged
});
```

- [ ] **Step 2: Run — expect failure.** `node --test tests/connections/match.test.js`

- [ ] **Step 3: Implement**

```js
'use strict';
const { normalizeSlug } = require('./slug');

// Lead-status values that mean do-not-contact. Confirm against HubSpot during Task 3 Step 1.
const DNC_LEAD_STATUSES = new Set(['UNSUBSCRIBED', 'DNC']);

function isDnc(c) {
  if (DNC_LEAD_STATUSES.has((c.hs_lead_status || '').toUpperCase())) return true;
  // TODO(confirm prop name): the "Priority = DNC" custom field, once known, check here.
  return false;
}

function annotate(contacts, index) {
  const byKey = new Map();
  for (const c of contacts) {
    if (isDnc(c)) continue;
    const slug = normalizeSlug(c.linkedinbio);
    const key = slug || (c.linkedin_membership_id ? `mid:${c.linkedin_membership_id}` : `id:${c.id}`);
    const warm = slug && index.has(slug) ? index.get(slug).map(x => x.colleague) : [];
    if (!byKey.has(key)) byKey.set(key, { contact: c, slug, warmVia: new Set(warm) });
    else {
      const e = byKey.get(key);
      warm.forEach(w => e.warmVia.add(w));
      if ((c.lastmodifieddate || '') > (e.contact.lastmodifieddate || '')) e.contact = c;
    }
  }
  return [...byKey.values()].map(v => ({
    contact: v.contact, slug: v.slug, warmVia: [...v.warmVia], hasWarm: v.warmVia.size > 0,
  }));
}

module.exports = { annotate, isDnc };
```

- [ ] **Step 4: Run — expect pass.** `node --test tests/connections/match.test.js`

- [ ] **Step 5: Commit**

```bash
git add src/connections/match.js tests/connections/match.test.js
git commit -m "feat(connections): join + dedupe + DNC filter

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `export.js` — lead-schema CSV

**Files:** Create `src/connections/export.js`; Test `tests/connections/export.test.js`

- [ ] **Step 1: Write the failing test**

```js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeLeadCsv, HEADER } = require('../../src/connections/export');

test('writes lead schema with resolved Primary and CSV-escaping', () => {
  const out = path.join(os.tmpdir(), `wr-${process.pid}.csv`);
  const rows = [{
    contact: { firstname: 'Elson', lastname: 'Chia', linkedinbio: 'https://www.linkedin.com/in/elson-chia',
      company: 'Fujitsu, Asia', jobtitle: 'Director', country: 'Singapore' },
    warmVia: ['bea.talusan@ortus.solutions'], hasWarm: true,
  }];
  writeLeadCsv(rows, out, { 'bea.talusan@ortus.solutions': { name: 'Bea Talusan', linkedinUrl: 'https://linkedin.com/in/beatalusan' } });
  const lines = fs.readFileSync(out, 'utf8').trim().split('\n');
  assert.strictEqual(lines[0], HEADER.join(','));
  assert.ok(lines[1].includes('"Fujitsu, Asia"'));            // comma field quoted
  assert.ok(lines[1].includes('Bea Talusan'));                // Primary resolved
  assert.ok(lines[1].includes('https://linkedin.com/in/beatalusan')); // Primary URL
  fs.unlinkSync(out);
});
```

- [ ] **Step 2: Run — expect failure.** `node --test tests/connections/export.test.js`

- [ ] **Step 3: Implement**

```js
'use strict';
const fs = require('node:fs');

const HEADER = ['First Name', 'Last Name', 'LinkedIn URL', 'Company', 'Job Title', 'Country', 'Primary', 'Primary URL', 'Stage'];

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeLeadCsv(rows, outPath, colleagues = {}) {
  const lines = [HEADER.join(',')];
  for (const { contact: c, warmVia } of rows) {
    const connector = warmVia[0];
    const meta = connector ? colleagues[connector] || {} : {};
    lines.push([c.firstname, c.lastname, c.linkedinbio, c.company, c.jobtitle, c.country,
      meta.name || connector || '', meta.linkedinUrl || '', ''].map(csvCell).join(','));
  }
  fs.writeFileSync(outPath, lines.join('\n') + '\n', 'utf8');
  return outPath;
}

module.exports = { writeLeadCsv, HEADER };
```

- [ ] **Step 4: Run — expect pass.** `node --test tests/connections/export.test.js`

- [ ] **Step 5: Commit**

```bash
git add src/connections/export.js tests/connections/export.test.js
git commit -m "feat(connections): lead-schema CSV export

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: `scripts/warm-reach.js` — CLI wiring

**Files:** Create `scripts/warm-reach.js`

- [ ] **Step 1: Implement the orchestrator**

```js
#!/usr/bin/env node
'use strict';
require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { ingestFolder } = require('../src/connections/csv-ingest');
const { searchContacts } = require('../src/connections/hubspot-client');
const { annotate } = require('../src/connections/match');
const { writeLeadCsv } = require('../src/connections/export');
let colleagues = {};
try { colleagues = require('../src/connections/colleagues.json'); } catch { /* optional */ }

function parseArgs() {
  const a = process.argv.slice(2);
  const o = { country: [], region: [], city: [], title: [], company: [] };
  for (let i = 0; i < a.length; i++) {
    const k = a[i].replace(/^--/, '');
    if (k === 'csv-dir' || k === 'out' || k === 'warm-only') o[k] = (k === 'warm-only') ? true : a[++i];
    else if (o[k]) o[k].push(a[++i]);
  }
  return o;
}

(async () => {
  const o = parseArgs();
  const dir = o['csv-dir'] || './data/connections';
  const out = o.out || `./out/warm-reach-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;

  const { index, stats } = ingestFolder(dir);
  console.log('Ingested networks:', JSON.stringify(stats, null, 2));
  if (o.title.length > 5) console.log(`! ${o.title.length} titles given; HubSpot caps at 5 — using the first 5.`);

  const contacts = await searchContacts({
    countries: o.country, regions: o.region, cities: o.city, jobTitles: o.title, companies: o.company,
  });
  console.log(`HubSpot returned ${contacts.length} contacts`);

  const annotated = annotate(contacts, index);
  const warm = annotated.filter(r => r.hasWarm);
  console.log(`\n${warm.length} warm / ${annotated.length} total (after DNC + dedupe)\n`);
  for (const r of warm.slice(0, 25)) {
    console.log(`  • ${r.contact.firstname || ''} ${r.contact.lastname || ''} — ${r.contact.company || '?'}  →  via ${r.warmVia.join(', ')}`);
  }

  const rowsToWrite = o['warm-only'] === false ? annotated : warm;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  writeLeadCsv(rowsToWrite, out, colleagues);
  console.log(`\nWrote ${rowsToWrite.length} rows → ${out}`);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
```

- [ ] **Step 2: Verify ingestion path works without HubSpot (offline smoke test)**

Create a throwaway dir with the fixture and run ingest-only by pointing at it with no token? The script calls HubSpot, which needs a token. For an offline check, temporarily run just the ingest by invoking node REPL or rely on the unit tests (already green). Acceptable: the unit tests cover ingest/match/export; the live run is Task 7.

- [ ] **Step 3: Commit**

```bash
git add scripts/warm-reach.js
git commit -m "feat(connections): warm-reach CLI orchestrator

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: End-to-end acceptance run (manual — the real gate)

**Prereqs (operator):** `HUBSPOT_TOKEN` in `.env`; the team's `<email>.csv` files dropped into `./data/connections/`.

- [ ] **Step 1: Full test suite green**

Run: `node --test tests/connections/` → all pass.

- [ ] **Step 2: Real run on a known-good network (Bea's APAC set)**

Run:
```bash
node scripts/warm-reach.js --country Singapore --title "Director" --title "Head of" --title "VP"
```
Expected: ingestion stats print; HubSpot returns contacts; a list of warm matches prints (expect real names like StarHub / Microsoft / NTT given Bea's network); a CSV is written under `out/`.

- [ ] **Step 3: Eyeball the CSV**

Open the `out/…csv`: confirm columns match the lead schema, `Primary` is populated for warm rows, DNC rows are absent, no duplicate slugs.

- [ ] **Step 4: Record the result**

Note the warm-match count and whether the matches look genuine. This number is the "does it work for me" verdict. If coverage is thin on your target geography, that's the signal to prioritize ingesting more networks and/or the Phase-1.5 member-ID upgrade.

- [ ] **Step 5: Finish the branch**

Use `superpowers:finishing-a-development-branch` to verify tests and choose merge/PR. (PR base = `main`; confirm base branch per repo housekeeping.)

---

## Self-review notes
- **Spec coverage:** every §2 acceptance criterion maps to a task (ingest+stats→T2/T7; search+DNC+dedupe→T3/T4; cold rows visible→T4 test + CLI; CSV export→T5; real run→T7). ✓
- **No live calls in tests:** `hubspot-client` uses injected `fetchImpl`. ✓
- **Type consistency:** `annotate` returns `{contact, slug, warmVia[], hasWarm}`; `writeLeadCsv` consumes `{contact, warmVia}`. ✓
- **Known follow-ups (out of MVP):** confirm exact DNC/Priority property name (Task 3 Step 1); member-ID/Voyager resolution (Phase-1.5); write directly into the central workbook tab; wire the v2 sketch UI to `/api/connections/*`.
