# Sales Nav Scraper — Tab + Queue Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the Sales Nav scraper into its own top-level tab whose default view is a queue "board" of scraper campaigns as strips (Jobs/Logs tabs, owner-gated On/Off toggle, stop→launch handover visual), driven by the existing GKE engine's live job state.

**Architecture:** The GKE scrape engine already owns job scheduling and exposes state/position/ETA/pause/resume/stop/logs (`src/scraper-client.js`). This feature adds a thin **persistence layer** (a "scrape campaign" record that names + owns a group of jobs, plus per-campaign log persistence) and a **presentation layer** (the tab + board UI). No new queue or concurrency logic is introduced.

**Tech Stack:** Node ≥22, Express 4, vanilla JS (no bundler), ES modules (`src/*.js`) + browser modules (`public/js/*.mjs`), `node --test`.

## Global Constraints

- **Do NOT change scrape execution or concurrency logic.** Reuse the engine's existing endpoints only. (spec §4)
- **Do NOT modify** `src/linkedin/outreach.js` or `src/linkedin/actions.js`.
- **The one-campaign-at-a-time rule does NOT apply to scrapes** — the board reflects engine state, which may show more than one running. (spec §4, §6)
- **1:1 with the real skin:** `body[data-dashboard='v3']` light theme, tokens `--ink --gray --green --gold --hairline --hairline-soft --bg-soft --display --mono`, from `/css/style.css` + `/css/dashboard-v0.3.css`. (spec §4)
- **Namespace all new board CSS** with a `sn-`/`snm-` prefix — generic class names collide with the 278 KB `style.css` (proven in the sketch). (spec §7)
- **No invented data** — strips show only real fields. (spec §4)
- **Owner = the email that launched the scrape**, resolved server-side; admin override email is `antonio@ortusclub.com`. (spec §7, §11)
- **Toggle semantics:** Off = engine `pauseScrape`; On = engine `resumeScrape`, per the campaign's profile IDs. (spec §7)
- **Bump `package.json` patch version before every relaunch**; after any commit touching runtime code, relaunch dev:app. Commit messages end with the `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` line. Never `git add data/*.json`.
- **Reference sketch (visual source of truth):** `public/sketches/2026-07-01-salesnav-board-v1-jobs-tabs.html`.

## Verified interfaces (from the current code — do not re-derive)

- `src/scraper-client.js`:
  - `startScrape({ searchUrls, sheetUrl, profileId, tabName, slowMode }) → Promise<jobResult|{error}>`
  - `pauseScrape(profileId) / resumeScrape(profileId) / stopScrape(profileId) → Promise<result>`
  - `getJobs() → Promise<Array<job>>` where `job = { id, state:'queued'|'running'|'done'|'error'|'cancelled', pages, profiles, position, accountsAhead, etaMs, tabName, searchUrl, error? }`. Scoped to this install's operator-id.
  - `getLogs(since?) → Promise<Array<{ts, message}>>` (may also come back `{logs, now}`).
- `src/operator-id.js` → `getOperatorId()` (per-install UUID).
- `src/operator-identity.js` → `getOperatorEmail()` (per-machine email).
- Server: `req.user` = authenticated email (session gate, server.js ~220-232). `GET /api/operator-identity → {ok,email,set}`.
- Existing scrape routes in server.js ~2070-2130: `/api/scrape/start|pause|resume|stop|jobs|logs|view/:jobId`.
- Persistence pattern (`src/campaign-queue.js`): module-level `cache`, `load()`, atomic `persist()` (write `.tmp`, `fs.rename`), keyed file via `dataPath(...)` from `src/paths.js`.
- Test style: `import test from 'node:test'; import assert from 'node:assert/strict';`. Run `node --test tests/<file>.test.js`.

---

## File Structure

- **Create** `src/scrape-campaigns.js` — persisted registry of scrape-campaign records (id, name, owner, sheetUrl, tabName, profileIds, searchUrls, createdAt). Load/add/get/list/update, atomic writes. File: `dataPath('scrape-campaigns.json')`.
- **Create** `src/scrape-campaign-logs.js` — per-campaign log persistence (append one NDJSON line per event; read tail) + an `appendAction()` helper for toggle/stop lines. Dir: `dataPath('scrape-logs/')`, one `<campaignId>.ndjson` per campaign.
- **Create** `public/js/scrape-board.mjs` — PURE browser helper: `groupJobsIntoCampaigns()`, `campaignStatus()`, `toggleDecision()`, `fmtEta()`. No DOM, no fetch — unit-tested.
- **Create tests** `tests/scrape-campaigns.test.js`, `tests/scrape-campaign-logs.test.js`, `tests/scrape-board.test.js`.
- **Modify** `server.js` — wrap scrape launch to persist a campaign + owner; add `GET /api/scrape/campaigns`, `POST /api/scrape/campaigns/:id/toggle`, `GET /api/scrape/campaigns/:id/logs`.
- **Modify** `public/index.html` — add the "Sales Nav" nav item + a board container section; namespaced board + modal CSS.
- **Modify** `public/js/app.js` — board render/poll, Jobs/Logs tabs, owner toggle + confirm + admin bypass, handover visual, Open→setup routing; remove `sales_nav_scrape` from the New Campaign `MODE_LIST`.

---

## Task 1: Scrape-campaign registry (`src/scrape-campaigns.js`)

**Files:**
- Create: `src/scrape-campaigns.js`
- Test: `tests/scrape-campaigns.test.js`

**Interfaces:**
- Consumes: `dataPath` from `src/paths.js`.
- Produces:
  - `addScrapeCampaign({ name, owner, sheetUrl, tabName, profileIds, searchUrls }) → Promise<record>`
  - `listScrapeCampaigns() → Promise<record[]>`
  - `getScrapeCampaign(id) → Promise<record|null>`
  - `updateScrapeCampaign(id, patch) → Promise<record|null>` (allowed keys: `name`, `profileIds`, `enabled`)
  - record shape: `{ id, name, owner, sheetUrl, tabName, profileIds:string[], searchUrls:string[], enabled:boolean, createdAt:number }`
  - Test seam: `__setFileForTests(path)` to point the store at a temp file.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/scrape-campaigns.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  __setFileForTests, addScrapeCampaign, listScrapeCampaigns,
  getScrapeCampaign, updateScrapeCampaign,
} from '../src/scrape-campaigns.js';

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'scpc-')), 'scrape-campaigns.json');
}

