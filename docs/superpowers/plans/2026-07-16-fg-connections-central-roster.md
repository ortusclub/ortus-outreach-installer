# Central Connections Roster Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the FG Team Launch roster and the Connections Search tab work 1:1 (live) for every operator, not just Antonio, by serving the local 152 MB connections DB from one thin always-on GKE service that runs the app's real roster code.

**Architecture:** A ~60-line Express service (`services/fg-roster/`) imports the app's real `src/connections/search-service.js` and exposes one `POST /rpc` (whitelist of five pure DB reads) + `/health` + `/admin/refresh`. The app's five DB-backed routes go through a new `dbCall(fn, args)` helper that runs locally when the DB cache file exists (Antonio) and otherwise POSTs to the central service (everyone else). The DB lives in a GCS bucket, pulled to the pod on boot; a publish script pushes it after each re-ingest.

**Tech Stack:** Node ≥22 ESM, Express 4, `@google-cloud/storage`, `node --test`, GKE (namespace `salesnav-scraper`), GCS.

## Global Constraints

- Runtime: Node ≥22, ESM (`package.json` has `"type": "module"`), no bundler, Express 4. Server-side global `fetch` is available.
- Tests: `node --test tests/*.test.js`; `import { test } from 'node:test'` + `import assert from 'node:assert/strict'`. Prefer pure-helper unit tests. New test files go in `tests/`.
- **1:1 fidelity, zero drift:** the service runs the app's real `src/connections/search-service.js`. NEVER copy or reimplement the match/roster logic anywhere.
- **Whitelist is exactly these five read functions:** `listFgColleaguesMatched`, `getConnectionsStats`, `searchConnections`, `exportConnections`, `buildLeadRows`. No other `fn`, no writes, no `sync`.
- **Baked-in endpoint:** `FG_ROSTER_URL = 'https://scraper.ortusclub.com/fg-roster'`, `FG_ROSTER_TOKEN = 'ortus2026scraper'`, each overridable by an env var of the same name (mirror `src/scraper-engine-url.js`).
- **Fail-closed:** a central error surfaces the app's existing "try again" errors; NEVER fall back to a silent empty result.
- **`/api/connections/sync` is untouched** — that is the ingest (Antonio's data build), not a remote-operator path.
- Off-limits files (untouched by this plan): `src/linkedin/outreach.js`, `src/linkedin/actions.js`.
- **Prod deploy (`kubectl apply`) requires explicit user approval** — Task 6 prepares artifacts + runbook only; the apply is a gated manual step.
- Per repo rule, bump `package.json` version when the app-side runtime change (Task 3) is committed, so the running build is identifiable.

## File Structure

- `src/connections/search-service.js` (modify) — add `hasLocalDb()`.
- `src/fg-roster-url.js` (create) — baked-in URL + token, env-overridable.
- `src/connections/db-client.js` (create) — `ROSTER_FNS`, `rpcDispatch(fn, args, impl)`, `dbCall(fn, args, opts)`. The one place local-vs-central and whitelist logic live. Imported by both `server.js` (client) and `services/fg-roster/server.js` (service).
- `server.js` (modify) — route the five DB reads through `dbCall`.
- `services/fg-roster/app.js` (create) — `makeApp({ impl, token, isReady, onRefresh })` returning the Express app (pure, testable).
- `services/fg-roster/server.js` (create) — entry: GCS boot-pull → `listen` (ops, thin).
- `services/fg-roster/pull-db.js` (create) — GCS → local dir download.
- `services/fg-roster/Dockerfile` (create).
- `k8s/fg-roster/{deployment,service,secret.example}.yaml` (create) + ingress path snippet.
- `scripts/publish-connections-db.sh` (create).
- Tests: `tests/has-local-db.test.js`, `tests/db-client.test.js`, `tests/fg-roster-app.test.js`.

---

### Task 1: `hasLocalDb()` — the remote-vs-local signal

**Files:**
- Modify: `src/connections/search-service.js` (add export near the top-level path constants, after line ~18)
- Test: `tests/has-local-db.test.js`

**Interfaces:**
- Produces: `hasLocalDb({ cachePath }?) => boolean` — true iff the connections cache file exists. Default `cachePath` is the module's `DEFAULT_CACHE` (`data/connections-cache.json`).

- [ ] **Step 1: Write the failing test**

```js
// tests/has-local-db.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hasLocalDb } from '../src/connections/search-service.js';

test('hasLocalDb is true when the cache file exists, false when absent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hld-'));
  const cachePath = path.join(dir, 'connections-cache.json');
  assert.equal(hasLocalDb({ cachePath }), false);
  fs.writeFileSync(cachePath, '{"contacts":[]}');
  assert.equal(hasLocalDb({ cachePath }), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/has-local-db.test.js`
Expected: FAIL — `hasLocalDb` is not exported (`SyntaxError`/`undefined is not a function`).

- [ ] **Step 3: Implement `hasLocalDb`**

Add to `src/connections/search-service.js`, immediately after the `COLLEAGUES_PATH` constant (line ~18):

```js
// True iff the local connections cache exists. This is the exact remote-vs-local
// signal: DMG builds exclude data/**, so remote operators have no cache file and
// the app routes fall back to the central roster service (src/connections/db-client.js).
export function hasLocalDb({ cachePath = DEFAULT_CACHE } = {}) {
  try { return fs.existsSync(cachePath); } catch { return false; }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/has-local-db.test.js`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/connections/search-service.js tests/has-local-db.test.js
git commit -m "feat(connections): add hasLocalDb() remote-vs-local signal"
```

---

### Task 2: `db-client.js` + `fg-roster-url.js` — whitelist, dispatch, and local-or-central call

**Files:**
- Create: `src/fg-roster-url.js`
- Create: `src/connections/db-client.js`
- Test: `tests/db-client.test.js`

**Interfaces:**
- Consumes: `hasLocalDb` from Task 1; `* as searchService` from `search-service.js`; `FG_ROSTER_URL`, `FG_ROSTER_TOKEN` from `fg-roster-url.js`.
- Produces:
  - `ROSTER_FNS: string[]` — the five whitelisted function names.
  - `rpcDispatch(fn, args, impl) => any` — throws `Error('unknown roster fn: <fn>')` if `fn` not in `ROSTER_FNS`; else returns `impl[fn](...args)`. (Used by the service; the trust boundary.)
  - `dbCall(fn, args, opts?) => Promise<any>` — if `opts.hasLocal()` true → `opts.local[fn](...args)`; else POST `{fn,args}` to `${opts.rosterUrl}/rpc` with Bearer, return parsed `.result`; throw on non-2xx. Defaults: `hasLocal=hasLocalDb`, `local=searchService`, `rosterUrl=FG_ROSTER_URL`, `rosterToken=FG_ROSTER_TOKEN`, `fetchImpl=fetch`.

- [ ] **Step 1: Write the failing test**

```js
// tests/db-client.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROSTER_FNS, rpcDispatch, dbCall } from '../src/connections/db-client.js';

test('ROSTER_FNS is exactly the five whitelisted reads', () => {
  assert.deepEqual([...ROSTER_FNS].sort(), [
    'buildLeadRows', 'exportConnections', 'getConnectionsStats',
    'listFgColleaguesMatched', 'searchConnections',
  ]);
});

test('rpcDispatch calls a whitelisted fn on the impl with spread args', () => {
  const impl = { searchConnections: (crit, opts) => ({ crit, opts }) };
  assert.deepEqual(rpcDispatch('searchConnections', [{ q: 1 }, { limit: 5 }], impl),
    { crit: { q: 1 }, opts: { limit: 5 } });
});

test('rpcDispatch throws on a non-whitelisted fn', () => {
  assert.throws(() => rpcDispatch('startConnectionsSync', [], { startConnectionsSync: () => 1 }),
    /unknown roster fn: startConnectionsSync/);
});

test('dbCall runs locally when hasLocal() is true and never fetches', async () => {
  let fetched = false;
  const out = await dbCall('getConnectionsStats', [], {
    hasLocal: () => true,
    local: { getConnectionsStats: () => ({ total: 42 }) },
    fetchImpl: () => { fetched = true; throw new Error('should not fetch'); },
  });
  assert.deepEqual(out, { total: 42 });
  assert.equal(fetched, false);
});

test('dbCall POSTs to central with Bearer and returns .result when hasLocal() is false', async () => {
  let seen;
  const out = await dbCall('searchConnections', [{ q: 1 }, { limit: 5 }], {
    hasLocal: () => false,
    rosterUrl: 'https://x/fg-roster',
    rosterToken: 'tok',
    fetchImpl: async (url, opts) => {
      seen = { url, opts };
      return { ok: true, status: 200, json: async () => ({ result: [{ email: 'a' }] }) };
    },
  });
  assert.deepEqual(out, [{ email: 'a' }]);
  assert.equal(seen.url, 'https://x/fg-roster/rpc');
  assert.equal(seen.opts.method, 'POST');
  assert.equal(seen.opts.headers.authorization, 'Bearer tok');
  assert.deepEqual(JSON.parse(seen.opts.body), { fn: 'searchConnections', args: [{ q: 1 }, { limit: 5 }] });
});

test('dbCall throws (fail-closed) on a non-2xx central response', async () => {
  await assert.rejects(() => dbCall('getConnectionsStats', [], {
    hasLocal: () => false,
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({ error: 'db not loaded' }) }),
  }), /roster getConnectionsStats failed: 503/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/db-client.test.js`
Expected: FAIL — `db-client.js` does not exist (module not found).

- [ ] **Step 3: Create `src/fg-roster-url.js`**

```js
/**
 * Central FG roster / connections service endpoint.
 *
 * Hard-coded (like scraper-engine-url.js) so EVERY build / DMG points at the
 * central roster service by default — no per-operator .env needed. Remote
 * operators (whose DMG has no local connections DB) reach the FG roster and
 * Connections Search through here.
 *
 * FG_ROSTER_URL / FG_ROSTER_TOKEN env vars override these for local dev
 * (e.g. http://localhost:8080/fg-roster).
 */
export const FG_ROSTER_URL = process.env.FG_ROSTER_URL || 'https://scraper.ortusclub.com/fg-roster';
export const FG_ROSTER_TOKEN = process.env.FG_ROSTER_TOKEN || 'ortus2026scraper';
```

- [ ] **Step 4: Create `src/connections/db-client.js`**

```js
// Local-or-central bridge for the DB-backed connections reads.
//
// The connections DB (data/connections/* + data/connections-cache.json, ~152MB)
// lives ONLY on the machine that ingested it (Antonio's). It is gitignored AND
// excluded from the DMG, so every other operator has no local DB. dbCall() runs
// the read locally when the DB is present and otherwise delegates to the central
// roster service (services/fg-roster), which runs THIS SAME search-service code.
// One copy of the match logic — no drift.
import * as searchService from './search-service.js';
import { hasLocalDb } from './search-service.js';
import { FG_ROSTER_URL, FG_ROSTER_TOKEN } from '../fg-roster-url.js';

// The only functions the central /rpc will run — pure reads over the DB.
export const ROSTER_FNS = [
  'listFgColleaguesMatched',
  'getConnectionsStats',
  'searchConnections',
  'exportConnections',
  'buildLeadRows',
];

// Whitelist guard + call. The service's trust boundary: an untrusted `fn` never
// reaches the impl.
export function rpcDispatch(fn, args, impl) {
  if (!ROSTER_FNS.includes(fn)) throw new Error(`unknown roster fn: ${fn}`);
  return impl[fn](...(args || []));
}

// Run a whitelisted read locally (DB present) or against the central service.
// Fail-closed: a non-2xx central response throws — callers surface their existing
// "try again" error rather than a silent-empty result.
export async function dbCall(fn, args, {
  hasLocal = hasLocalDb,
  local = searchService,
  rosterUrl = FG_ROSTER_URL,
  rosterToken = FG_ROSTER_TOKEN,
  fetchImpl = fetch,
} = {}) {
  if (hasLocal()) return local[fn](...(args || []));
  const r = await fetchImpl(`${rosterUrl}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${rosterToken}` },
    body: JSON.stringify({ fn, args: args || [] }),
  });
  if (!r.ok) throw new Error(`roster ${fn} failed: ${r.status}`);
  const j = await r.json();
  return j.result;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test tests/db-client.test.js`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add src/fg-roster-url.js src/connections/db-client.js tests/db-client.test.js
git commit -m "feat(connections): db-client (whitelist dispatch + local-or-central dbCall) + fg-roster-url"
```

---

### Task 3: Route the five app reads through `dbCall`

**Files:**
- Modify: `server.js` — import `dbCall`; rewrite the handlers at `/api/fg/colleagues` (~2233), `/api/connections/stats` (~2136), `/api/connections/search` (~2155), `/api/connections/export` (~2164), `/api/connections/to-workbook` (~2178). Bump `package.json` `version`.

**Interfaces:**
- Consumes: `dbCall` from Task 2. Existing app helpers unchanged: `parseRolesParam`, `getFgState`, `connectionsCriteria`, `getConnectionsSyncState`, `createWorkbookTab`.

- [ ] **Step 1: Add the import**

In `server.js`, next to the existing `search-service.js` import (line ~91), add:

```js
import { dbCall } from './src/connections/db-client.js';
```

(Leave the existing `search-service.js` import as-is; the local functions are still used by `dbCall`'s default `local` and elsewhere.)

- [ ] **Step 2: Rewrite `/api/fg/colleagues`**

Replace the body of the `app.get('/api/fg/colleagues', ...)` handler (~2233) with:

```js
app.get('/api/fg/colleagues', async (req, res) => {
  try {
    const roles = parseRolesParam(req.query.roles);
    let alreadyInvited = [];
    try {
      const { invites } = await getFgState();
      alreadyInvited = (invites || []).map((r) => String(r['Member ID'] || '') || (r['LinkedIn URL'] || ''));
    } catch (_) { console.warn('[fg/colleagues] FG sheet unreachable — falling back to raw matched counts:', _.message); }
    const colleagues = await dbCall('listFgColleaguesMatched', [roles, { alreadyInvited }]);
    res.json({ colleagues });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
```

- [ ] **Step 3: Rewrite the four connections routes**

```js
app.get('/api/connections/stats', async (_req, res) => {
  try {
    res.json({ ...(await dbCall('getConnectionsStats', [])), sync: getConnectionsSyncState() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/connections/search', async (req, res) => {
  try {
    const b = req.body || {};
    res.json(await dbCall('searchConnections', [connectionsCriteria(b), { limit: b.limit || 1000 }]));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/connections/export', async (req, res) => {
  try {
    const b = req.body || {};
    const urls = Array.isArray(b.urls) ? b.urls : undefined;
    res.json(await dbCall('exportConnections', [connectionsCriteria(b), { urls }]));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/connections/to-workbook', async (req, res) => {
  try {
    const b = req.body || {};
    const urls = Array.isArray(b.urls) ? b.urls : undefined;
    const { header, rows, count } = await dbCall('buildLeadRows', [connectionsCriteria(b), { urls }]);
    console.log(`[to-workbook] request: ${urls ? urls.length : 0} urls in, ${count} leads to write`);
    if (!count) return res.status(400).json({ error: 'No leads selected to write.' });
    const name = (b.name && String(b.name).trim()) || `Warm ICB list — ${new Date().toISOString().slice(0, 10)}`;
    const result = await createWorkbookTab({ name, header, rows });
    console.log(`[to-workbook] Apps Script returned: ${JSON.stringify(result).slice(0, 300)}`);
    res.json({ ...result, count });
  } catch (err) {
    console.error(`[to-workbook] FAILED: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});
