# Primary Detection: Persistent Store + Deferrable Timing + Visible UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist each account's connection-to-primary across restarts (skip re-verifying confirmed-connected accounts; never false-flag "No Primary" on a rate-limited read), let operators defer the primary step to "after connections complete," and surface primary detection prominently (a dedicated live panel + a store-sourced row in the account picker).

**Architecture:** A new pure module `src/primary-status-store.js` owns the key scheme + trust/merge logic and a thin atomic-write disk layer (`data/primary-status.json`). `src/campaign.js` seeds its in-memory `_primaryConn` Map from the store at start and persists every definitive live read back; a new `primaryCheckTiming` setting chooses whether the existing `runPreflightHandshake()` closure runs before the worker loop (default, unchanged) or after it. The frontend reads stored status for the picker via a new `GET /api/primary-status` route, and renders a Variant-3 panel from the existing `/api/status` `primaryConn` payload.

**Tech Stack:** Node ≥22 (`node --test`, `node:assert/strict`), Express 4, vanilla-JS frontend (no bundler), atomic `.tmp`+`rename` JSON writes.

**Spec:** `docs/superpowers/specs/2026-06-18-primary-detection-store-design.md`
**Reference sketch (visual contract):** `public/sketches/primary-detection-variants.html`
**Off-limits (do NOT touch):** `src/linkedin/outreach.js`, `src/linkedin/actions.js`. Never `git add -A`; never stage `data/monitoring-campaign.json`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/primary-status-store.js` *(create)* | Pure: `primaryKeyFromUrl`, `storeKey`, `getEntry`, `shouldRecheck`, `mergeLiveRead`, `resolveDisplayState`, `seedConnectedIds`. Disk: `loadPrimaryStatus`, `savePrimaryStatus` (atomic). |
| `tests/primary-status-store.test.js` *(create)* | Unit tests for every pure function. |
| `src/campaign.js` *(modify)* | Seed `_primaryConn` from store at start; persist definitive reads; `primaryCheckTiming` defer logic; track `_primaryConnSource`. |
| `server.js` *(modify)* | Thread `primaryCheckTiming` through `buildCampaignConfig`; add `GET /api/primary-status`; expose `primaryConnSource` in status. |
| `public/index.html` *(modify)* | Timing dropdown control; live primary-panel container. |
| `public/js/app.js` *(modify)* | Read timing into start body; render Variant-3 panel; fetch + render picker primary rows. |
| `public/css/style.css` *(modify)* | `.prim` states, `.v3-*` panel, `.pick-primary` rows (verbatim from the sketch). |

**Execution note (preserve behavior):** Default `primaryCheckTiming` is `'immediately'`. With no `data/primary-status.json` present and timing at default, every code path below is a no-op relative to today's behavior. Verify this explicitly in Task 11.

---

## Task 1: Pure store module — key scheme + trust/merge logic

**Files:**
- Create: `src/primary-status-store.js`
- Test: `tests/primary-status-store.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/primary-status-store.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  primaryKeyFromUrl, storeKey, getEntry, shouldRecheck,
  mergeLiveRead, resolveDisplayState, seedConnectedIds,
} from '../src/primary-status-store.js';

test('primaryKeyFromUrl prefers vanity slug, lowercased', () => {
  assert.equal(primaryKeyFromUrl('https://www.linkedin.com/in/John-Smith/'), 's:john-smith');
  assert.equal(primaryKeyFromUrl('linkedin.com/in/john-smith?utm=x'), 's:john-smith');
});

test('primaryKeyFromUrl falls back to encoded member token when no vanity slug', () => {
  assert.equal(primaryKeyFromUrl('https://www.linkedin.com/in/ACwAABcd123_-/'), 'm:ACwAABcd123_-');
  assert.equal(primaryKeyFromUrl('https://www.linkedin.com/sales/lead/ACoAABcd999,NAME'), 'm:ACoAABcd999');
});

test('primaryKeyFromUrl returns empty for unusable input', () => {
  assert.equal(primaryKeyFromUrl(''), '');
  assert.equal(primaryKeyFromUrl(null), '');
  assert.equal(primaryKeyFromUrl('https://example.com/nope'), '');
});

test('storeKey joins profileId and primaryKey', () => {
  assert.equal(storeKey('prof1', 's:john-smith'), 'prof1|s:john-smith');
});

test('getEntry returns the entry or null', () => {
  const store = { 'prof1|s:john': { state: 'connected', degree: '1st', verifiedAt: 'T', primaryUrl: 'u' } };
  assert.deepEqual(getEntry(store, 'prof1', 's:john').state, 'connected');
  assert.equal(getEntry(store, 'prof1', 's:other'), null);
  assert.equal(getEntry({}, 'prof1', 's:john'), null);
});

test('shouldRecheck is false only for stored connected', () => {
  assert.equal(shouldRecheck({ state: 'connected' }), false);
  assert.equal(shouldRecheck({ state: 'pending' }), true);
  assert.equal(shouldRecheck({ state: 'unverified' }), true);
  assert.equal(shouldRecheck(null), true);
});

test('mergeLiveRead: connected is sticky — unverified does NOT demote it', () => {
  const prev = { state: 'connected', degree: '1st', verifiedAt: 'OLD', primaryUrl: 'u' };
  const next = mergeLiveRead(prev, 'unverified', 'NEW', 'u');
  assert.equal(next.state, 'connected');
  assert.equal(next.verifiedAt, 'OLD'); // unverified never re-stamps
});