test('add persists a record with an id, defaults enabled=true, and createdAt', async () => {
  __setFileForTests(tmpFile());
  const rec = await addScrapeCampaign({
    name: 'APAC_EXPANSION', owner: 'alecx@ortus.solutions',
    sheetUrl: 'https://docs.google.com/x', tabName: 'Results',
    profileIds: ['p1', 'p2'], searchUrls: ['u1', 'u2'],
  });
  assert.ok(rec.id && rec.id.startsWith('sc_'));
  assert.equal(rec.enabled, true);
  assert.equal(typeof rec.createdAt, 'number');
  assert.deepEqual(rec.profileIds, ['p1', 'p2']);
  const all = await listScrapeCampaigns();
  assert.equal(all.length, 1);
  assert.equal(all[0].owner, 'alecx@ortus.solutions');
});

test('get returns the record by id, or null when missing', async () => {
  __setFileForTests(tmpFile());
  const rec = await addScrapeCampaign({ name: 'X', owner: 'a@b', sheetUrl: 's', tabName: 'T', profileIds: [], searchUrls: [] });
  assert.equal((await getScrapeCampaign(rec.id)).name, 'X');
  assert.equal(await getScrapeCampaign('nope'), null);
});

test('update merges only allowed keys and ignores others', async () => {
  __setFileForTests(tmpFile());
  const rec = await addScrapeCampaign({ name: 'X', owner: 'a@b', sheetUrl: 's', tabName: 'T', profileIds: [], searchUrls: [] });
  const upd = await updateScrapeCampaign(rec.id, { enabled: false, owner: 'HACKER' });
  assert.equal(upd.enabled, false);
  assert.equal(upd.owner, 'a@b'); // owner is NOT an allowed patch key
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/scrape-campaigns.test.js`
Expected: FAIL — `Cannot find module '../src/scrape-campaigns.js'`.

- [ ] **Step 3: Write the minimal implementation**

```javascript
// src/scrape-campaigns.js
// Persisted registry of Sales Nav scrape "campaigns" — a named, owned group of
// engine jobs (one per search URL). The GKE engine owns job scheduling; this
// store only remembers name/owner/destination/profile IDs so the board can
// group the engine's jobs into strips and gate toggles by owner.
import fs from 'fs/promises';
import { dataPath } from './paths.js';

let FILE = dataPath('scrape-campaigns.json');
let cache = null;

export function __setFileForTests(p) { FILE = p; cache = null; }

async function load() {
  if (cache !== null) return cache;
  try {
    const parsed = JSON.parse(await fs.readFile(FILE, 'utf8'));
    cache = Array.isArray(parsed) ? parsed : [];
  } catch { cache = []; }
  return cache;
}

async function persist() {
  if (cache === null) await load();
  const tmp = FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(cache, null, 2));
  await fs.rename(tmp, FILE);
}

export async function addScrapeCampaign({ name, owner, sheetUrl, tabName, profileIds, searchUrls }) {
  await load();
  const rec = {
    id: 'sc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    name: name || '',
    owner: owner || null,
    sheetUrl: sheetUrl || '',
    tabName: tabName || 'Results',
    profileIds: Array.isArray(profileIds) ? profileIds.filter(Boolean) : [],
    searchUrls: Array.isArray(searchUrls) ? searchUrls.filter(Boolean) : [],
    enabled: true,
    createdAt: Date.now(),
  };
  cache.push(rec);
  await persist();
  return rec;
}

export async function listScrapeCampaigns() { return [...(await load())]; }

export async function getScrapeCampaign(id) {
  return (await load()).find((r) => r.id === id) || null;
}

const ALLOWED_PATCH_KEYS = new Set(['name', 'profileIds', 'enabled']);
export async function updateScrapeCampaign(id, patch) {
  await load();
  const rec = cache.find((r) => r.id === id);
  if (!rec) return null;
  for (const k of Object.keys(patch || {})) {
    if (ALLOWED_PATCH_KEYS.has(k)) rec[k] = patch[k];
  }
  await persist();
  return rec;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/scrape-campaigns.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/scrape-campaigns.js tests/scrape-campaigns.test.js
git commit -m "feat(scrape): persisted scrape-campaign registry (name/owner/jobs)"
```

---

## Task 2: Per-campaign log persistence (`src/scrape-campaign-logs.js`)

**Files:**
- Create: `src/scrape-campaign-logs.js`
- Test: `tests/scrape-campaign-logs.test.js`

**Interfaces:**
- Consumes: `dataPath` from `src/paths.js`.
- Produces:
  - `appendScrapeLog(campaignId, { ts, message }) → Promise<void>` (one NDJSON line)
  - `appendAction(campaignId, { actor, admin, action }) → Promise<void>` — writes a human line, e.g. `toggled OFF by alecx@ortus.solutions` (or `… (admin)`).
  - `readScrapeLog(campaignId, { limit = 300 }) → Promise<Array<{ts, message}>>`
  - Test seam: `__setDirForTests(dir)`.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/scrape-campaign-logs.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  __setDirForTests, appendScrapeLog, appendAction, readScrapeLog,
} from '../src/scrape-campaign-logs.js';

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sclog-')); }

test('append then read returns lines in order with ts + message', async () => {
  __setDirForTests(tmpDir());
  await appendScrapeLog('sc_1', { ts: 1000, message: 'dispatched 2 jobs' });
  await appendScrapeLog('sc_1', { ts: 2000, message: 'job 1 done — 240 rows' });
  const lines = await readScrapeLog('sc_1', { limit: 10 });
  assert.equal(lines.length, 2);
  assert.equal(lines[0].message, 'dispatched 2 jobs');
  assert.equal(lines[1].ts, 2000);
});

test('appendAction writes a who-did-it line, tagging admin', async () => {
  __setDirForTests(tmpDir());
  await appendAction('sc_2', { actor: 'alecx@ortus.solutions', admin: false, action: 'toggled OFF' });
  await appendAction('sc_2', { actor: 'antonio@ortusclub.com', admin: true, action: 'toggled ON' });
  const lines = await readScrapeLog('sc_2', { limit: 10 });
  assert.match(lines[0].message, /toggled OFF by alecx@ortus\.solutions/);
  assert.match(lines[1].message, /toggled ON by antonio@ortusclub\.com \(admin\)/);
});

test('read of an unknown campaign returns []', async () => {
  __setDirForTests(tmpDir());
  assert.deepEqual(await readScrapeLog('missing', { limit: 5 }), []);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/scrape-campaign-logs.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the minimal implementation**

```javascript
// src/scrape-campaign-logs.js
// Durable per-campaign scrape logs. Engine logs are live-only + operator-scoped;
// we persist a campaign's own stream (dispatch/progress/done + toggle actions)
// so the board's Logs tab has content for queued/done campaigns too.
import fs from 'fs/promises';
import path from 'path';
import { dataPath } from './paths.js';

let DIR = dataPath('scrape-logs');

export function __setDirForTests(d) { DIR = d; }

function fileFor(campaignId) {
  // campaignId is our own 'sc_...' id — safe, but strip separators defensively.
  const safe = String(campaignId).replace(/[^a-zA-Z0-9_-]/g, '');
  return path.join(DIR, safe + '.ndjson');
}

export async function appendScrapeLog(campaignId, { ts, message }) {
  await fs.mkdir(DIR, { recursive: true });
  const line = JSON.stringify({ ts: ts || Date.now(), message: String(message || '') }) + '\n';
  await fs.appendFile(fileFor(campaignId), line);
}

export async function appendAction(campaignId, { actor, admin, action }) {
  const who = admin ? `${actor} (admin)` : actor;
  await appendScrapeLog(campaignId, { ts: Date.now(), message: `${action} by ${who}` });
}

export async function readScrapeLog(campaignId, { limit = 300 } = {}) {
  let text;
  try { text = await fs.readFile(fileFor(campaignId), 'utf8'); }
  catch { return []; }
  const lines = text.split('\n').filter(Boolean);
  const tail = lines.slice(-limit);
  const out = [];
  for (const l of tail) { try { out.push(JSON.parse(l)); } catch { /* skip */ } }
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/scrape-campaign-logs.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/scrape-campaign-logs.js tests/scrape-campaign-logs.test.js
git commit -m "feat(scrape): durable per-campaign log stream + action logging"
```

---

## Task 3: Pure board helper (`public/js/scrape-board.mjs`)

**Files:**
- Create: `public/js/scrape-board.mjs`
- Test: `tests/scrape-board.test.js`

**Interfaces:**
- Produces (all pure, no DOM/fetch):
  - `ADMIN_EMAIL = 'antonio@ortusclub.com'`
  - `groupJobsIntoCampaigns(campaigns, jobs) → Array<{campaign, jobs, status, running, queued, done, totalProfiles, minPosition, etaMs}>` — matches engine `jobs` to persisted `campaigns` by `searchUrl` (a job belongs to the campaign whose `searchUrls` contains `job.searchUrl`).
  - `campaignStatus(jobs) → 'running'|'queued'|'done'|'error'|'idle'` — running if any job running; else queued if any queued; else error if any error and none done; else done if any done; else idle.
  - `toggleDecision({ currentEmail, ownerEmail }) → { needsConfirm:boolean, isAdmin:boolean }` — admin never needs confirm; owner never needs confirm; otherwise needsConfirm true.
  - `fmtEta(ms) → string` — `'—'` for falsy/negative, else `'~2m'` / `'~1h 5m'`.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/scrape-board.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ADMIN_EMAIL, groupJobsIntoCampaigns, campaignStatus, toggleDecision, fmtEta,
} from '../public/js/scrape-board.mjs';

test('groups engine jobs under the campaign whose searchUrls contain them', () => {
  const campaigns = [
    { id: 'sc_1', name: 'A', owner: 'a@b', searchUrls: ['u1', 'u2'], profileIds: ['p1', 'p2'] },
    { id: 'sc_2', name: 'B', owner: 'c@d', searchUrls: ['u3'], profileIds: ['p3'] },
  ];
  const jobs = [
    { id: 'j1', searchUrl: 'u1', state: 'running', profiles: 118, position: 0 },
    { id: 'j2', searchUrl: 'u2', state: 'done', profiles: 240, position: 0 },
    { id: 'j3', searchUrl: 'u3', state: 'queued', profiles: 0, position: 2, etaMs: 120000 },
  ];
  const groups = groupJobsIntoCampaigns(campaigns, jobs);
  const a = groups.find((g) => g.campaign.id === 'sc_1');
  const b = groups.find((g) => g.campaign.id === 'sc_2');
  assert.equal(a.jobs.length, 2);
  assert.equal(a.status, 'running');
  assert.equal(b.status, 'queued');
  assert.equal(b.minPosition, 2);
});

test('campaignStatus precedence: running > queued > error > done > idle', () => {
  assert.equal(campaignStatus([{ state: 'done' }, { state: 'running' }]), 'running');
  assert.equal(campaignStatus([{ state: 'queued' }, { state: 'done' }]), 'queued');
  assert.equal(campaignStatus([{ state: 'error' }, { state: 'cancelled' }]), 'error');
  assert.equal(campaignStatus([{ state: 'done' }, { state: 'done' }]), 'done');
  assert.equal(campaignStatus([]), 'idle');
});

test('toggleDecision: owner and admin skip confirm; stranger needs it', () => {
  assert.deepEqual(toggleDecision({ currentEmail: 'a@b', ownerEmail: 'a@b' }), { needsConfirm: false, isAdmin: false });
  assert.deepEqual(toggleDecision({ currentEmail: ADMIN_EMAIL, ownerEmail: 'a@b' }), { needsConfirm: false, isAdmin: true });
  assert.deepEqual(toggleDecision({ currentEmail: 'x@y', ownerEmail: 'a@b' }), { needsConfirm: true, isAdmin: false });
});

test('fmtEta formats minutes/hours and guards empties', () => {
  assert.equal(fmtEta(0), '—');
  assert.equal(fmtEta(-5), '—');
  assert.equal(fmtEta(120000), '~2m');
  assert.equal(fmtEta(3900000), '~1h 5m');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/scrape-board.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the minimal implementation**

```javascript
// public/js/scrape-board.mjs
// Pure helpers for the Sales Nav board — no DOM, no fetch, fully unit-tested.
export const ADMIN_EMAIL = 'antonio@ortusclub.com';

export function campaignStatus(jobs) {
  if (!jobs || !jobs.length) return 'idle';
  if (jobs.some((j) => j.state === 'running')) return 'running';
  if (jobs.some((j) => j.state === 'queued')) return 'queued';
  if (jobs.some((j) => j.state === 'error' || j.state === 'cancelled') && !jobs.some((j) => j.state === 'done')) return 'error';
  if (jobs.some((j) => j.state === 'done')) return 'done';
  return 'idle';
}

export function groupJobsIntoCampaigns(campaigns, jobs) {
  const byUrl = new Map();
  for (const c of campaigns || []) for (const u of (c.searchUrls || [])) byUrl.set(u, c.id);
  const jobsByCampaign = new Map();
  for (const j of jobs || []) {
    const cid = byUrl.get(j.searchUrl);
    if (!cid) continue;
    if (!jobsByCampaign.has(cid)) jobsByCampaign.set(cid, []);
    jobsByCampaign.get(cid).push(j);
  }
  return (campaigns || []).map((campaign) => {
    const cjobs = jobsByCampaign.get(campaign.id) || [];
    const status = campaignStatus(cjobs);
    const positions = cjobs.filter((j) => j.state === 'queued' && j.position).map((j) => j.position);
    const etas = cjobs.filter((j) => j.etaMs).map((j) => j.etaMs);
    return {
      campaign,
      jobs: cjobs,
      status,
      running: cjobs.filter((j) => j.state === 'running').length,
      queued: cjobs.filter((j) => j.state === 'queued').length,
      done: cjobs.filter((j) => j.state === 'done').length,
      totalProfiles: cjobs.reduce((n, j) => n + (j.profiles || 0), 0),
      minPosition: positions.length ? Math.min(...positions) : null,
      etaMs: etas.length ? Math.min(...etas) : null,
    };
  });
}

export function toggleDecision({ currentEmail, ownerEmail }) {
  const cur = String(currentEmail || '').trim().toLowerCase();
  const own = String(ownerEmail || '').trim().toLowerCase();
  if (cur === ADMIN_EMAIL) return { needsConfirm: false, isAdmin: true };
  if (cur && cur === own) return { needsConfirm: false, isAdmin: false };
  return { needsConfirm: true, isAdmin: false };
}

export function fmtEta(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '—';
  const totalMin = Math.round(n / 60000);
  if (totalMin < 60) return `~${totalMin}m`;
  const h = Math.floor(totalMin / 60), m = totalMin % 60;
  return m ? `~${h}h ${m}m` : `~${h}h`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/scrape-board.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add public/js/scrape-board.mjs tests/scrape-board.test.js
git commit -m "feat(scrape): pure board helpers (grouping, status, toggle-gate, eta)"
```

---

## Task 4: Persist a campaign at launch + `GET /api/scrape/campaigns`

**Files:**
- Modify: `server.js` (scrape launch handler ~2070-2074; add new routes near the other `/api/scrape/*` routes ~2106-2112)
- Test: `tests/scrape-campaigns-merge.test.js`

**Interfaces:**
- Consumes: `addScrapeCampaign`, `listScrapeCampaigns` (Task 1); `getJobs` (scraper-client); `groupJobsIntoCampaigns` — but server is CJS-style ESM already importing `.js`; for the merge it re-implements nothing: it imports a new pure fn `mergeCampaignsWithJobs(campaigns, jobs)` added to **`src/scrape-campaigns.js`** (server can't import a `public/js/*.mjs` browser module cleanly, so the merge used by the route lives server-side).
- Produces:
  - On launch: after a successful `startScrape`, persist a campaign record with `owner = req.user`.
  - `GET /api/scrape/campaigns → { campaigns: [ { ...record, jobs, status, running, queued, done, totalProfiles, minPosition, etaMs } ] }`.

- [ ] **Step 1: Add a server-side merge helper to `src/scrape-campaigns.js` with a failing test**

```javascript
// tests/scrape-campaigns-merge.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeCampaignsWithJobs } from '../src/scrape-campaigns.js';

test('merge attaches engine jobs + computed status to each record', () => {
  const campaigns = [{ id: 'sc_1', name: 'A', owner: 'a@b', searchUrls: ['u1'], profileIds: ['p1'] }];
  const jobs = [{ id: 'j1', searchUrl: 'u1', state: 'running', profiles: 50 }];
  const merged = mergeCampaignsWithJobs(campaigns, jobs);
  assert.equal(merged[0].status, 'running');
  assert.equal(merged[0].jobs.length, 1);
  assert.equal(merged[0].totalProfiles, 50);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/scrape-campaigns-merge.test.js`
Expected: FAIL — `mergeCampaignsWithJobs` is not exported.

- [ ] **Step 3: Implement `mergeCampaignsWithJobs` in `src/scrape-campaigns.js`**

Append to `src/scrape-campaigns.js` (mirrors the browser helper so both layers agree — keep the logic identical):

```javascript
export function campaignStatus(jobs) {
  if (!jobs || !jobs.length) return 'idle';
  if (jobs.some((j) => j.state === 'running')) return 'running';
  if (jobs.some((j) => j.state === 'queued')) return 'queued';
  if (jobs.some((j) => j.state === 'error' || j.state === 'cancelled') && !jobs.some((j) => j.state === 'done')) return 'error';
  if (jobs.some((j) => j.state === 'done')) return 'done';
  return 'idle';
}

export function mergeCampaignsWithJobs(campaigns, jobs) {
  const byUrl = new Map();
  for (const c of campaigns || []) for (const u of (c.searchUrls || [])) byUrl.set(u, c.id);
  const jobsByCampaign = new Map();
  for (const j of jobs || []) {
    const cid = byUrl.get(j.searchUrl);
    if (!cid) continue;
    if (!jobsByCampaign.has(cid)) jobsByCampaign.set(cid, []);
    jobsByCampaign.get(cid).push(j);
  }
  return (campaigns || []).map((c) => {
    const cjobs = jobsByCampaign.get(c.id) || [];
    const positions = cjobs.filter((j) => j.state === 'queued' && j.position).map((j) => j.position);
    const etas = cjobs.filter((j) => j.etaMs).map((j) => j.etaMs);
    return {
      ...c, jobs: cjobs, status: campaignStatus(cjobs),
      running: cjobs.filter((j) => j.state === 'running').length,
      queued: cjobs.filter((j) => j.state === 'queued').length,
      done: cjobs.filter((j) => j.state === 'done').length,
      totalProfiles: cjobs.reduce((n, j) => n + (j.profiles || 0), 0),
      minPosition: positions.length ? Math.min(...positions) : null,
      etaMs: etas.length ? Math.min(...etas) : null,
    };
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/scrape-campaigns-merge.test.js`
Expected: PASS.

- [ ] **Step 5: Wire persistence into the launch route + add the list route in `server.js`**

At the top of server.js, add to the scraper-client import group an import of the store:
```javascript
import { addScrapeCampaign, listScrapeCampaigns, getScrapeCampaign, updateScrapeCampaign, mergeCampaignsWithJobs } from './src/scrape-campaigns.js';
import { appendAction, readScrapeLog } from './src/scrape-campaign-logs.js';
```

Replace the existing `/api/scrape/start` handler (server.js ~2070-2074) with one that records a campaign after a successful launch. Preserve the exact request/response contract; only add persistence:
```javascript
app.post('/api/scrape/start', async (req, res) => {
  const { searchUrls, sheetUrl, tabName, profileId, slowMode, name, profileIds } = req.body || {};
  const result = await startScrape({ searchUrls, sheetUrl, tabName, profileId, slowMode });
  if (result && result.error) return res.status(400).json(result);
  // Persist a campaign wrapper so the board can group these jobs by owner.
  try {
    const urls = Array.isArray(searchUrls) ? searchUrls : [searchUrls];
    await addScrapeCampaign({
      name: name || tabName || 'Sales Nav scrape',
      owner: req.user || null,
      sheetUrl, tabName,
      profileIds: Array.isArray(profileIds) ? profileIds : (profileId ? [profileId] : []),
      searchUrls: urls,
    });
  } catch (e) { console.error('scrape-campaign persist failed:', e.message); }
  res.status(200).json(result);
});
```

Add next to the other scrape routes (after `/api/scrape/logs`, ~2112):
```javascript
app.get('/api/scrape/campaigns', async (_req, res) => {
  try {
    const [campaigns, jobsRes] = await Promise.all([listScrapeCampaigns(), getJobs()]);
    const jobs = Array.isArray(jobsRes) ? jobsRes : (jobsRes && jobsRes.jobs) || [];
    res.json({ campaigns: mergeCampaignsWithJobs(campaigns, jobs) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});
```

- [ ] **Step 6: Manual smoke + commit**

Run: `node --test tests/scrape-campaigns-merge.test.js` (still PASS). Start the app (`npm run dev:app`), confirm `GET /api/scrape/campaigns` returns `{ campaigns: [...] }` (empty array is fine before any launch).
```bash
git add server.js src/scrape-campaigns.js tests/scrape-campaigns-merge.test.js
git commit -m "feat(scrape): persist campaign at launch + GET /api/scrape/campaigns (merged with engine jobs)"
```

---

## Task 5: Toggle + per-campaign logs routes

**Files:**
- Modify: `server.js` (near the new campaigns route)
- Test: covered by Task 1/2 unit tests + manual; add `tests/scrape-toggle-action.test.js` for the action-line format via `appendAction` (already in Task 2 — extend only if a gap).

**Interfaces:**
- Produces:
  - `POST /api/scrape/campaigns/:id/toggle` body `{ on:boolean }` → resolves owner-gate server-side is NOT enforced (UI handles the confirm); server pauses/resumes each `profileId` and logs the action with `req.user`. Response `{ ok, enabled }`.
  - `GET /api/scrape/campaigns/:id/logs?since=<ms>` → `{ lines: [{ts,message}] }` merging persisted history with live engine logs.

- [ ] **Step 1: Add the toggle route in `server.js`**

```javascript
app.post('/api/scrape/campaigns/:id/toggle', async (req, res) => {
  const rec = await getScrapeCampaign(req.params.id);
  if (!rec) return res.status(404).json({ error: 'unknown campaign' });
  const on = !!(req.body && req.body.on);
  // Drive the engine controls the campaign's profiles already expose.
  for (const pid of rec.profileIds || []) {
    try { on ? await resumeScrape(pid) : await pauseScrape(pid); }
    catch (e) { console.error('toggle scrape profile failed:', pid, e.message); }
  }
  await updateScrapeCampaign(rec.id, { enabled: on });
  const actor = req.user || 'unknown';
  const admin = actor.toLowerCase() === 'antonio@ortusclub.com';
  await appendAction(rec.id, { actor, admin, action: `toggled ${on ? 'ON' : 'OFF'}` });
  res.json({ ok: true, enabled: on });
});
```

Ensure `resumeScrape` and `pauseScrape` are in the scraper-client import group at the top of server.js (they are already imported for the existing pause/resume routes — reuse, do not re-import).

- [ ] **Step 2: Add the per-campaign logs route in `server.js`**

```javascript
app.get('/api/scrape/campaigns/:id/logs', async (req, res) => {
  const rec = await getScrapeCampaign(req.params.id);
  if (!rec) return res.status(404).json({ error: 'unknown campaign' });
  const persisted = await readScrapeLog(rec.id, { limit: 300 });
  // For a running campaign, also fold in live engine lines for this campaign's tab.
  let live = [];
  try {
    const l = await getScrapeLogs(req.query.since);
    const lines = Array.isArray(l) ? l : (l && l.logs) || [];
    live = lines.filter((ln) => !rec.tabName || ln.tabName === rec.tabName)
                .map((ln) => ({ ts: ln.ts, message: ln.message }));
  } catch { /* engine offline — persisted still shows */ }
  const merged = [...persisted, ...live].sort((a, b) => (a.ts || 0) - (b.ts || 0));
  res.json({ lines: merged });
});
```

- [ ] **Step 3: Manual verification**

Start app. With a persisted campaign id `sc_x`, `POST /api/scrape/campaigns/sc_x/toggle {on:false}` returns `{ok:true,enabled:false}` and writes a `toggled OFF by <you>` line; `GET /api/scrape/campaigns/sc_x/logs` returns it under `lines`.

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat(scrape): campaign toggle (pause/resume + action log) and per-campaign logs route"
```

---

## Task 6: "Sales Nav" nav tab + board container (`public/index.html`)

**Files:**
- Modify: `public/index.html` (sidebar nav ~34-70; add a board section; add namespaced CSS in the page's `<style>` or a `<style>` block near the scrape section)

**Interfaces:**
- Produces: a nav item `data-nav="nav-salesnav"` calling `openSalesNavBoard()` (defined in Task 7), and an empty board host `<div id="sn-board"></div>` inside a `#nav-salesnav` section. Namespaced CSS classes `.sn-*` / `.snm-*` copied from the reference sketch.

- [ ] **Step 1: Add the nav item** (after the existing campaign nav items, ~line 41):

```html
<div class="nav-section-label">Sales Nav</div>
<button type="button" class="nav-item" data-nav="nav-salesnav" onclick="openSalesNavBoard()"><span class="nav-num">◆</span>Sales Nav<span class="nav-glyph" id="nav-glyph-salesnav"></span></button>
```

- [ ] **Step 2: Add the board section** (a new top-level `.section`, place it right before the scrape config section `#nav-scrape` at line 1122):

```html
<div class="section" id="nav-salesnav" style="display:none">
  <div class="sn-boardhead">
    <div>
      <div class="sn-kicker" id="sn-datekicker">Sales Nav</div>
      <h2 class="sn-boardtitle">Sales Nav Queue</h2>
    </div>
    <div class="sn-qmeta" id="sn-qmeta">—</div>
    <button type="button" class="sn-newbtn" onclick="startNewScrapeSetup()">＋ New scrape</button>
  </div>
  <div id="sn-handover" class="sn-handover"><span class="spin"></span><span class="txt" id="sn-handover-txt"></span></div>
  <div id="sn-board"></div>
</div>
```

- [ ] **Step 3: Add namespaced CSS** — copy the `.sn-*` and `#snm-scrim/.snm-*` rules verbatim from `public/sketches/2026-07-01-salesnav-board-v1-jobs-tabs.html` `<style>` into a `<style>` block in index.html (they are already namespaced and collision-safe). Include the confirm-modal markup block at the end of `<body>`:

```html
<div id="snm-scrim">
  <div class="snm-card">
    <div class="snm-title">Are you sure?</div>
    <div class="snm-text" id="snm-body">This isn’t your campaign.</div>
    <div class="snm-row"><button class="snm-btn" id="snm-cancel">Cancel</button><button class="snm-btn solid" id="snm-ok">Yes, toggle it</button></div>
  </div>
</div>
```

- [ ] **Step 4: Manual verification**

Start app, reload. The "Sales Nav" nav item appears; clicking it (once `openSalesNavBoard` exists in Task 7) shows the empty board section. Until Task 7, verify the section markup renders without breaking layout (temporarily set `display:block`).

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "feat(scrape): Sales Nav nav tab + board container + namespaced board/modal CSS"
```

---

## Task 7: Board render + polling (`public/js/app.js`)

**Files:**
- Modify: `public/js/app.js` (add board functions; reuse `escHtml`; import the pure helper)
- Test: none new (logic lives in the tested `scrape-board.mjs`); manual UI verification.

**Interfaces:**
- Consumes: `GET /api/scrape/campaigns`, `GET /api/operator-identity`, `scrape-board.mjs` helpers.
- Produces: `openSalesNavBoard()`, `renderSalesNavBoard(data)`, `pollSalesNavBoard()`, `startNewScrapeSetup()` (routes to the scrape setup section), and `window.*` exposure for the inline `onclick`s.

- [ ] **Step 1: Add the board module import + current-operator fetch** at the top of app.js (near other imports if ESM, else via dynamic import as the file already does for `.mjs`). Add:

```javascript
import { groupJobsIntoCampaigns, campaignStatus, toggleDecision, fmtEta, ADMIN_EMAIL } from './scrape-board.mjs';

let snCurrentEmail = '';
async function loadOperatorEmail() {
  try { const r = await fetch('/api/operator-identity'); const d = await r.json(); snCurrentEmail = (d && d.email) || ''; }
  catch { snCurrentEmail = ''; }
}
```

- [ ] **Step 2: Implement open + poll + render**

```javascript
let _snPollTimer = null;
async function openSalesNavBoard() {
  document.querySelectorAll('.section').forEach((s) => { s.style.display = 'none'; });
  const sec = document.getElementById('nav-salesnav');
  if (sec) sec.style.display = 'block';
  await loadOperatorEmail();
  await pollSalesNavBoard();
  clearInterval(_snPollTimer);
  _snPollTimer = setInterval(pollSalesNavBoard, 2500);
}
window.openSalesNavBoard = openSalesNavBoard;

async function pollSalesNavBoard() {
  const host = document.getElementById('sn-board');
  if (!host || document.hidden) return;
  try {
    const r = await fetch('/api/scrape/campaigns');
    const d = await r.json();
    if (d && d.error) { host.innerHTML = `<div class="sn-empty">${escHtml(d.error)}</div>`; return; }
    renderSalesNavBoard(d.campaigns || []);
  } catch (_) { /* keep last render */ }
}

function _snStatusDot(status) {
  const cls = status === 'running' ? 'run' : status === 'queued' ? 'q' : status === 'error' ? 'red' : 'mon';
  return `<span class="dot ${cls}"></span>`;
}

function renderSalesNavBoard(campaigns) {
  const host = document.getElementById('sn-board');
  const running = campaigns.filter((c) => c.status === 'running');
  const queued = campaigns.filter((c) => c.status === 'queued');
  const done = campaigns.filter((c) => c.status === 'done' || c.status === 'error');
  document.getElementById('sn-qmeta').textContent =
    `${running.length} running · ${queued.length} queued`;
  let html = '';
  const rail = (label, list) => list.length
    ? `<div class="sn-railhead">${label}</div>` + list.map(renderStrip).join('') : '';
  html += rail('▶ Now running', running);
  html += rail('• Up next in the queue', queued);
  html += rail('✓ Done', done);
  if (!campaigns.length) html = `<div class="sn-empty">No scrapes yet — press ＋ New scrape.</div>`;
  host.innerHTML = html;
}

function renderStrip(c) {
  const isQueued = c.status === 'queued';
  const owner = c.owner || 'unknown';
  const nJobs = (c.jobs || []).length || (c.searchUrls || []).length;
  const flow = `<b>${(c.searchUrls || []).length} searches</b> → <b>${nJobs} jobs</b> → feeds <b>${escHtml(c.name || c.tabName || '')}</b> · tab “${escHtml(c.tabName || 'Results')}”`;
  const statusTxt = isQueued
    ? `Queued${c.minPosition ? ` · #${c.minPosition}` : ''}${c.etaMs ? ` · ${fmtEta(c.etaMs)}` : ''}`
    : c.status === 'running' ? `Running · ${c.done}/${nJobs} jobs` : (c.status === 'error' ? 'Error' : 'Done');
  const jobsPane = (c.jobs || []).map((j) => {
    const label = j.searchUrl ? j.searchUrl.slice(0, 60) : 'search';
    const st = j.state === 'running' ? `<span class="dot run"></span> Running · ${j.profiles || 0} rows`
      : j.state === 'done' ? `<span class="dot mon"></span> Done · ${j.profiles || 0} rows`
      : j.state === 'error' ? `<span class="dot red"></span> Error`
      : `<span class="dot q"></span> Queued`;
    return `<div class="job"><div><div class="jt">${escHtml(label)}</div></div><div class="jstat">${st}</div></div>`;
  }).join('') || '<div class="sn-empty">No jobs.</div>';
  const canOpen = !isQueued || _snIsOwnerOrAdmin(owner);
  const openBtn = canOpen
    ? `<button class="mini solid" onclick="openScrapeSetupFor('${escHtml(c.id)}')">Open</button>`
    : `<button class="mini locked" title="Only ${escHtml(owner)} can open this">Open 🔒</button>`;
  const toggleOn = c.enabled !== false;
  const switchBlock = isQueued ? '' : `
    <div class="sn-switch">
      <div class="sn-switchtabs"><span class="sn-st on" data-t="jobs">Jobs</span><span class="sn-st" data-t="logs">Logs</span></div>
      <div class="sn-pane on" data-p="jobs">${jobsPane}</div>
      <div class="sn-pane" data-p="logs"><div class="logbox" data-logsfor="${escHtml(c.id)}">…</div></div>
    </div>`;
  return `
  <div class="sn-strip ${c.status === 'running' ? 'run' : ''} ${isQueued ? 'queued sn-collapsed' : ''} ${c.status === 'done' || c.status === 'error' ? 'done' : ''}" data-cid="${escHtml(c.id)}">
    <div class="sn-qpos">${isQueued && c.minPosition ? c.minPosition : (c.status === 'running' ? '▶' : '✓')}</div>
    <div class="sn-top"><span class="sn-type">Sales Nav Scraper</span><span class="sn-owner">· ${escHtml(owner)}</span>
      <span class="sn-status">${_snStatusDot(c.status)} ${escHtml(statusTxt)}</span></div>
    <div class="sn-name">${escHtml(c.name || '')}</div>
    <div class="sn-flow">${flow}</div>
    ${switchBlock}
    <div class="sn-foot">
      <div class="togwrap"><div class="toggle ${toggleOn ? '' : 'off'}" data-owner="${escHtml(owner)}" data-cid="${escHtml(c.id)}"><i></i></div><span class="lbl">${toggleOn ? 'On' : 'Off'}</span></div>
      <div class="right">${c.status === 'running' ? '<button class="mini" onclick="stopScrapeCampaign(\'' + escHtml(c.id) + '\')">Stop</button>' : ''}${openBtn}</div>
    </div>
  </div>`;
}

function _snIsOwnerOrAdmin(owner) {
  const dec = toggleDecision({ currentEmail: snCurrentEmail, ownerEmail: owner });
  return !dec.needsConfirm;
}

function startNewScrapeSetup() { openScrapeSetupFor(''); }
window.startNewScrapeSetup = startNewScrapeSetup;
```

- [ ] **Step 3: Wire the in-strip Jobs/Logs tab switching + lazy log loading** (delegate once):

```javascript
document.addEventListener('click', (e) => {
  const tab = e.target.closest('.sn-st');
  if (tab) {
    const sw = tab.closest('.sn-switch');
    sw.querySelectorAll('.sn-st').forEach((x) => x.classList.toggle('on', x === tab));
    sw.querySelectorAll('.sn-pane').forEach((p) => p.classList.toggle('on', p.dataset.p === tab.dataset.t));
    if (tab.dataset.t === 'logs') {
      const box = sw.querySelector('.logbox');
      if (box && box.dataset.logsfor) _snLoadLogs(box);
    }
  }
});
async function _snLoadLogs(box) {
  try {
    const r = await fetch(`/api/scrape/campaigns/${encodeURIComponent(box.dataset.logsfor)}/logs`);
    const d = await r.json();
    box.innerHTML = (d.lines || []).map((l) =>
      `<div><span class="t">${new Date(l.ts).toLocaleTimeString()}</span> ${escHtml(l.message)}</div>`).join('') || 'No logs yet.';
  } catch { box.textContent = 'Logs unavailable.'; }
}
```

- [ ] **Step 4: Manual verification**

Launch a scrape (from the setup section) to create a persisted campaign, open the Sales Nav tab, confirm the strip renders with the flow line, a running/queued status, Jobs pane populated, Logs pane loading lines, and queued strips collapsed with an owner-locked Open when not yours.

- [ ] **Step 5: Commit**

```bash
git add public/js/app.js
git commit -m "feat(scrape): Sales Nav board render + polling + Jobs/Logs tabs"
```

---

## Task 8: Owner-gated toggle + confirm + admin bypass

**Files:**
- Modify: `public/js/app.js`

**Interfaces:**
- Consumes: `toggleDecision` (scrape-board.mjs), `POST /api/scrape/campaigns/:id/toggle`.
- Produces: click handling on `.toggle`, the confirm modal wiring, and `stopScrapeCampaign(id)`.

- [ ] **Step 1: Add toggle + confirm handling**

```javascript
let _snPendingToggle = null;
function _snApplyToggle(el, cid) {
  const goingOn = el.classList.contains('off'); // currently off → turning on
  fetch(`/api/scrape/campaigns/${encodeURIComponent(cid)}/toggle`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ on: goingOn }),
  }).then(() => pollSalesNavBoard()).catch(() => {});
}
document.addEventListener('click', (e) => {
  const t = e.target.closest('.toggle');
  if (!t || !t.dataset.cid) return;
  const owner = t.dataset.owner || '';
  const dec = toggleDecision({ currentEmail: snCurrentEmail, ownerEmail: owner });
  if (dec.needsConfirm) {
    _snPendingToggle = { el: t, cid: t.dataset.cid };
    const goingTo = t.classList.contains('off') ? 'ON' : 'OFF';
    document.getElementById('snm-body').innerHTML =
      `This isn’t your campaign — it belongs to <b>${escHtml(owner)}</b>. Turning it <b>${goingTo}</b> affects their scrape and its place in the queue. Continue?`;
    document.getElementById('snm-scrim').classList.add('open');
    return;
  }
  _snApplyToggle(t, t.dataset.cid); // owner or admin → immediate
});
document.getElementById('snm-cancel')?.addEventListener('click', () => {
  _snPendingToggle = null; document.getElementById('snm-scrim').classList.remove('open');
});
document.getElementById('snm-ok')?.addEventListener('click', () => {
  if (_snPendingToggle) _snApplyToggle(_snPendingToggle.el, _snPendingToggle.cid);
  _snPendingToggle = null; document.getElementById('snm-scrim').classList.remove('open');
});