```

(Note: `/api/connections/sync` is deliberately NOT changed.)

- [ ] **Step 4: Bump the version**

In `package.json`, bump the patch `version` (e.g. `2.160.17` → `2.160.18`) so the running build is identifiable.

- [ ] **Step 5: Verify existing tests still pass + regression-check locally**

Run: `node --test tests/*.test.js`
Expected: PASS (all existing tests green; Task 1 & 2 tests green). No test asserts these routes directly — they are thin wrappers over `dbCall`, which is unit-tested. Since `hasLocalDb()` is true on the dev machine (the cache exists), the routes behave exactly as before (local path). Confirm manually:

```bash
pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "Electron.*ortus" 2>/dev/null
npm run dev:app > /tmp/dev-app.log 2>&1 &
sleep 8
curl -s 'http://localhost:PORT/api/fg/colleagues?roles=marketing' | head -c 200   # non-empty colleagues
curl -s -X POST 'http://localhost:PORT/api/connections/search' -H 'content-type: application/json' -d '{"jobTitles":["marketing"]}' | head -c 200
```
Expected: same non-empty results as before the change (local DB path). (Replace `PORT` with the dev server's port from `/tmp/dev-app.log`.)

- [ ] **Step 6: Commit**

```bash
git add server.js package.json
git commit -m "feat(connections): route FG roster + Connections Search through dbCall (central fallback)"
```

---

### Task 4: Roster service — `makeApp` + entry + GCS pull

**Files:**
- Create: `services/fg-roster/app.js`
- Create: `services/fg-roster/pull-db.js`
- Create: `services/fg-roster/server.js`
- Test: `tests/fg-roster-app.test.js`

**Interfaces:**
- Consumes: `rpcDispatch`, `ROSTER_FNS` from Task 2; `express`.
- Produces: `makeApp({ impl, token, isReady, onRefresh }) => express.Application` mounting a router at `/fg-roster` with `GET /health`, `POST /rpc`, `POST /admin/refresh`.

- [ ] **Step 1: Write the failing test**

```js
// tests/fg-roster-app.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp } from '../services/fg-roster/app.js';

// Minimal in-process HTTP helper (no supertest dependency).
function listen(app) {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const { port } = srv.address();
      resolve({ port, close: () => new Promise((r) => srv.close(r)) });
    });
  });
}
const impl = { getConnectionsStats: () => ({ total: 7 }) };
const post = (port, path, body, headers = {}) => fetch(`http://127.0.0.1:${port}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});

test('GET /fg-roster/health is 200 and needs no auth', async () => {
  const app = makeApp({ impl, token: 't', isReady: () => true, onRefresh: async () => {} });
  const s = await listen(app);
  const r = await fetch(`http://127.0.0.1:${s.port}/fg-roster/health`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  await s.close();
});

test('POST /fg-roster/rpc: 401 without Bearer, 200 with a whitelisted fn', async () => {
  const app = makeApp({ impl, token: 't', isReady: () => true, onRefresh: async () => {} });
  const s = await listen(app);
  const noAuth = await post(s.port, '/fg-roster/rpc', { fn: 'getConnectionsStats', args: [] });
  assert.equal(noAuth.status, 401);
  const ok = await post(s.port, '/fg-roster/rpc', { fn: 'getConnectionsStats', args: [] }, { authorization: 'Bearer t' });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { result: { total: 7 } });
  await s.close();
});

test('POST /fg-roster/rpc: 400 on a non-whitelisted fn', async () => {
  const app = makeApp({ impl, token: 't', isReady: () => true, onRefresh: async () => {} });
  const s = await listen(app);
  const r = await post(s.port, '/fg-roster/rpc', { fn: 'startSync', args: [] }, { authorization: 'Bearer t' });
  assert.equal(r.status, 400);
  await s.close();
});

test('POST /fg-roster/rpc: 503 when the DB is not ready', async () => {
  const app = makeApp({ impl, token: 't', isReady: () => false, onRefresh: async () => {} });
  const s = await listen(app);
  const r = await post(s.port, '/fg-roster/rpc', { fn: 'getConnectionsStats', args: [] }, { authorization: 'Bearer t' });
  assert.equal(r.status, 503);
  await s.close();
});

test('POST /fg-roster/admin/refresh calls onRefresh (auth required)', async () => {
  let refreshed = false;
  const app = makeApp({ impl, token: 't', isReady: () => true, onRefresh: async () => { refreshed = true; } });
  const s = await listen(app);
  const noAuth = await post(s.port, '/fg-roster/admin/refresh', {});
  assert.equal(noAuth.status, 401);
  const ok = await post(s.port, '/fg-roster/admin/refresh', {}, { authorization: 'Bearer t' });
  assert.equal(ok.status, 200);
  assert.equal(refreshed, true);
  await s.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/fg-roster-app.test.js`
Expected: FAIL — `services/fg-roster/app.js` does not exist.

- [ ] **Step 3: Create `services/fg-roster/app.js`**

```js
// Thin HTTP surface for the central connections roster service. All roster math
// is the app's real src/connections/search-service.js, passed in as `impl` —
// this file only routes, authenticates, and guards readiness.
import express from 'express';
import { rpcDispatch } from '../../src/connections/db-client.js';

export function makeApp({ impl, token, isReady, onRefresh }) {
  const app = express();
  app.use(express.json({ limit: '4mb' })); // alreadyInvited / urls arrays can be large
  const router = express.Router();

  const auth = (req, res, next) => {
    if (req.get('authorization') === `Bearer ${token}`) return next();
    return res.status(401).json({ error: 'unauthorized' });
  };

  router.get('/health', (_req, res) => res.json({ ok: true }));

  router.post('/rpc', auth, (req, res) => {
    if (!isReady()) return res.status(503).json({ error: 'db not loaded' });
    const { fn, args } = req.body || {};
    try {
      res.json({ result: rpcDispatch(fn, args, impl) });
    } catch (err) {
      const bad = /^unknown roster fn:/.test(err.message);
      res.status(bad ? 400 : 500).json({ error: err.message });
    }
  });

  router.post('/admin/refresh', auth, async (_req, res) => {
    try { await onRefresh(); res.json({ ok: true }); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.use('/fg-roster', router);
  return app;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/fg-roster-app.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Create `services/fg-roster/pull-db.js`**

```js
// Download the connections DB (CSV folder + cache json) from GCS into the local
// dir the app's search-service reads. Uses Application Default Credentials
// (Workload Identity on GKE) — no key files. search-service auto-reloads on file
// mtime, so a re-pull is picked up by the next /rpc with no restart.
import fs from 'node:fs';
import path from 'node:path';
import { Storage } from '@google-cloud/storage';

const BUCKET = process.env.FG_ROSTER_BUCKET || 'ortus-fg-connections-db';

// Target layout under destDir (must match search-service DEFAULT_DIR/DEFAULT_CACHE):
//   destDir/connections/*.csv
//   destDir/connections-cache.json
export async function pullDb({ destDir, bucketName = BUCKET } = {}) {
  const storage = new Storage();
  const bucket = storage.bucket(bucketName);
  fs.mkdirSync(path.join(destDir, 'connections'), { recursive: true });
  const [files] = await bucket.getFiles();
  let n = 0;
  for (const file of files) {
    // Skip "directory placeholder" objects.
    if (file.name.endsWith('/')) continue;
    const dest = path.join(destDir, file.name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    await file.download({ destination: dest });
    n++;
  }
  console.log(`[fg-roster] pulled ${n} object(s) from gs://${bucketName} → ${destDir}`);
  return n;
}
```

- [ ] **Step 6: Create `services/fg-roster/server.js` (entry)**

```js
// Entry: pull the DB from GCS, point the app's search-service at it, then listen.
// The DB dir is set BEFORE importing search-service so its DEFAULT_DIR/DEFAULT_CACHE
// resolve to the pulled copy.
import path from 'node:path';
import os from 'node:os';
import { pullDb } from './pull-db.js';

const DEST = process.env.CONNECTIONS_DIR || path.join(os.tmpdir(), 'fg-connections');
process.env.CONNECTIONS_DB_DIR = DEST; // consumed by search-service path resolution (Step 7)

const { makeApp } = await import('./app.js');
const searchService = await import('../../src/connections/search-service.js');

let ready = false;
async function refresh() { await pullDb({ destDir: DEST }); ready = true; }

const TOKEN = process.env.FG_ROSTER_TOKEN || 'ortus2026scraper';
const PORT = Number(process.env.PORT || 8080);

const app = makeApp({ impl: searchService, token: TOKEN, isReady: () => ready, onRefresh: refresh });
app.listen(PORT, () => console.log(`[fg-roster] listening on :${PORT}`));

refresh().catch((e) => console.error('[fg-roster] initial DB pull failed (will 503 until /admin/refresh):', e.message));
```

- [ ] **Step 7: Make `search-service.js` honor `CONNECTIONS_DB_DIR`**

So the service reads the pulled copy without changing any caller. In `src/connections/search-service.js`, change the `DEFAULT_DIR` / `DEFAULT_CACHE` constants (lines ~16-17) to:

```js
const DB_DIR = process.env.CONNECTIONS_DB_DIR || path.join(REPO, 'data');
const DEFAULT_DIR = path.join(DB_DIR, 'connections');
const DEFAULT_CACHE = path.join(DB_DIR, 'connections-cache.json');
```

On Antonio's app `CONNECTIONS_DB_DIR` is unset → identical to today (`data/connections`, `data/connections-cache.json`). On the service it points at the pulled dir.

- [ ] **Step 8: Run all tests**

Run: `node --test tests/*.test.js`
Expected: PASS — including Task 1's `hasLocalDb` test (still uses an explicit `cachePath`, unaffected) and existing `search-service`-backed tests (env unset → same paths).

- [ ] **Step 9: Add `@google-cloud/storage` and commit**

```bash
npm install @google-cloud/storage
git add services/fg-roster/ src/connections/search-service.js tests/fg-roster-app.test.js package.json package-lock.json
git commit -m "feat(fg-roster): central roster service (makeApp + GCS pull + entry)"
```

---

### Task 5: Deploy artifacts + publish script + runbook

**Files:**
- Create: `services/fg-roster/Dockerfile`
- Create: `k8s/fg-roster/deployment.yaml`, `k8s/fg-roster/service.yaml`, `k8s/fg-roster/secret.example.yaml`
- Create: `scripts/publish-connections-db.sh`
- Create: `docs/superpowers/plans/2026-07-16-fg-roster-runbook.md` (deploy + ingress patch + publish steps)

This task produces no unit test (pure ops/config). Deliverable = artifacts that build; the `kubectl apply` is a gated manual step in the runbook.

- [ ] **Step 1: Dockerfile**

```dockerfile
# services/fg-roster/Dockerfile — built from the app repo root:
#   docker build -f services/fg-roster/Dockerfile -t <img> .
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY services ./services
ENV PORT=8080
EXPOSE 8080
CMD ["node", "services/fg-roster/server.js"]
```

- [ ] **Step 2: Deployment**

```yaml
# k8s/fg-roster/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: fg-roster
  namespace: salesnav-scraper
  labels: { app.kubernetes.io/name: fg-roster }
spec:
  replicas: 1                      # always-on; keeps the DB warm in RAM
  selector: { matchLabels: { app.kubernetes.io/name: fg-roster } }
  template:
    metadata:
      labels: { app.kubernetes.io/name: fg-roster }
    spec:
      serviceAccountName: fg-roster   # Workload-Identity-bound to a GSA with storage.objectViewer on the bucket
      containers:
        - name: fg-roster
          image: asia-southeast1-docker.pkg.dev/salesnav-scraper-prod/salesnav-images/fg-roster:v1
          ports: [{ name: http, containerPort: 8080 }]
          env:
            - { name: FG_ROSTER_BUCKET, value: ortus-fg-connections-db }
            - { name: CONNECTIONS_DIR, value: /data/fg-connections }
            - name: FG_ROSTER_TOKEN
              valueFrom: { secretKeyRef: { name: fg-roster, key: token } }
          volumeMounts: [{ name: db, mountPath: /data }]
          resources:
            requests: { cpu: "250m", memory: "1Gi" }   # tune from live: holds ~152MB cache + derived structures
            limits: { memory: "2Gi" }
          readinessProbe: { httpGet: { path: /fg-roster/health, port: http }, initialDelaySeconds: 5, periodSeconds: 10 }
          livenessProbe: { httpGet: { path: /fg-roster/health, port: http }, initialDelaySeconds: 10, periodSeconds: 20 }
      volumes: [{ name: db, emptyDir: {} }]
```

- [ ] **Step 3: Service**

```yaml
# k8s/fg-roster/service.yaml
apiVersion: v1
kind: Service
metadata:
  name: fg-roster
  namespace: salesnav-scraper
spec:
  type: ClusterIP
  selector: { app.kubernetes.io/name: fg-roster }
  ports: [{ name: http, port: 80, targetPort: http }]
```

- [ ] **Step 4: Secret example**

```yaml
# k8s/fg-roster/secret.example.yaml — copy to secret.yaml, fill, apply (never commit the real one)
apiVersion: v1
kind: Secret
metadata: { name: fg-roster, namespace: salesnav-scraper }
type: Opaque
stringData:
  token: "ortus2026scraper"
```

- [ ] **Step 5: Publish script**

```bash
#!/usr/bin/env bash
# scripts/publish-connections-db.sh — push the local connections DB to GCS, then
# tell the running service to reload. Run after each re-ingest (Connections → Sync).
set -euo pipefail
BUCKET="${FG_ROSTER_BUCKET:-ortus-fg-connections-db}"
URL="${FG_ROSTER_URL:-https://scraper.ortusclub.com/fg-roster}"
TOKEN="${FG_ROSTER_TOKEN:-ortus2026scraper}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

gsutil -m rsync -r -d "$ROOT/data/connections" "gs://$BUCKET/connections"
gsutil cp "$ROOT/data/connections-cache.json" "gs://$BUCKET/connections-cache.json"
curl -fsS -X POST -H "Authorization: Bearer $TOKEN" "$URL/admin/refresh" && echo " refreshed"
```

- [ ] **Step 6: Ingress patch snippet (in the runbook)**

The service is reached at `scraper.ortusclub.com/fg-roster` by adding a path rule to the **existing** engine Ingress (`ortus-salesnav-scraper-cloud/k8s/05-ingress.yaml`), BEFORE the `/` catch-all:

```yaml
          - path: /fg-roster
            pathType: Prefix
            backend: { service: { name: fg-roster, port: { number: 80 } } }
```

- [ ] **Step 7: Runbook** — write `docs/superpowers/plans/2026-07-16-fg-roster-runbook.md` capturing, in order: (1) create the GCS bucket + GSA + Workload Identity binding + KSA `fg-roster`; (2) first `publish-connections-db.sh` to populate the bucket; (3) `chmod +x scripts/publish-connections-db.sh`; (4) build+push image (`gcloud builds submit` or `docker build -f services/fg-roster/Dockerfile -t <img> . && docker push`); (5) `kubectl apply -f k8s/fg-roster/` (+ the real secret) — **PROD, requires explicit user approval**; (6) patch the engine ingress with the `/fg-roster` path and `kubectl apply` it — **PROD, requires approval**; (7) smoke test: `curl https://scraper.ortusclub.com/fg-roster/health`.

- [ ] **Step 8: Commit**

```bash
chmod +x scripts/publish-connections-db.sh
git add services/fg-roster/Dockerfile k8s/fg-roster/ scripts/publish-connections-db.sh docs/superpowers/plans/2026-07-16-fg-roster-runbook.md
git commit -m "chore(fg-roster): deploy artifacts, publish script, runbook"
```

- [ ] **Step 9: Verify the image builds**

Run: `docker build -f services/fg-roster/Dockerfile -t fg-roster:test .`
Expected: build succeeds. (If Docker isn't available in the environment, note it and defer to the deploy step.)

---

### Task 6: Remote-fallback smoke test (manual integration)

**Files:** none (verification only).

- [ ] **Step 1: Simulate a remote operator locally**

With the service running (locally or deployed) and `FG_ROSTER_URL` pointing at it, hide the local DB so `hasLocalDb()` is false:

```bash
mv data/connections-cache.json /tmp/cc.json.bak
pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "Electron.*ortus" 2>/dev/null
FG_ROSTER_URL=http://127.0.0.1:8080/fg-roster npm run dev:app > /tmp/dev-app.log 2>&1 &
sleep 8
```

- [ ] **Step 2: Confirm both features return non-empty via central**

```bash
curl -s 'http://localhost:PORT/api/fg/colleagues?roles=marketing' | head -c 200   # non-empty colleagues (from central)
curl -s -X POST 'http://localhost:PORT/api/connections/search' -H 'content-type: application/json' -d '{"jobTitles":["marketing"]}' | head -c 200
```
Expected: same non-empty shape as the local run in Task 3 Step 5 — proving the central path is 1:1.

- [ ] **Step 3: Confirm fail-closed**

Stop the service, repeat the `/api/fg/colleagues` curl. Expected: HTTP 500 with `{"error":...}` (NOT an empty `colleagues` array) — the picker shows "Couldn't load the team — try again."

- [ ] **Step 4: Restore the local DB**

```bash
mv /tmp/cc.json.bak data/connections-cache.json
```

---

## Rollout order

Tasks 1→5 are code/config (subagent-driven, TDD). Task 5 Step 7 runbook steps 5–6 (`kubectl apply` to prod) and the bucket/GSA setup are **manual, user-approved** steps executed after the branch is reviewed. Task 6 is the acceptance gate. App-side changes (Tasks 1–3) can merge and ship in a DMG independently — with the service not yet deployed, remote operators get the fail-closed "try again" (no regression vs. today's empty roster) until the service is live.