test('mergeLiveRead: definitive connected/pending overwrites prior non-connected and stamps verifiedAt', () => {
  assert.equal(mergeLiveRead({ state: 'pending' }, 'connected', 'NEW', 'u').state, 'connected');
  assert.equal(mergeLiveRead({ state: 'unverified' }, 'pending', 'NEW', 'u').state, 'pending');
  assert.equal(mergeLiveRead(null, 'connected', 'NEW', 'u').verifiedAt, 'NEW');
});

test('mergeLiveRead: unverified over nothing stays unverified, no verifiedAt', () => {
  const next = mergeLiveRead(null, 'unverified', 'NEW', 'u');
  assert.equal(next.state, 'unverified');
  assert.equal(next.verifiedAt, null);
});

test('resolveDisplayState: live wins unless unverified-with-stored-connected (fallback)', () => {
  assert.deepEqual(
    resolveDisplayState({ state: 'connected' }, 'unverified'),
    { state: 'connected', source: 'remembered' });
  assert.deepEqual(
    resolveDisplayState({ state: 'connected' }, 'pending'),
    { state: 'pending', source: 'live' });
  assert.deepEqual(
    resolveDisplayState(null, 'unverified'),
    { state: 'unverified', source: 'live' });
});

test('seedConnectedIds returns the profileIds stored connected for a primaryKey', () => {
  const store = {
    'p1|s:john': { state: 'connected' },
    'p2|s:john': { state: 'pending' },
    'p3|s:other': { state: 'connected' },
    'p4|s:john': { state: 'connected' },
  };
  assert.deepEqual(seedConnectedIds(store, 's:john').sort(), ['p1', 'p4']);
  assert.deepEqual(seedConnectedIds(store, 's:none'), []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/primary-status-store.test.js`
Expected: FAIL — `Cannot find module '../src/primary-status-store.js'`.

- [ ] **Step 3: Write the pure module**

Create `src/primary-status-store.js` (pure functions only — no disk yet):

```javascript
// Persistent per-account connection-to-primary status.
// Key: `${profileId}|${primaryKey}`. primaryKey is derived from the configured
// primary URL (vanity slug, else encoded member token). A true numeric member#
// needs a live page read, so cross-URL-form identity is best-effort here — the
// same person entered once as a slug and once as an encoded URL keys differently.
// Status is remembered PER PRIMARY: "A is connected to X", not "A is connected".

export function primaryKeyFromUrl(url) {
  const s = String(url || '');
  const slug = s.match(/\/in\/([^/?#]+)/i);
  if (slug && !/^AC[ow]AA/i.test(slug[1])) return 's:' + slug[1].toLowerCase();
  const tok = s.match(/(AC[ow]AA[A-Za-z0-9_-]+)/);
  if (tok) return 'm:' + tok[1];
  return '';
}

export function storeKey(profileId, primaryKey) {
  return `${profileId}|${primaryKey}`;
}

export function getEntry(store, profileId, primaryKey) {
  if (!store || !primaryKey) return null;
  return store[storeKey(profileId, primaryKey)] || null;
}

export function shouldRecheck(entry) {
  return !(entry && entry.state === 'connected');
}

// liveState is one of 'connected' | 'pending' | 'unverified' (from primaryConnState).
// connected is sticky; a non-definitive 'unverified' never demotes or re-stamps.
export function mergeLiveRead(prev, liveState, nowIso, primaryUrl) {
  if (prev && prev.state === 'connected') return prev; // sticky
  if (liveState === 'unverified') {
    return prev || { state: 'unverified', degree: 'unknown', verifiedAt: null, primaryUrl: primaryUrl || '' };
  }
  return {
    state: liveState, // 'connected' | 'pending'
    degree: liveState === 'connected' ? '1st' : '2nd/3rd',
    verifiedAt: nowIso,
    primaryUrl: primaryUrl || (prev && prev.primaryUrl) || '',
  };
}

// What to SHOW: the live read wins, except a rate-limited 'unverified' on an
// account the store knows is connected → show connected (the false-flag fix).
export function resolveDisplayState(entry, liveState) {
  if (liveState === 'unverified' && entry && entry.state === 'connected') {
    return { state: 'connected', source: 'remembered' };
  }
  return { state: liveState, source: 'live' };
}

export function seedConnectedIds(store, primaryKey) {
  if (!store || !primaryKey) return [];
  const suffix = '|' + primaryKey;
  return Object.keys(store)
    .filter((k) => k.endsWith(suffix) && store[k] && store[k].state === 'connected')
    .map((k) => k.slice(0, -suffix.length));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/primary-status-store.test.js`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add src/primary-status-store.js tests/primary-status-store.test.js
git commit -m "feat: pure primary-status store (key scheme, sticky-connected merge, fallback)"
```

---

## Task 2: Store disk layer — atomic load/save

**Files:**
- Modify: `src/primary-status-store.js`
- Test: `tests/primary-status-store.test.js`

- [ ] **Step 1: Write the failing tests** (append to the test file)

```javascript
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPrimaryStatus, savePrimaryStatus } from '../src/primary-status-store.js';

test('savePrimaryStatus then loadPrimaryStatus round-trips', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pstore-'));
  const file = join(dir, 'primary-status.json');
  const data = { 'p1|s:john': { state: 'connected', degree: '1st', verifiedAt: 'T', primaryUrl: 'u' } };
  await savePrimaryStatus(file, data);
  assert.deepEqual(await loadPrimaryStatus(file), data);
  await rm(dir, { recursive: true, force: true });
});

test('loadPrimaryStatus returns {} for a missing file', async () => {
  assert.deepEqual(await loadPrimaryStatus(join(tmpdir(), 'nope-does-not-exist.json')), {});
});

test('loadPrimaryStatus returns {} for a corrupt file (never throws)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pstore-'));
  const file = join(dir, 'primary-status.json');
  await savePrimaryStatus(file, {});            // create
  await readFile(file);                          // exists
  const fsp = await import('node:fs/promises');
  await fsp.writeFile(file, '{ this is not json');
  assert.deepEqual(await loadPrimaryStatus(file), {});
  await rm(dir, { recursive: true, force: true });
});

test('savePrimaryStatus leaves no .tmp file behind', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pstore-'));
  const file = join(dir, 'primary-status.json');
  await savePrimaryStatus(file, { a: 1 });
  const fsp = await import('node:fs/promises');
  const entries = await fsp.readdir(dir);
  assert.deepEqual(entries, ['primary-status.json']);
  await rm(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/primary-status-store.test.js`
Expected: FAIL — `loadPrimaryStatus`/`savePrimaryStatus` are not exported.

- [ ] **Step 3: Add the disk layer** (append to `src/primary-status-store.js`)

Mirrors the `readBulkCheckCooldown`/`writeBulkCheckCooldown` shape (`campaign.js:260`) plus the atomic `.tmp`+`rename` used by `appendErrorLog` (`campaign.js:924`).

```javascript
import { readFile as _readFile, writeFile as _writeFile, rename as _rename } from 'node:fs/promises';

// Read-or-empty: a missing or corrupt store must never block a campaign.
export async function loadPrimaryStatus(file) {
  try { return JSON.parse(await _readFile(file, 'utf8')); }
  catch { return {}; }
}

// Atomic write: tmp + rename, so a crash mid-write can't corrupt the store.
export async function savePrimaryStatus(file, map) {
  try {
    const tmp = file + '.tmp';
    await _writeFile(tmp, JSON.stringify(map, null, 2));
    await _rename(tmp, file);
  } catch (err) {
    console.warn(`[primary-status] store write failed: ${err.message}`);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/primary-status-store.test.js`
Expected: PASS (15 tests).

- [ ] **Step 5: Commit**

```bash
git add src/primary-status-store.js tests/primary-status-store.test.js
git commit -m "feat: atomic disk layer for primary-status store (load-or-empty, tmp+rename)"
```

---

## Task 3: Campaign — load store + seed `_primaryConn` at start

**Files:**
- Modify: `src/campaign.js` (imports near top; constants near `:71-88`; start-of-run seeding before the worker loop, around `:4093`)

- [ ] **Step 1: Add the import and file constant**

Near the other `dataPath(...)` constants (`campaign.js:71-88`), add:

```javascript
const PRIMARY_STATUS_FILE = dataPath('primary-status.json');
```

At the top with the other `src/` imports, add:

```javascript
import {
  primaryKeyFromUrl, storeKey, getEntry, shouldRecheck,
  mergeLiveRead, resolveDisplayState, seedConnectedIds,
  loadPrimaryStatus, savePrimaryStatus,
} from './primary-status-store.js';
```

- [ ] **Step 2: Add a run-scoped store handle on the campaign object**

Where `_primaryConn: new Map()` is initialized (`campaign.js:670`), add two siblings:

```javascript
  _primaryConn: new Map(),
  _primaryConnSource: new Map(), // profileId -> 'remembered' | 'live'
  _primaryStore: null,           // loaded data/primary-status.json (object) for this run
  _primaryKey: '',               // primaryKeyFromUrl(primaryUrl) for this run
```

- [ ] **Step 3: Seed connected accounts from the store before the worker loop**

Immediately BEFORE the `try { await runPreflightHandshake(); }` line (`campaign.js:4187`), insert the seeding block. (`tpl` and `profileIds` are in scope here — see the preflight closure at `:4093-4097`.)

```javascript
    // #8: seed connection-to-primary from the persistent store so confirmed-
    // connected accounts skip re-verification this run (and survive restarts).
    {
      const _pUrl = (tpl && tpl.primaryUrl || '').trim();
      campaign._primaryKey = primaryKeyFromUrl(_pUrl);
      campaign._primaryStore = await loadPrimaryStatus(PRIMARY_STATUS_FILE);
      if (campaign._primaryKey) {
        const ids = seedConnectedIds(campaign._primaryStore, campaign._primaryKey);
        const run = new Set(profileIds || []);
        for (const pid of ids) {
          if (run.has(pid)) {
            campaign._primaryConn.set(pid, 'connected');
            campaign._primaryConnSource.set(pid, 'remembered');
          }
        }
        if (ids.length) log(`🧠 Remembered ${ids.filter((i) => run.has(i)).length} account(s) already connected to the primary — skipping their re-check.`);
      }
    }
```

- [ ] **Step 4: Verify the suite is still green**

Run: `node --test tests/*.test.js`
Expected: PASS (existing suite + the 15 store tests; no regressions). Seeding only fires when a store file exists and a primaryKey resolves; absent both, this is a no-op.

- [ ] **Step 5: Commit**

```bash
git add src/campaign.js
git commit -m "feat: seed _primaryConn from persistent store at campaign start (#8)"
```

---

## Task 4: Campaign — persist definitive reads + track source

**Files:**
- Modify: `src/campaign.js` (per-turn block `:2889`; preflight block `:4119`)

- [ ] **Step 1: Persist after the per-turn live read**

In the per-turn block, the current line (`campaign.js:2889`) is:

```javascript
                campaign._primaryConn.set(profileId, primaryConnState(_res.connected));
```

Replace it with a persist+source-tracking version (uses `resolveDisplayState` for the rate-limited fallback, `mergeLiveRead` for the sticky write):

```javascript
                {
                  const _live = primaryConnState(_res.connected); // 'connected'|'pending'|'unverified'
                  const _entry = campaign._primaryKey
                    ? getEntry(campaign._primaryStore, profileId, campaign._primaryKey) : null;
                  const _disp = resolveDisplayState(_entry, _live);
                  campaign._primaryConn.set(profileId, _disp.state);
                  campaign._primaryConnSource.set(profileId, _disp.source);
                  if (campaign._primaryKey && _live !== 'unverified') {
                    const _now = new Date().toISOString();
                    campaign._primaryStore = campaign._primaryStore || {};
                    campaign._primaryStore[storeKey(profileId, campaign._primaryKey)] =
                      mergeLiveRead(_entry, _live, _now, (tpl && tpl.primaryUrl) || '');
                    await savePrimaryStatus(PRIMARY_STATUS_FILE, campaign._primaryStore);
                  }
                }
```

- [ ] **Step 2: Persist after the preflight live read**

In `runPreflightHandshake`, the current line (`campaign.js:4119`) is:

```javascript
          campaign._primaryConn.set(profileId, primaryConnState(_res.connected));
```

Replace with the same persist pattern (`pName` is in scope; the auto-accept branch below still runs unchanged):

```javascript
          {
            const _live = primaryConnState(_res.connected);
            const _entry = campaign._primaryKey
              ? getEntry(campaign._primaryStore, profileId, campaign._primaryKey) : null;
            const _disp = resolveDisplayState(_entry, _live);
            campaign._primaryConn.set(profileId, _disp.state);
            campaign._primaryConnSource.set(profileId, _disp.source);
            if (campaign._primaryKey && _live !== 'unverified') {
              const _now = new Date().toISOString();
              campaign._primaryStore = campaign._primaryStore || {};
              campaign._primaryStore[storeKey(profileId, campaign._primaryKey)] =
                mergeLiveRead(_entry, _live, _now, primaryUrl || '');
              await savePrimaryStatus(PRIMARY_STATUS_FILE, campaign._primaryStore);
            }
          }
```

NOTE: the preflight later sets `'sent'`/`'accepting'`/`'connected'` for auto-accept (lines 4132, 4162-4165) — leave those unchanged. Only the `'accepting'→'connected'` accept-success path is a true connection; the existing per-turn re-check on the next run will persist it via Step 1 (a `'sent'` account re-reads to `'connected'` or `'pending'`). No extra write needed here.

- [ ] **Step 3: Run the suite**

Run: `node --test tests/*.test.js`
Expected: PASS. With no primaryKey (no primary configured) these blocks behave exactly as the single-line originals (`_primaryConn.set(...)` with `source='live'`, no disk write).

- [ ] **Step 4: Commit**

```bash
git add src/campaign.js
git commit -m "feat: persist definitive primary reads to store + track remembered/live source (#8)"
```

---

## Task 5: Campaign — `primaryCheckTiming` defer logic

**Files:**
- Modify: `src/campaign.js` (signature `:1641`; preflight call `:4187`; per-turn gate `:2870`; post-loop call after `:4192`)

- [ ] **Step 1: Add the setting to the `startCampaign` signature**

In the destructured params (`campaign.js:1641`), add `primaryCheckTiming = 'immediately'` alongside the other options:

```javascript
export async function startCampaign({ profileIds, benchedProfileIds = [], sheetUrl, templates, dailyLimit = 50, mode = 'connect_only', messageOpenProfiles = false, delayMin = 30, delayMax = 60, linkedinColumn = '', senderFirstNames = {}, concurrency = 1, name = '', acceptanceTrackingDays = 0, preflightCheckStatus = false, checkIntervalMinutes = 60, autoChecksEnabled = true, createdBy = null, senderColumn = '', allLeadsConnected = false, resumeContext = null, primaryCheckTiming = 'immediately' }) {
```

Just after the signature (top of the function body), derive the boolean once:

```javascript
  // #7: when 'after_connections', the primary connect/check is deferred until
  // all accounts finish sending connections — the pre-loop handshake and the
  // per-turn primary connect are skipped, and the same handshake runs post-loop.
  const _deferPrimary = primaryCheckTiming === 'after_connections';
```

- [ ] **Step 2: Gate the pre-loop preflight call**

The current line (`campaign.js:4187`) is:

```javascript
    try { await runPreflightHandshake(); } finally { campaign.phase = null; }
```

Replace with:

```javascript
    if (!_deferPrimary) { try { await runPreflightHandshake(); } finally { campaign.phase = null; } }
```

(The seeding block from Task 3 stays BEFORE this line so seeding happens in both timing modes.)

- [ ] **Step 3: Gate the per-turn primary block**

Wrap the per-turn primary section in a `if (!_deferPrimary)`. The block starts at `campaign.js:2870` (`const _primaryUrl = ...`) and ends at `:2926` (the close of the `else`). Change the opening so the whole primary check/connect is skipped while deferred:

```javascript
          if (!_deferPrimary) {
          const _primaryUrl = (tpl && tpl.primaryUrl || '').trim();
          // ... unchanged through line 2926 ...
          }
```

(Indentation of the inner lines may stay as-is; only the guard is added. The deferred mode does no primary work mid-loop — it all happens in the post-loop handshake.)

- [ ] **Step 4: Add the post-loop handshake for the deferred mode**

The worker loop completes at `campaign.js:4192` (`await Promise.all(...)`). Immediately AFTER that `await Promise.all(...)` line and BEFORE the monitoring-transition block (`:4242`), insert:

```javascript
    // #7: deferred primary step — all accounts have finished sending their
    // connections for the day; now run the same handshake (connect + accept)
    // before entering monitoring, restoring the pre-2102 "after connections" order.
    if (_deferPrimary && !campaign._abort) {
      campaign.phase = 'primary';
      try { await runPreflightHandshake(); } finally { campaign.phase = null; }
    }
```

- [ ] **Step 5: Run the suite**

Run: `node --test tests/*.test.js`
Expected: PASS. Default `primaryCheckTiming='immediately'` → `_deferPrimary=false` → every guard above is the original behavior (pre-loop handshake runs, per-turn block runs, post-loop block skipped).

- [ ] **Step 6: Commit**

```bash
git add src/campaign.js
git commit -m "feat: primaryCheckTiming — defer primary step to after connections complete (#7)"
```

---

## Task 6: Server — thread `primaryCheckTiming`

**Files:**
- Modify: `server.js` (`buildCampaignConfig` `:872-924`)

- [ ] **Step 1: Add the field to `buildCampaignConfig`**

In the destructure (`server.js:873-885`), add `primaryCheckTiming`. In the returned object (before the closing `}` of the `return {...}`, ~`:922`), add a validated coercion that only allows the two known values and defaults to `'immediately'`:

```javascript
    // #7: when the primary connect/check happens. 'immediately' (default) =
    // pre-loop handshake (today's behavior); 'after_connections' = after all
    // accounts finish sending connections. Any other value coerces to default.
    primaryCheckTiming: primaryCheckTiming === 'after_connections' ? 'after_connections' : 'immediately',
```

- [ ] **Step 2: Confirm it threads to `startCampaign`**

Verify the call site that spreads the config into `startCampaign` (search `startCampaign(` in `server.js`) passes the whole config object — it does (`buildCampaignConfig(body)` → `startCampaign(config)`), so no further change. Grep to confirm:

Run: `grep -n "startCampaign(" server.js`
Expected: a call spreading the built config (e.g. `startCampaign({ ...config, createdBy })` or similar) — `primaryCheckTiming` rides along.

- [ ] **Step 3: Run the suite**

Run: `node --test tests/*.test.js`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat: thread primaryCheckTiming through campaign config (#7)"
```

---

## Task 7: Server — `GET /api/primary-status` + expose source in status

**Files:**
- Modify: `server.js` (new route; near the other `/api/*` campaign routes); `src/campaign.js` (status payload `:4884`)

- [ ] **Step 1: Expose `primaryConnSource` in the status payload**

In `src/campaign.js`, find the status object that already includes `primaryConn` (`:4884`):

```javascript
    primaryConn: Object.fromEntries(campaign._primaryConn || []),
```

Add a sibling line right after it:

```javascript
    primaryConnSource: Object.fromEntries(campaign._primaryConnSource || []),
```

- [ ] **Step 2: Add the picker endpoint**

In `server.js`, near the other campaign `/api/*` routes, add a read-only route. It computes the primaryKey from the query and returns `{ profileId: { state, verifiedAt } }` for the matching primary (used by the picker before any campaign runs):

```javascript
// Picker (#8): stored connection-to-primary status for a given primary URL,
// so the wizard can show "remembered" status before a campaign starts.
app.get('/api/primary-status', async (req, res) => {
  try {
    const primaryUrl = String(req.query.primaryUrl || '');
    const key = primaryKeyFromUrl(primaryUrl);
    if (!key) return res.json({ key: '', statuses: {} });
    const store = await loadPrimaryStatus(dataPath('primary-status.json'));
    const suffix = '|' + key;
    const statuses = {};
    for (const k of Object.keys(store)) {
      if (k.endsWith(suffix)) {
        const pid = k.slice(0, -suffix.length);
        statuses[pid] = { state: store[k].state, verifiedAt: store[k].verifiedAt || null };
      }
    }
    res.json({ key, statuses });
  } catch (e) {
    res.json({ key: '', statuses: {} });
  }
});
```

Add the imports `server.js` needs at the top (if not already present): `primaryKeyFromUrl`, `loadPrimaryStatus` from `./src/primary-status-store.js`, and `dataPath` from `./src/paths.js` (grep first — `dataPath` may already be imported):

Run: `grep -n "from './src/paths.js'\|dataPath" server.js | head`
Then add only what's missing, e.g.:

```javascript
import { primaryKeyFromUrl, loadPrimaryStatus } from './src/primary-status-store.js';
```

- [ ] **Step 3: Smoke-test the route**

Run (server already on dev:app port 7847):
```bash
curl -s "http://localhost:7847/api/primary-status?primaryUrl=https://www.linkedin.com/in/test-person/" | head -c 200
```
Expected: JSON like `{"key":"s:test-person","statuses":{}}` (empty until a run populates the store). If auth blocks it, expect a 401/redirect — note it and verify in-app instead.

- [ ] **Step 4: Run the suite**

Run: `node --test tests/*.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server.js src/campaign.js
git commit -m "feat: /api/primary-status endpoint + expose primaryConnSource in status (#8)"
```

---

## Task 8: Frontend — the "Primary check timing" dropdown

**Files:**
- Modify: `public/index.html` (near the check-cadence control); `public/js/app.js` (start body `:3859`)

- [ ] **Step 1: Add the dropdown to the wizard**

In `public/index.html`, beside the existing `#check-cadence-select` control (the monitoring-cadence block shown for CC+IC / CC+DM), add:

```html
<div class="field" id="primary-timing-field" hidden>
  <label for="primary-timing-select">Primary check timing</label>
  <select id="primary-timing-select">
    <option value="immediately" selected>Immediately (at start)</option>
    <option value="after_connections">After connections complete</option>
  </select>
  <p class="field-hint">When the connect/check to the primary person runs. "After connections complete" starts sending right away and does the primary step once every account has finished its connection requests for the day.</p>
</div>
```

- [ ] **Step 2: Show the dropdown only for primary-using modes**

Find where `#check-cadence-select`'s container visibility is toggled (search `usesMonitoringCadence` in `app.js`). In that same show/hide path, mirror visibility for `#primary-timing-field` — but gate it on `connect_and_introduce` specifically (the only mode the preflight handshake honors, per `campaign.js:4095`):

```javascript
  const ptf = document.getElementById('primary-timing-field');
  if (ptf) ptf.hidden = (mode !== 'connect_and_introduce');
```

- [ ] **Step 3: Read the dropdown into the start body**

In the start-payload object (`app.js:3859`), add after the `autoChecksEnabled` field (~`:3909`):

```javascript
    // #7: when the primary connect/check happens. Only meaningful for CC+IC;
    // omitted otherwise so the server keeps its default.
    primaryCheckTiming: (mode === 'connect_and_introduce')
      ? (document.getElementById('primary-timing-select')?.value || 'immediately')
      : undefined,
```

- [ ] **Step 4: Manual verify**

Reload the app (Cmd+R). Select Connect+Introduce-Back mode → the "Primary check timing" dropdown appears; other modes → it's hidden. (No automated UI test — manual per repo convention.)

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/js/app.js
git commit -m "feat: Primary check timing dropdown (immediately / after connections) (#7)"
```

---

## Task 9: Frontend — Variant-3 live primary panel

**Files:**
- Modify: `public/index.html` (panel container near `#active-profiles`); `public/js/app.js` (`renderActiveProfiles` `:12580`); `public/css/style.css`

- [ ] **Step 1: Add the panel container**

In `public/index.html`, directly above the `#active-profiles` container (`:249`), add:

```html
<div id="primary-panel" hidden></div>
```

- [ ] **Step 2: Add the CSS** (append to `public/css/style.css`, verbatim from the sketch's shared + V3 blocks)

```css
/* Primary detection — shared loud states (#7/#8) */
.prim { font-family: var(--mono); font-weight: 600; white-space: nowrap; display: inline-flex; align-items: center; gap: 6px; }
.prim .dot { width: 7px; height: 7px; border-radius: 9999px; flex: none; }
.prim.connected { color: var(--green); } .prim.connected .dot { background: var(--green); }
.prim.pending   { color: #d97706; }      .prim.pending .dot   { background: #d97706; }
.prim.checking  { color: var(--blue); }  .prim.checking .dot  { background: var(--blue); animation: prim-pulse 1.1s ease-in-out infinite; }
.prim.unverified{ color: var(--gray); }  .prim.unverified .dot{ background: var(--gray); }
@keyframes prim-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.25; } }
.remember { font-family: var(--mono); font-size: 0.52rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--gray); border: 1px solid var(--hairline); border-radius: 9999px; padding: 1px 7px; }

/* Variant 3 — dedicated primary panel */
#primary-panel { border: 1px solid var(--card-border); background: var(--card-bg); border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; }
.v3-head { display: flex; align-items: center; gap: 12px; padding-bottom: 12px; border-bottom: 1px solid var(--hairline); margin-bottom: 4px; }
.v3-ava { width: 34px; height: 34px; border-radius: 9999px; flex: none; background: var(--gold-tint-bg); border: 1px solid var(--card-border); display: flex; align-items: center; justify-content: center; font-family: var(--display); font-size: 0.9rem; color: var(--ink); }
.v3-head .who { font-family: var(--mono); font-size: 0.78rem; color: var(--ink); }
.v3-head .who .lbl { color: var(--gray); text-transform: uppercase; letter-spacing: 0.12em; font-size: 0.52rem; display: block; margin-bottom: 2px; }
.v3-head .mode { margin-left: auto; font-family: var(--mono); font-size: 0.55rem; letter-spacing: 0.1em; text-transform: uppercase; color: var(--gray); border: 1px solid var(--hairline); border-radius: 9999px; padding: 4px 10px; }
.v3-item { display: grid; grid-template-columns: 14px minmax(0,1fr) auto; align-items: center; gap: 12px; padding: 9px 0; border-bottom: 1px solid var(--hairline-soft); font-family: var(--mono); }
.v3-item:last-child { border-bottom: none; }
.v3-item .led { width: 9px; height: 9px; border-radius: 9999px; }
.v3-item.s-connected .led { background: var(--green); } .v3-item.s-pending .led { background: #d97706; }
.v3-item.s-checking .led { background: var(--blue); animation: prim-pulse 1.1s ease-in-out infinite; } .v3-item.s-unverified .led { background: var(--gray); }
.v3-item .nm { font-size: 0.72rem; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.v3-item .meta { font-size: 0.55rem; color: var(--gray); letter-spacing: 0.04em; margin-top: 2px; }
.v3-item .st { font-size: 0.6rem; letter-spacing: 0.1em; text-transform: uppercase; font-weight: 600; text-align: right; }
.v3-item.s-connected .st { color: var(--green); } .v3-item.s-pending .st { color: #d97706; }
.v3-item.s-checking .st { color: var(--blue); } .v3-item.s-unverified .st { color: var(--gray); }
```

- [ ] **Step 3: Render the panel from status**

In `public/js/app.js`, add a `renderPrimaryPanel(status)` function and call it from inside `renderActiveProfiles` (or wherever `/api/status` is applied). It reads `status.primaryConn`, `status.primaryConnSource`, `status.primaryName`, and the chosen timing; hidden when no primary is in play:

```javascript
function renderPrimaryPanel(status) {
  const el = document.getElementById('primary-panel');
  if (!el) return;
  const conn = status && status.primaryConn ? status.primaryConn : null;
  const names = Array.isArray(status?.profileNames) ? status.profileNames : [];
  const ids   = Array.isArray(status?.profileIds)   ? status.profileIds   : [];
  if (!conn || !names.length || !Object.keys(conn).length) { el.hidden = true; el.innerHTML = ''; return; }
  const src = status.primaryConnSource || {};
  const pName = status.primaryName || 'the primary';
  const initials = pName.split(/\s+/).map(w => w[0] || '').join('').slice(0, 2).toUpperCase() || 'P';
  const STATE = {
    connected: { cls: 's-connected', st: 'Connected' },
    pending:   { cls: 's-pending',   st: 'Pending' },
    accepting: { cls: 's-checking',  st: 'Checking' },
    sent:      { cls: 's-pending',   st: 'Pending' },
    unverified:{ cls: 's-unverified',st: 'Primary?' },
    no_url:    { cls: 's-unverified',st: '—' },
  };
  const rows = names.map((name, i) => {
    const id = ids[i] || '';
    const state = (id && conn[id]) || 'unverified';
    const s = STATE[state] || STATE.unverified;
    const remembered = src[id] === 'remembered';
    const meta = remembered ? 'remembered · from store'
      : state === 'pending' || state === 'sent' ? 'connect request sent · awaiting accept'
      : state === 'unverified' ? 'degree unread · re-checks next turn'
      : 'verified live';
    return `<div class="v3-item ${s.cls}"><span class="led"></span>` +
      `<span><span class="nm" title="${escHtml(name)}">${escHtml(name)}</span>` +
      `<span class="meta">${escHtml(meta)}</span></span>` +
      `<span class="st">${escHtml(s.st)}${remembered ? ' <span class=\"remember\">remembered</span>' : ''}</span></div>`;
  }).join('');
  el.innerHTML =
    `<div class="v3-head"><div class="v3-ava">${escHtml(initials)}</div>` +
    `<div class="who"><span class="lbl">Primary person</span>${escHtml(pName)}</div></div>` +
    rows;
  el.hidden = false;
}
```

Add the call inside `renderActiveProfiles` (just before its final `el.hidden = false;`), or alongside it where status is applied:

```javascript
  renderPrimaryPanel(status);
```

- [ ] **Step 4: Manual verify**

Run a CC+IC campaign with a primary set. The panel renders above the account list with per-account LEDs/states; restart mid-run → previously-connected accounts show **Connected** with a `remembered` chip and are not re-read.

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/js/app.js public/css/style.css
git commit -m "feat: Variant-3 live primary detection panel (#7/#8)"
```

---

## Task 10: Frontend — store-sourced primary row in the picker

**Files:**
- Modify: `public/js/app.js` (`renderProfiles` `:947-961`; a fetch helper); `public/css/style.css`

- [ ] **Step 1: Add the picker CSS** (append to `public/css/style.css`, verbatim from the sketch)

```css
/* Picker primary row (#8) — store-sourced, shown only in primary modes */
.pick-primary { display: flex; align-items: center; gap: 7px; margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--hairline-soft); font-family: var(--mono); font-size: 0.6rem; letter-spacing: 0.08em; text-transform: uppercase; }
.pick-primary .dot { width: 7px; height: 7px; border-radius: 9999px; flex: none; }
.pick-primary.s-connected { color: var(--green); } .pick-primary.s-connected .dot { background: var(--green); }
.pick-primary.s-pending { color: #d97706; } .pick-primary.s-pending .dot { background: #d97706; }
.pick-primary.s-none { color: var(--gray); } .pick-primary.s-none .dot { background: var(--gray); opacity: 0.5; }
```

- [ ] **Step 2: Add a module-scoped cache + fetch**

Near the top of `app.js` (with other module state), add:

```javascript
let primaryStatusCache = { key: '', statuses: {} };
async function loadPrimaryStatusForPicker() {
  const url = (typeof currentTemplates === 'object' && currentTemplates && currentTemplates.primaryUrl) || '';
  if (mode !== 'connect_and_introduce' || !url) { primaryStatusCache = { key: '', statuses: {} }; return; }
  try {
    const r = await fetch('/api/primary-status?primaryUrl=' + encodeURIComponent(url));
    primaryStatusCache = await r.json();
  } catch { primaryStatusCache = { key: '', statuses: {} }; }
}
```

NOTE: confirm the variable names for the current mode and templates in `app.js` (search `let mode` / the templates object the wizard builds — it holds `primaryUrl`). Use the real names; the above assumes `mode` and `currentTemplates`. If the picker renders before a primary is chosen, the cache is empty and no rows show — correct.

- [ ] **Step 3: Call the fetch before rendering the picker, then render the row**

Where the picker is populated (the caller of `renderProfiles`, e.g. after profiles load / on mode change), `await loadPrimaryStatusForPicker()` before `renderProfiles(profiles)`.

In `renderProfiles`, after the `renderSoOBadges(soo)` line in the card template (`app.js:961`), add a primary row built from the cache (hidden when nothing applies):

```javascript
        ${(() => {
          if (mode !== 'connect_and_introduce' || !primaryStatusCache.key) return '';
          const e = primaryStatusCache.statuses[p.id];
          if (!e) return '<div class="pick-primary s-none"><span class="dot"></span>Primary — not checked yet</div>';
          if (e.state === 'connected') return '<div class="pick-primary s-connected"><span class="dot"></span>Primary ✓ <span class="remember">remembered</span></div>';
          if (e.state === 'pending')   return '<div class="pick-primary s-pending"><span class="dot"></span>Primary pending <span class="remember">remembered</span></div>';
          return '<div class="pick-primary s-none"><span class="dot"></span>Primary — not checked yet</div>';
        })()}
```

- [ ] **Step 4: Manual verify**

In CC+IC with a primary set, after at least one campaign has run: open the picker → accounts known connected show **Primary ✓ remembered**, pending ones **Primary pending**, the rest **not checked yet**. In non-CC+IC modes or with no primary set → no primary row. Composes with dup/restricted flags.

- [ ] **Step 5: Commit**

```bash
git add public/js/app.js public/css/style.css
git commit -m "feat: store-sourced primary status row in the account picker (#8)"
```

---

## Task 11: Final verification — behavior preservation + off-limits

**Files:** none (verification only)

- [ ] **Step 1: Full suite green**

Run: `node --test tests/*.test.js`
Expected: PASS, including the 15 store tests; zero regressions.

- [ ] **Step 2: Default-path no-op proof**

Confirm by reading the diffs that with `primaryCheckTiming='immediately'` and no `data/primary-status.json`:
- `_deferPrimary` is false → pre-loop preflight runs, per-turn block runs, post-loop block skipped (Task 5).
- Seeding (Task 3) sets nothing (empty store / empty key).
- Persist blocks (Task 4) with no `_primaryKey` set `source='live'` and write nothing.
Document this in the commit/PR notes.

- [ ] **Step 3: Off-limits untouched**

Run: `git diff --name-only $(git merge-base HEAD main)..HEAD | grep -E 'src/linkedin/(outreach|actions)\.js' && echo "VIOLATION" || echo "clean"`
Expected: `clean`.

- [ ] **Step 4: No runtime JSON staged**

Run: `git status --porcelain | grep 'data/monitoring-campaign.json' && echo "DO NOT COMMIT" || echo "clean"`
Expected: `clean`. (Also confirm `data/primary-status.json` is NOT staged — it's runtime state.)

- [ ] **Step 5: Manual end-to-end checklist (CC+IC, primary set)**

1. First run (empty store): accounts re-check once; panel shows live states; `data/primary-status.json` is written with connected entries.
2. Restart mid/after run: connected accounts seed as **Connected · remembered** and are NOT re-read (watch the log for the "Remembered N account(s)" line).
3. Rate-limit simulation / flaky read on a remembered account → shows **Connected** (not "No Primary").
4. Switch to a different primary → those accounts read "not checked yet" in the picker; switch back → remembered again.
5. Timing **After connections complete**: campaign starts sending immediately, no pre-loop primary work, handshake fires once all accounts finish their connections; **Immediately** path is unchanged.

- [ ] **Step 6: Version bump + relaunch** (per operator rules)

Patch-bump `package.json` `version`, then relaunch dev:app so the build is verifiable:

```bash
pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "Electron.*ortus" 2>/dev/null
npm run dev:app > /tmp/dev-app.log 2>&1 &
```

- [ ] **Step 7: Finish the branch**

Use **superpowers:finishing-a-development-branch** to verify tests, then present merge/PR options.

---

## Self-Review

**Spec coverage:** persistent store (Tasks 1-2) ✓; trust stored-connected/skip-recheck (Task 3 seeding + `shouldRecheck`) ✓; rate-limit fallback (Task 4 `resolveDisplayState`) ✓; sticky-connected (`mergeLiveRead`) ✓; per-primary keying + URL-form note (Task 1) ✓; read-at-pick-time (Task 7 endpoint + Task 10) ✓; #7 timing dropdown immediately/after-connections (Tasks 5/6/8) ✓; Variant-3 panel (Task 9) ✓; picker row (Task 10) ✓; preserves-existing-behavior (Task 11) ✓; primary-only / no CC changes (no CC files touched) ✓; off-limits untouched (Task 11 Step 3) ✓.

**Placeholder scan:** every code step has complete code; the two "confirm the real variable name" notes (Task 6 Step 2 grep, Task 10 Step 2) are verification steps with exact grep commands, not deferred work.

**Type/name consistency:** store fns (`primaryKeyFromUrl`, `storeKey`, `getEntry`, `shouldRecheck`, `mergeLiveRead`, `resolveDisplayState`, `seedConnectedIds`, `loadPrimaryStatus`, `savePrimaryStatus`) are used with identical signatures across Tasks 1-7; `primaryCheckTiming`/`_deferPrimary` consistent (Tasks 5-8); `primaryConn`/`primaryConnSource` consistent (Tasks 4/7/9); CSS classes (`.prim`, `.v3-item`, `.pick-primary`, `.remember`) match the sketch and are defined before use (Tasks 9-10).