function stopScrapeCampaign(cid) {
  fetch(`/api/scrape/campaigns/${encodeURIComponent(cid)}/toggle`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: false }),
  }).then(() => pollSalesNavBoard());
}
window.stopScrapeCampaign = stopScrapeCampaign;
```

- [ ] **Step 2: Manual verification**

As a non-owner, clicking a toggle shows the confirm; Cancel leaves it, Confirm flips it (verify a `toggled … by <you>` line appears in that campaign's Logs). As `antonio@ortusclub.com` (set via operator-identity), the toggle flips with no confirm and logs `(admin)`.

- [ ] **Step 3: Commit**

```bash
git add public/js/app.js
git commit -m "feat(scrape): owner-gated toggle with non-owner confirm + admin bypass"
```

---

## Task 9: Stop → launch handover visual

**Files:**
- Modify: `public/js/app.js`

**Interfaces:**
- Consumes: board poll data (status transitions).
- Produces: a handover banner driven by observed state changes — when a campaign goes running→done/stopped and another goes queued→running between polls, show the banner sequence from the sketch.

- [ ] **Step 1: Track previous statuses and detect a handover**

```javascript
let _snPrevStatus = new Map(); // cid -> status
function _snDetectHandover(campaigns) {
  const nowStatus = new Map(campaigns.map((c) => [c.id, c.status]));
  let stopped = null, started = null;
  for (const [cid, prev] of _snPrevStatus) {
    const cur = nowStatus.get(cid);
    if (prev === 'running' && (cur === 'done' || cur === 'error' || cur === undefined)) stopped = cid;
  }
  for (const c of campaigns) {
    if (_snPrevStatus.get(c.id) === 'queued' && c.status === 'running') started = c.id;
  }
  _snPrevStatus = nowStatus;
  if (stopped || started) _snShowHandover(campaigns, stopped, started);
}
function _snName(campaigns, cid) { const c = campaigns.find((x) => x.id === cid); return c ? (c.name || 'a scrape') : 'a scrape'; }
function _snShowHandover(campaigns, stopped, started) {
  const ho = document.getElementById('sn-handover'), txt = document.getElementById('sn-handover-txt');
  if (!ho) return;
  if (stopped && started) {
    ho.className = 'sn-handover show launching';
    txt.innerHTML = `<b>Handover</b> — ${escHtml(_snName(campaigns, stopped))} stopped, now launching <b>${escHtml(_snName(campaigns, started))}</b>.`;
  } else if (stopped) {
    ho.className = 'sn-handover show stopping';
    txt.innerHTML = `<b>Stopped</b> ${escHtml(_snName(campaigns, stopped))}.`;
  } else {
    ho.className = 'sn-handover show launching';
    txt.innerHTML = `<b>Launching</b> ${escHtml(_snName(campaigns, started))}…`;
  }
  clearTimeout(ho._t); ho._t = setTimeout(() => { ho.className = 'sn-handover'; }, 5000);
}
```

- [ ] **Step 2: Call the detector from `renderSalesNavBoard`** — add as the first line of `renderSalesNavBoard(campaigns)`:

```javascript
  _snDetectHandover(campaigns);
```

- [ ] **Step 3: Manual verification**

Stop a running campaign while another is queued; within a poll cycle the banner narrates the stop and the next launch, then fades. (The `.sn-handover` / `.stopping` / `.launching` CSS came in with Task 6.)

- [ ] **Step 4: Commit**

```bash
git add public/js/app.js
git commit -m "feat(scrape): stop->launch handover banner driven by status transitions"
```

---

## Task 10: Open → setup routing + remove the old wizard mode

**Files:**
- Modify: `public/js/app.js` (`MODE_LIST` ~3273-3407; add `openScrapeSetupFor`)
- Modify: `public/index.html` (only if the mode option is hard-coded in markup — otherwise MODE_LIST drives it)

**Interfaces:**
- Consumes: existing scrape setup section `#nav-scrape` (index.html 1122-1211).
- Produces: `openScrapeSetupFor(campaignId)` — shows the scrape setup section (the same config screen), pre-filling from the campaign record when an id is given; removes `sales_nav_scrape` from the New Campaign mode list.

- [ ] **Step 1: Implement `openScrapeSetupFor`**

```javascript
async function openScrapeSetupFor(cid) {
  document.querySelectorAll('.section').forEach((s) => { s.style.display = 'none'; });
  const scrape = document.getElementById('nav-scrape');
  if (scrape) scrape.style.display = 'block';
  // Show the account picker + launch sections the scrape flow needs (same as today's mode).
  ['nav-accounts', 'nav-launch'].forEach((id) => { const el = document.getElementById(id); if (el) el.style.display = 'block'; });
  if (cid) {
    try {
      const r = await fetch('/api/scrape/campaigns'); const d = await r.json();
      const rec = (d.campaigns || []).find((c) => c.id === cid);
      if (rec) {
        const urls = document.getElementById('scrape-urls'); if (urls) urls.value = (rec.searchUrls || []).join('\n');
        const sheet = document.getElementById('scrape-sheet'); if (sheet) sheet.value = rec.sheetUrl || '';
        const tab = document.getElementById('scrape-tab'); if (tab) tab.value = rec.tabName || 'Results';
        if (typeof updateScrapePairing === 'function') updateScrapePairing();
      }
    } catch { /* new/empty setup */ }
  }
}
window.openScrapeSetupFor = openScrapeSetupFor;
```

- [ ] **Step 2: Remove `sales_nav_scrape` from the New Campaign wizard** — in `public/js/app.js` `MODE_LIST` (~3273-3407), delete the `{ value: 'sales_nav_scrape', ... }` entry so it no longer appears in Section I. (Leave the `#nav-scrape` section and all scrape handlers intact — they're now reached via the Sales Nav tab.)

- [ ] **Step 3: Manual verification**

New Campaign no longer lists "Sales Nav Scrape" as a type. From the board, "Open" on your own campaign shows the scrape setup pre-filled; "＋ New scrape" shows an empty setup. A queued campaign you don't own shows "Open 🔒" and does nothing.

- [ ] **Step 4: Commit**

```bash
git add public/js/app.js public/index.html
git commit -m "feat(scrape): Open routes to setup page; remove sales_nav_scrape from New Campaign wizard"
```

---

## Task 11: Version bump + end-to-end verification

**Files:**
- Modify: `package.json` (version)

- [ ] **Step 1: Bump the patch version** in `package.json` (e.g. `2.124.1` → `2.125.0` for a feature).

- [ ] **Step 2: Run the whole affected test set**

Run: `node --test tests/scrape-campaigns.test.js tests/scrape-campaign-logs.test.js tests/scrape-board.test.js tests/scrape-campaigns-merge.test.js`
Expected: all PASS.

- [ ] **Step 3: Relaunch and walk the full flow**

```bash
pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "Electron.*ortus" 2>/dev/null
npm run dev:app > /tmp/dev-app.log 2>&1 &
```
Verify, in order: Sales Nav tab opens the board; ＋ New scrape → setup → launch creates a strip; running strip shows Jobs (default) + Logs, Stop + Open; queued strip is collapsed with owner-gated Open; toggle flips (own = immediate; other = confirm; admin = immediate, logged); Logs tab shows persisted + live lines; stopping one while another is queued shows the handover banner; New Campaign no longer lists the scrape mode.

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "chore: v2.125.0 — Sales Nav scraper tab + queue board"
```

---

## Self-Review (completed against the spec)

**Spec coverage:** §5 tab/setup/board → Tasks 6,7,10. §6 board driven by engine state, multi-running, done section → Tasks 4,7. §6.1 running strip fields + Jobs/Logs → Task 7. §6.2 collapsed queued + owner-only Open → Task 7. §7 owner toggle + confirm + admin bypass + arm/disarm via pause/resume + action logging → Tasks 2,5,8. §8 Open→setup → Task 10. §9 handover visual → Task 9. §10 persisted fields → Tasks 1,4. §11 remove old mode on ship → Task 10; admin override → Tasks 3,5,8. §12 B1→Task 1, B2→Tasks 2,5, B3→Tasks 6-9, B4→Tasks 2,5,8.

**Type consistency:** `campaignStatus`/`mergeCampaignsWithJobs` are duplicated intentionally in `src/scrape-campaigns.js` (server) and `public/js/scrape-board.mjs` (browser) with identical logic — flagged so a reviewer treats divergence as a bug. Record shape (`id, name, owner, sheetUrl, tabName, profileIds, searchUrls, enabled, createdAt`) is consistent across Tasks 1, 4, 7, 10. Toggle contract `{on:boolean}` consistent Tasks 5, 8.

**Known review flag:** the server (ESM `src/*.js`) cannot import the browser `public/js/scrape-board.mjs`, so `campaignStatus`/merge logic is intentionally implemented in both places. If a shared, importable location is preferred, a follow-up can extract a neutral `src/` module the browser also imports — out of scope here to avoid restructuring the frontend module strategy.
