# FG Team Launch → Cloud VM Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the ☁︎ Cloud VM run-target is selected, the Follower Growth Team Launch button dispatches the batch to the cloud engine (parallel per account) with a durable proof trail and FG-sheet write-back that matches a local run 1:1.

**Architecture:** A server-side branch on the existing `/api/fg/team-launch/start` route (`target:'cloud'`) delegates to a new pure-ish module `src/connections/fg-cloud-launch.js`: build each pair's targets → flatten to an engine `leads[]` with `routeAccount` → `startCloudCampaign(follower_growth)` → queue to the FG sheet as proof-at-launch → persist a durable reconcile record → reconcile cloud results back to the FG sheet via a poller + app-startup hook. The local path is untouched. The engine already runs `follower_growth`; it gets a parity test and (deferrable) a per-account credit snapshot.

**Tech Stack:** Node ≥22, Express 4, vanilla JS ES modules (app); `node --test` for tests; engine is Node/CommonJS.

## Global Constraints

- Off-limits files: `src/linkedin/outreach.js`, `src/linkedin/actions.js` — never modify.
- The **local** Team Launch path (`runTeamLaunch` in `server.js:2379-2474`) stays exactly as-is.
- Engine repo (`/Users/antoniovarlese/Desktop/Projects/ortus-salesnav-scraper-cloud`) changes are committed **locally only** — no push, no image deploy.
- No app DMG published.
- `data/fg-cloud-runs.json` is runtime state — **never `git add`** it.
- Atomic JSON writes: write `<file>.tmp` then `fs.renameSync` to the real path.
- Engine config keys are exact: the engine reads `campaign.config.inviteUrl` and `campaign.config.monthlyBudget` (`campaign-runtime.js:233-234`). Dispatch must send `config: { inviteUrl, monthlyBudget }`.
- FG row column indices (from `src/connections/fg-export.js` `FG_HEADER`): `I_NAME=0`, `I_URL=1`, `I_MEMBER=2`, `I_COMPANY=3`, `I_TITLE=4`.
- After any commit that touches app runtime code (`server.js`, `public/js/app.js`): bump `package.json` version + both `public/index.html` `?v=` tags, then relaunch dev:app (`pkill -f "npm.*dev:app"; pkill -f "Electron.*ortus"; npm run dev:app > /tmp/dev-app.log 2>&1 &`).
- Invited detection from the engine: a lead is invited when `stage === 'Invited'` OR `status === 'sent'`.
- `routeAccount` is the GoLogin **profileId** (what the engine launches and returns as the lead's `account`).

## File Structure

**app (`ortus-gologin-clone`, branch `preflight-linter-2135`)**
- Create `src/connections/fg-cloud-launch.js` — pure functions (`buildCloudLeads`, `invitedWritebackFromLeads`, `reconcileCloudRun`, `startTeamLaunchCloud`) + `makeRunStore` durable JSON helper. All I/O injected as deps.
- Create `tests/fg-cloud-launch.test.js` — unit tests for the above.
- Modify `server.js` — `target:'cloud'` branch on `/api/fg/team-launch/start`; startup reconcile hook.
- Modify `public/js/app.js` — `fgtlLaunch()` reads run-target → `target`; cloud hand-off to `openCloudLive`; button copy.

**engine (`ortus-salesnav-scraper-cloud`) — committed locally only**
- Modify `test-campaign-followergrowth.js` — routed-claim isolation + `full_name`→queued mapping.
- (Deferrable) Modify `campaign-followergrowth.js` / `campaign-store.js` / `campaign-api.js` — per-account credit snapshot persistence + API exposure; wire into app reconcile.

---

### Task 1: `buildCloudLeads` — per-account targets → engine leads (pure)

**Files:**
- Create: `src/connections/fg-cloud-launch.js`
- Test: `tests/fg-cloud-launch.test.js`

**Interfaces:**
- Consumes: a `deps.buildTargets(pair)` callback returning `{ rows, count, reason }` where `rows` are FG_HEADER arrays (same contract as the local path's `buildTargets`, `server.js:2402`).
- Produces: `buildCloudLeads(pairs, ctx, deps) → { perAccount, leads }`.
  - `perAccount`: `[{ profileId, account, operator, month, rows, rowsByUrl, count, reason }]`
  - `leads`: `[{ leadUrl, fullName, memberUrn, routeAccount, row:{ memberId, name, company, title } }]`
  - Cross-account dedup: a contact (by memberId) is emitted at most once; the first pair in `pairs` order wins (mirrors the local sequential snapshot-refresh).

- [ ] **Step 1: Write the failing test**

```js
// tests/fg-cloud-launch.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCloudLeads } from '../src/connections/fg-cloud-launch.js';

// FG row: [Name, URL, MemberID, Company, Title, ...]
const row = (name, url, member, company = 'Acme', title = 'CMO') =>
  [name, url, member, company, title, '', '', '', '', '', '', '', ''];

test('buildCloudLeads flattens rows to engine leads with routeAccount + row_data', () => {
  const pairs = [{ profileId: 'p1', account: 'a@x.com', operator: 'op@x.com', operatorName: 'Op' }];
  const deps = {
    buildTargets: () => ({ rows: [row('Jane Doe', 'https://linkedin.com/in/jane', '111')], count: 1, reason: '' }),
  };
  const { perAccount, leads } = buildCloudLeads(pairs, { month: '2026-07' }, deps);
  assert.equal(leads.length, 1);
  assert.deepEqual(leads[0], {
    leadUrl: 'https://linkedin.com/in/jane',
    fullName: 'Jane Doe',
    memberUrn: null,
    routeAccount: 'p1',
    row: { memberId: '111', name: 'Jane Doe', company: 'Acme', title: 'CMO' },
  });
  assert.equal(perAccount[0].profileId, 'p1');
  assert.equal(perAccount[0].account, 'a@x.com');
  assert.equal(perAccount[0].operator, 'op@x.com');
  assert.equal(perAccount[0].month, '2026-07');
  assert.deepEqual(perAccount[0].rowsByUrl, { 'https://linkedin.com/in/jane': '111' });
});

test('buildCloudLeads drops rows with an empty URL', () => {
  const pairs = [{ profileId: 'p1', account: 'a', operator: 'o' }];
  const deps = { buildTargets: () => ({ rows: [['No URL', '', '222']], count: 1, reason: '' }) };
  const { leads } = buildCloudLeads(pairs, { month: '2026-07' }, deps);
  assert.equal(leads.length, 0);
});

test('buildCloudLeads dedups a contact across accounts — first pair wins', () => {
  const shared = row('Shared Person', 'https://linkedin.com/in/shared', '999');
  const pairs = [
    { profileId: 'p1', account: 'a1', operator: 'o1' },
    { profileId: 'p2', account: 'a2', operator: 'o2' },
  ];
  const deps = { buildTargets: (pair) => ({ rows: [shared], count: 1, reason: '' }) };
  const { leads } = buildCloudLeads(pairs, { month: '2026-07' }, deps);
  assert.equal(leads.length, 1);
  assert.equal(leads[0].routeAccount, 'p1');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/fg-cloud-launch.test.js`
Expected: FAIL — `buildCloudLeads` is not exported / module not found.

- [ ] **Step 3: Write minimal implementation**

```js
// src/connections/fg-cloud-launch.js
// Cloud dispatch + reconcile for the Follower Growth Team Launch flow.
// Pure functions; all I/O is injected via `deps` so this is unit-testable
// with no browser, no HTTP, no filesystem. Mirrors the local path's write-back
// semantics (server.js:2379-2474) against the FG sheet.

// FG row column indices — mirror src/connections/fg-export.js FG_HEADER.
const I_NAME = 0, I_URL = 1, I_MEMBER = 2, I_COMPANY = 3, I_TITLE = 4;

/**
 * Build each pair's targets and flatten to engine leads.
 * @param {Array} pairs  [{ profileId, account, operator, operatorName }]
 * @param {{month:string}} ctx
 * @param {{buildTargets:(pair)=>{rows:Array,count:number,reason:string}}} deps
 * @returns {{ perAccount:Array, leads:Array }}
 */
export function buildCloudLeads(pairs, ctx, deps) {
  const month = ctx && ctx.month;
  const perAccount = [];
  const leads = [];
  const seen = new Set(); // memberId already claimed by an earlier pair (cross-account dedup)
  for (const pair of pairs || []) {
    const built = deps.buildTargets(pair) || {};
    const rows = Array.isArray(built.rows) ? built.rows : [];
    const rowsByUrl = {};
    const keptRows = [];
    for (const r of rows) {
      const leadUrl = String(r[I_URL] || '').trim();
      if (!leadUrl) continue;
      const memberId = String(r[I_MEMBER] || '');
      if (memberId && seen.has(memberId)) continue;
      if (memberId) seen.add(memberId);
      rowsByUrl[leadUrl] = memberId;
      keptRows.push(r);
      leads.push({
        leadUrl,
        fullName: r[I_NAME],
        memberUrn: null,
        routeAccount: pair.profileId,
        row: { memberId, name: r[I_NAME], company: r[I_COMPANY], title: r[I_TITLE] },
      });
    }
    perAccount.push({
      profileId: pair.profileId,
      account: pair.account,
      operator: pair.operator,
      month,
      rows: keptRows,
      rowsByUrl,
      count: keptRows.length,
      reason: built.reason || '',
    });
  }
  return { perAccount, leads };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/fg-cloud-launch.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/connections/fg-cloud-launch.js tests/fg-cloud-launch.test.js
git commit -m "feat(fg-cloud): buildCloudLeads — FG targets → engine leads with routeAccount"
```

---

### Task 2: `invitedWritebackFromLeads` — cloud leads → per-account markFgInvited args (pure)

**Files:**
- Modify: `src/connections/fg-cloud-launch.js`
- Test: `tests/fg-cloud-launch.test.js`

**Interfaces:**
- Consumes: cloud leads `[{ leadUrl, account, stage, status }]` (from `getCloudCampaignLeads`, where `account` = the routed profileId) + a reconcile `record` with `perAccount:[{ profileId, account, operator, month, rowsByUrl }]`.
- Produces: `invitedWritebackFromLeads(cloudLeads, record) → [{ account, operator, month, memberIds:[…] }]` — one entry per account that had ≥1 invited lead; `memberIds` are LinkedIn Member IDs resolved via `rowsByUrl`.

- [ ] **Step 1: Write the failing test**

```js
// append to tests/fg-cloud-launch.test.js
import { invitedWritebackFromLeads } from '../src/connections/fg-cloud-launch.js';

const record = {
  perAccount: [
    { profileId: 'p1', account: 'a1@x.com', operator: 'o1@x.com', month: '2026-07',
      rowsByUrl: { 'https://linkedin.com/in/jane': '111', 'https://linkedin.com/in/joe': '112' } },
    { profileId: 'p2', account: 'a2@x.com', operator: 'o2@x.com', month: '2026-07',
      rowsByUrl: { 'https://linkedin.com/in/kim': '221' } },
  ],
};

test('invitedWritebackFromLeads groups invited leads by account, resolves memberIds', () => {
  const cloudLeads = [
    { leadUrl: 'https://linkedin.com/in/jane', account: 'p1', stage: 'Invited', status: 'sent' },
    { leadUrl: 'https://linkedin.com/in/joe', account: 'p1', stage: null, status: 'sent' },
    { leadUrl: 'https://linkedin.com/in/kim', account: 'p2', stage: 'Invited', status: 'sent' },
  ];
  const groups = invitedWritebackFromLeads(cloudLeads, record);
  const g1 = groups.find((g) => g.account === 'a1@x.com');
  const g2 = groups.find((g) => g.account === 'a2@x.com');
  assert.deepEqual(g1, { account: 'a1@x.com', operator: 'o1@x.com', month: '2026-07', memberIds: ['111', '112'] });
  assert.deepEqual(g2, { account: 'a2@x.com', operator: 'o2@x.com', month: '2026-07', memberIds: ['221'] });
});

test('invitedWritebackFromLeads ignores non-invited leads and unknown urls', () => {
  const cloudLeads = [
    { leadUrl: 'https://linkedin.com/in/jane', account: 'p1', stage: null, status: 'pending' }, // not invited
    { leadUrl: 'https://linkedin.com/in/ghost', account: 'p1', stage: 'Invited', status: 'sent' }, // url not in rowsByUrl
    { leadUrl: 'https://linkedin.com/in/kim', account: 'pX', stage: 'Invited', status: 'sent' }, // account not in record
  ];
  assert.deepEqual(invitedWritebackFromLeads(cloudLeads, record), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/fg-cloud-launch.test.js`
Expected: FAIL — `invitedWritebackFromLeads` is not exported.

- [ ] **Step 3: Write minimal implementation**

```js
// append to src/connections/fg-cloud-launch.js

function isInvited(lead) {
  return lead && (lead.stage === 'Invited' || lead.status === 'sent');
}

/**
 * Turn cloud per-lead rows into per-account markFgInvited arguments.
 * @param {Array} cloudLeads [{ leadUrl, account(=profileId), stage, status }]
 * @param {{perAccount:Array}} record
 * @returns {Array} [{ account, operator, month, memberIds:[…] }]
 */
export function invitedWritebackFromLeads(cloudLeads, record) {
  const byProfile = new Map((record && record.perAccount || []).map((a) => [String(a.profileId), a]));
  const idsByProfile = new Map(); // profileId → Set(memberId)
  for (const lead of cloudLeads || []) {
    if (!isInvited(lead)) continue;
    const meta = byProfile.get(String(lead.account));
    if (!meta) continue;
    const memberId = meta.rowsByUrl[String(lead.leadUrl || '').trim()];
    if (!memberId) continue;
    if (!idsByProfile.has(meta.profileId)) idsByProfile.set(meta.profileId, new Set());
    idsByProfile.get(meta.profileId).add(String(memberId));
  }
  return [...idsByProfile.entries()].map(([profileId, ids]) => {
    const meta = byProfile.get(String(profileId));
    return { account: meta.account, operator: meta.operator, month: meta.month, memberIds: [...ids] };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/fg-cloud-launch.test.js`
Expected: PASS (5 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/connections/fg-cloud-launch.js tests/fg-cloud-launch.test.js
git commit -m "feat(fg-cloud): invitedWritebackFromLeads — cloud leads → per-account memberIds"
```

---

### Task 3: `makeRunStore` — durable reconcile-record store (atomic JSON)

**Files:**
- Modify: `src/connections/fg-cloud-launch.js`
- Test: `tests/fg-cloud-launch.test.js`

**Interfaces:**
- Produces: `makeRunStore(filePath) → { load(), save(runs), add(run), update(cloudId, patch) }`.
  - `load()` returns `[]` if the file is missing/corrupt.
  - `save()` writes `<filePath>.tmp` then renames onto `filePath`.
  - `update(cloudId, patch)` merges `patch` into the matching record; returns `true`/`false`.

- [ ] **Step 1: Write the failing test**

```js
// append to tests/fg-cloud-launch.test.js
import { makeRunStore } from '../src/connections/fg-cloud-launch.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('makeRunStore add/load/update round-trips atomically', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fgrun-'));
  const file = join(dir, 'fg-cloud-runs.json');
  try {
    const store = makeRunStore(file);
    assert.deepEqual(store.load(), []); // missing file → []
    store.add({ cloudId: 'c1', status: 'dispatched' });
    store.add({ cloudId: 'c2', status: 'dispatched' });
    assert.equal(store.load().length, 2);
    assert.equal(store.update('c1', { status: 'reconciled' }), true);
    assert.equal(store.update('nope', { status: 'x' }), false);
    const c1 = store.load().find((r) => r.cloudId === 'c1');
    assert.equal(c1.status, 'reconciled');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/fg-cloud-launch.test.js`
Expected: FAIL — `makeRunStore` is not exported.

- [ ] **Step 3: Write minimal implementation**

```js
// append to src/connections/fg-cloud-launch.js
import fs from 'node:fs';

export function makeRunStore(filePath) {
  const load = () => {
    try { return JSON.parse(fs.readFileSync(filePath, 'utf8')) || []; }
    catch { return []; }
  };
  const save = (runs) => {
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(runs, null, 2));
    fs.renameSync(tmp, filePath);
  };
  return {
    load,
    save,
    add(run) { const runs = load(); runs.push(run); save(runs); },
    update(cloudId, patch) {
      const runs = load();
      const i = runs.findIndex((r) => r.cloudId === cloudId);
      if (i < 0) return false;
      runs[i] = { ...runs[i], ...patch };
      save(runs);
      return true;
    },
  };
}
```

Note: the `import fs from 'node:fs'` line belongs at the TOP of the file with the other imports — move it there rather than leaving it mid-file.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/fg-cloud-launch.test.js`
Expected: PASS (6 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/connections/fg-cloud-launch.js tests/fg-cloud-launch.test.js
git commit -m "feat(fg-cloud): makeRunStore — atomic durable reconcile-record store"
```

---

### Task 4: `reconcileCloudRun` — write cloud results back to the FG sheet (idempotent)

**Files:**
- Modify: `src/connections/fg-cloud-launch.js`
- Test: `tests/fg-cloud-launch.test.js`

**Interfaces:**
- Consumes: `invitedWritebackFromLeads` (Task 2); injected `deps`.
- Produces: `async reconcileCloudRun(record, deps) → { reconciled:boolean, ... }`.
  - `deps.getCampaign(cloudId) → { status }` (or `{ campaign:{ status } }`).
  - `deps.getLeads(cloudId) → { leads:[…] }`.
  - `deps.markInvited({ memberIds, account, operator, month })` — wraps `markFgInvited`.
  - `deps.log(msg)`.
  - Non-terminal campaign status → returns `{ reconciled:false }` without writing.
  - Terminal (`done|error|stopped|cancelled`) → per account `markInvited`; on write failure logs a loud `STRANDED` warning and returns `{ reconciled:false, stranded:true }` (no throw). Success → `{ reconciled:true, groups:N }`.
  - `observeFgCredits` is intentionally NOT called here — per-account credit numbers aren't exposed by the engine yet (see Task 9, deferrable); budget self-corrects from the FG-sheet `Sent` count in the meantime.

- [ ] **Step 1: Write the failing test**

```js
// append to tests/fg-cloud-launch.test.js
import { reconcileCloudRun } from '../src/connections/fg-cloud-launch.js';

const recordForReconcile = {
  cloudId: 'c1',
  perAccount: [
    { profileId: 'p1', account: 'a1@x.com', operator: 'o1@x.com', month: '2026-07',
      rowsByUrl: { 'https://linkedin.com/in/jane': '111' } },
  ],
};

test('reconcileCloudRun skips a non-terminal campaign without writing', async () => {
  const calls = [];
  const res = await reconcileCloudRun(recordForReconcile, {
    getCampaign: async () => ({ status: 'running' }),
    getLeads: async () => { calls.push('getLeads'); return { leads: [] }; },
    markInvited: async () => calls.push('markInvited'),
    log: () => {},
  });
  assert.deepEqual(res, { reconciled: false, status: 'running' });
  assert.deepEqual(calls, []); // never fetched leads or wrote
});

test('reconcileCloudRun writes invited memberIds back on a terminal campaign', async () => {
  const marks = [];
  const res = await reconcileCloudRun(recordForReconcile, {
    getCampaign: async () => ({ status: 'done' }),
    getLeads: async () => ({ leads: [{ leadUrl: 'https://linkedin.com/in/jane', account: 'p1', stage: 'Invited', status: 'sent' }] }),
    markInvited: async (args) => marks.push(args),
    log: () => {},
  });
  assert.equal(res.reconciled, true);
  assert.deepEqual(marks, [{ memberIds: ['111'], account: 'a1@x.com', operator: 'o1@x.com', month: '2026-07' }]);
});

test('reconcileCloudRun on markInvited failure logs STRANDED and does not throw', async () => {
  const logs = [];
  const res = await reconcileCloudRun(recordForReconcile, {
    getCampaign: async () => ({ status: 'done' }),
    getLeads: async () => ({ leads: [{ leadUrl: 'https://linkedin.com/in/jane', account: 'p1', stage: 'Invited', status: 'sent' }] }),
    markInvited: async () => { throw new Error('sheet 503'); },
    log: (m) => logs.push(m),
  });
  assert.equal(res.reconciled, false);
  assert.equal(res.stranded, true);
  assert.match(logs.join('\n'), /STRANDED/);
});

test('reconcileCloudRun is a no-op when already reconciled', async () => {
  const res = await reconcileCloudRun({ ...recordForReconcile, status: 'reconciled' }, {
    getCampaign: async () => { throw new Error('should not be called'); },
    getLeads: async () => { throw new Error('should not be called'); },
    markInvited: async () => { throw new Error('should not be called'); },
    log: () => {},
  });
  assert.equal(res.reconciled, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/fg-cloud-launch.test.js`
Expected: FAIL — `reconcileCloudRun` is not exported.

- [ ] **Step 3: Write minimal implementation**

```js
// append to src/connections/fg-cloud-launch.js
const TERMINAL_STATUS = new Set(['done', 'error', 'stopped', 'cancelled']);

export async function reconcileCloudRun(record, deps) {
  if (record && record.status === 'reconciled') return { reconciled: true };
  const camp = await deps.getCampaign(record.cloudId);
  const status = camp && (camp.status || (camp.campaign && camp.campaign.status));
  if (!status || !TERMINAL_STATUS.has(status)) return { reconciled: false, status: status || 'unknown' };

  const res = await deps.getLeads(record.cloudId);
  const leads = (res && res.leads) || [];
  const groups = invitedWritebackFromLeads(leads, record);
  for (const g of groups) {
    try {
      await deps.markInvited({ memberIds: g.memberIds, account: g.account, operator: g.operator, month: g.month });
    } catch (e) {
      deps.log(`⚠ STRANDED: ${g.memberIds.length} invite(s) WERE sent for ${g.account} but the FG-sheet write-back failed — they will be re-checked next reconcile (${e.message})`);
      return { reconciled: false, stranded: true };
    }
  }
  return { reconciled: true, groups: groups.length };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/fg-cloud-launch.test.js`
Expected: PASS (10 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/connections/fg-cloud-launch.js tests/fg-cloud-launch.test.js
git commit -m "feat(fg-cloud): reconcileCloudRun — idempotent FG-sheet write-back with STRANDED guard"
```

---

### Task 5: `startTeamLaunchCloud` — dispatch orchestration (deps-injected)

**Files:**
- Modify: `src/connections/fg-cloud-launch.js`
- Test: `tests/fg-cloud-launch.test.js`

**Interfaces:**
- Consumes: `buildCloudLeads` (Task 1); injected `deps`.
- Produces: `async startTeamLaunchCloud(pairs, deps) → { cloudId } | { error }`.
  - `deps.buildTargets(pair)`, `deps.startCloud(payload) → { id }|{ error }`, `deps.queueInvites(rows)`, `deps.runStore` (Task 3 shape), `deps.now() → isoString`, `deps.log(msg)`, and values `deps.month`, `deps.owner`, `deps.name`, `deps.inviteUrl`, `deps.monthlyBudget`.
  - No eligible targets → `{ error }`, no dispatch, no sheet write.
  - Dispatch error → `{ error }`, no sheet write, no record.
  - Success → `queueInvites(allRows)` (best-effort; failure logged, not fatal), `runStore.add(record)`, returns `{ cloudId }`.

- [ ] **Step 1: Write the failing test**

```js
// append to tests/fg-cloud-launch.test.js
import { startTeamLaunchCloud } from '../src/connections/fg-cloud-launch.js';

const onePair = [{ profileId: 'p1', account: 'a1@x.com', operator: 'o1@x.com', operatorName: 'Op1' }];
const oneTarget = () => ({ rows: [['Jane Doe', 'https://linkedin.com/in/jane', '111', 'Acme', 'CMO', '', '', '', '', '', '', '', '']], count: 1, reason: '' });

function fakeStore() {
  const runs = [];
  return { add: (r) => runs.push(r), load: () => runs, save: () => {}, update: () => true, _runs: runs };
}

test('startTeamLaunchCloud dispatches, queues proof, persists record', async () => {
  const store = fakeStore();
  const queued = [];
  const res = await startTeamLaunchCloud(onePair, {
    buildTargets: oneTarget,
    startCloud: async (p) => { assert.equal(p.mode, 'follower_growth'); assert.deepEqual(p.config, { inviteUrl: 'https://linkedin.com/company/ortus/invite', monthlyBudget: 30 }); assert.equal(p.leads.length, 1); assert.deepEqual(p.profileIds, ['p1']); return { id: 'cloud-1' }; },
    queueInvites: async (rows) => { queued.push(...rows); },
    runStore: store, now: () => '2026-07-15T00:00:00Z', log: () => {},
    month: '2026-07', owner: 'o1@x.com', name: 'Team FG', inviteUrl: 'https://linkedin.com/company/ortus/invite', monthlyBudget: 30,
  });
  assert.deepEqual(res, { cloudId: 'cloud-1' });
  assert.equal(queued.length, 1);
  assert.equal(store._runs.length, 1);
  assert.equal(store._runs[0].cloudId, 'cloud-1');
  assert.equal(store._runs[0].status, 'dispatched');
  assert.deepEqual(store._runs[0].perAccount[0].rowsByUrl, { 'https://linkedin.com/in/jane': '111' });
});

test('startTeamLaunchCloud returns error and does NOT queue when there are no targets', async () => {
  const store = fakeStore();
  let queuedCalled = false;
  const res = await startTeamLaunchCloud(onePair, {
    buildTargets: () => ({ rows: [], count: 0, reason: 'all already invited' }),
    startCloud: async () => { throw new Error('should not dispatch'); },
    queueInvites: async () => { queuedCalled = true; },
    runStore: store, now: () => 'now', log: () => {},
    month: '2026-07', owner: 'o', inviteUrl: 'u', monthlyBudget: 30,
  });
  assert.ok(res.error);
  assert.equal(queuedCalled, false);
  assert.equal(store._runs.length, 0);
});

test('startTeamLaunchCloud returns error and does NOT queue when dispatch fails', async () => {
  const store = fakeStore();
  let queuedCalled = false;
  const res = await startTeamLaunchCloud(onePair, {
    buildTargets: oneTarget,
    startCloud: async () => ({ error: 'engine unreachable' }),
    queueInvites: async () => { queuedCalled = true; },
    runStore: store, now: () => 'now', log: () => {},
    month: '2026-07', owner: 'o', inviteUrl: 'u', monthlyBudget: 30,
  });
  assert.equal(res.error, 'engine unreachable');
  assert.equal(queuedCalled, false);
  assert.equal(store._runs.length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/fg-cloud-launch.test.js`
Expected: FAIL — `startTeamLaunchCloud` is not exported.

- [ ] **Step 3: Write minimal implementation**

```js
// append to src/connections/fg-cloud-launch.js
export async function startTeamLaunchCloud(pairs, deps) {
  const { perAccount, leads } = buildCloudLeads(pairs, { month: deps.month }, { buildTargets: deps.buildTargets });
  if (!leads.length) {
    const reason = (perAccount.find((a) => a.reason) || {}).reason || 'no eligible targets';
    return { error: `No invites to send — ${reason}.` };
  }
  const resp = await deps.startCloud({
    mode: 'follower_growth',
    name: deps.name || `Team Follower Growth · ${deps.month}`,
    owner: deps.owner || '',
    profileIds: [...new Set(pairs.map((p) => p.profileId))],
    leads,
    config: { inviteUrl: deps.inviteUrl, monthlyBudget: deps.monthlyBudget },
  });
  if (!resp || resp.error || !resp.id) return { error: (resp && resp.error) || 'Cloud dispatch failed.' };
  const cloudId = resp.id;

  // Proof-at-launch — ONLY after a successful dispatch, so a failed dispatch
  // never strands Queued rows. Best-effort: a sheet hiccup must not fail the run.
  const allRows = perAccount.flatMap((a) => a.rows);
  try { if (allRows.length) await deps.queueInvites(allRows); }
  catch (e) { deps.log(`⚠ FG-sheet Queue write failed at launch (${e.message}) — invites still dispatched; reconcile will still flip Invited.`); }

  deps.runStore.add({
    cloudId,
    month: deps.month,
    dispatchedAt: deps.now(),
    status: 'dispatched',
    perAccount: perAccount.map((a) => ({
      profileId: a.profileId, account: a.account, operator: a.operator, month: deps.month, rowsByUrl: a.rowsByUrl,
    })),
  });
  return { cloudId };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/fg-cloud-launch.test.js`
Expected: PASS (13 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/connections/fg-cloud-launch.js tests/fg-cloud-launch.test.js
git commit -m "feat(fg-cloud): startTeamLaunchCloud — build, dispatch, proof-at-launch, persist"
```

---

### Task 6: Wire the server route branch + startup reconcile hook

**Files:**
- Modify: `server.js` (route `/api/fg/team-launch/start` at `2379`; add module imports near `2092`/`2093`; add a startup hook near the other bootstrap calls at the bottom of the file)
- Modify: `package.json` (version bump), `public/index.html` (`?v=` bump ×3)

**Interfaces:**
- Consumes: `startTeamLaunchCloud`, `makeRunStore`, `reconcileCloudRun` (Tasks 3–5); existing server imports `buildFgTargets`, `fgCriteria`, `fgRemaining`, `getFgState`, `queueFgInvites`, `markFgInvited`, `ORTUS_PAGE_INVITE_URL`, `FG_DEFAULT_MONTHLY_ALLOWANCE`, `getOperatorEmail`; cloud client `startCloudCampaign`, `getCloudCampaign`, `getCloudCampaignLeads`.
- Produces: `POST /api/fg/team-launch/start` with `body.target === 'cloud'` dispatches to the cloud and returns `{ started:true, cloudId }`. Startup reconciles any `status:'dispatched'` records.

This task is integration glue (HTTP + real FG-sheet/engine I/O); it is verified by `node --check` + manual run, not a new unit test — the logic it wires was unit-tested in Tasks 1–5.

- [ ] **Step 1: Add imports**

Near the existing FG imports (`server.js:92-97`), add:

```js
import { startTeamLaunchCloud, makeRunStore, reconcileCloudRun } from './src/connections/fg-cloud-launch.js';
import { startCloudCampaign, getCloudCampaign, getCloudCampaignLeads } from './src/campaigns-client.js';
```

Confirm `buildFgTargets`, `fgCriteria`, `fgRemaining` are already imported (they are — used by the local path at `server.js:2402-2415`). Confirm `getCloudCampaign`/`getCloudCampaignLeads` aren't already imported from `campaigns-client.js` elsewhere; if a partial import exists, merge names into it rather than adding a duplicate import line.

- [ ] **Step 2: Add the run-store singleton + a reconcile-all helper**

After the imports / near the other module-level state (e.g. just below the `_fgTeam` state declarations used by the local path), add:

```js
// Durable cloud-FG reconcile records. NEVER git-add data/fg-cloud-runs.json.
const _fgCloudRunStore = makeRunStore(path.join(process.cwd(), 'data', 'fg-cloud-runs.json'));

// Reconcile every dispatched cloud-FG run: pull engine results and write invited
// members back to the FG sheet. Runs on a timer while the app is open AND once at
// startup (so a run that finished while the laptop was closed is written back).
async function reconcileFgCloudRuns() {
  const deps = {
    getCampaign: (id) => getCloudCampaign(id),
    getLeads: (id) => getCloudCampaignLeads(id),
    markInvited: (args) => markFgInvited(args),
    log: (m) => { try { campaignLog(`[FG-cloud] ${m}`); } catch (_) {} },
  };
  for (const record of _fgCloudRunStore.load()) {
    if (record.status === 'reconciled') continue;
    try {
      const out = await reconcileCloudRun(record, deps);
      if (out.reconciled) _fgCloudRunStore.update(record.cloudId, { status: 'reconciled' });
    } catch (e) {
      try { campaignLog(`[FG-cloud] reconcile ${record.cloudId} failed: ${e.message}`); } catch (_) {}
    }
  }
}
```

(`path` and `campaignLog` are already imported/defined in `server.js`.)

- [ ] **Step 3: Add the `target:'cloud'` branch at the top of the route**

Immediately after `const pairs = ...` / validation in the `/api/fg/team-launch/start` handler (after `server.js:2383`, before `res.json({ started: true })` at `2386`), insert:

```js
  if ((b.target || 'local') === 'cloud') {
    const month = b.month || fgMonth();
    const keywords = Array.isArray(b.keywords) ? b.keywords : [];
    let snap;
    try { snap = await getFgState(); } catch (e) { return res.status(502).json({ error: `Could not read FG sheet: ${e.message}` }); }
    const buildTargets = (pair) => {
      const alreadyInvited = (snap.invites || []).map((r) => String(r['Member ID'] || '') || (r['LinkedIn URL'] || ''));
      const budget = fgRemaining(snap.budgets, pair.account, month);
      const out = buildFgTargets(fgCriteria({ jobTitles: keywords }), { operator: pair.operator, operatorName: pair.operatorName, account: pair.account, month, alreadyInvited, budget });
      let reason = '';
      if (!out.count) {
        if (out.matched === 0) reason = 'no connections match these roles';
        else if (out.eligible === 0) reason = 'all matching connections already invited';
        else reason = 'monthly budget used up — no invites remaining this month';
      }
      return { rows: out.rows, count: out.count, reason };
    };
    const result = await startTeamLaunchCloud(pairs, {
      buildTargets,
      startCloud: (payload) => startCloudCampaign(payload),
      queueInvites: (rows) => queueFgInvites(rows),
      runStore: _fgCloudRunStore,
      now: () => new Date().toISOString(),
      log: (m) => { try { campaignLog(`[FG-cloud] ${m}`); } catch (_) {} },
      month, owner: getOperatorEmail() || req.user || '',
      name: `Team Follower Growth · ${month}`,
      inviteUrl: ORTUS_PAGE_INVITE_URL, monthlyBudget: FG_DEFAULT_MONTHLY_ALLOWANCE,
    });
    if (result.error) return res.status(502).json({ error: result.error });
    reconcileFgCloudRuns().catch(() => {}); // kick a first poll shortly (non-blocking)
    return res.json({ started: true, cloudId: result.cloudId });
  }
```

Note: the local path below this branch is unchanged. The cloud branch returns early, so `_fgTeam` local state is never touched for a cloud launch.

- [ ] **Step 4: Add the poller + startup reconcile**

Where the app wires other background timers at boot (search `setInterval(` near the scheduler bootstrap), add:

```js
// Cloud-FG write-back: reconcile on boot, then every 30s while the app is open.
reconcileFgCloudRuns().catch(() => {});
setInterval(() => { reconcileFgCloudRuns().catch(() => {}); }, 30_000);
```

- [ ] **Step 5: Syntax-check + bump version + relaunch**

```bash
node --check server.js
```
Expected: no output (valid).

Bump `package.json` `"version"` (patch) and the three `?v=` query strings in `public/index.html` to match. Then:

```bash
pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "Electron.*ortus" 2>/dev/null
npm run dev:app > /tmp/dev-app.log 2>&1 &
```

- [ ] **Step 6: Commit**

```bash
git add server.js package.json public/index.html
git commit -m "feat(fg-cloud): server route target:'cloud' branch + reconcile poller/startup hook"
```

---

### Task 7: Client — Team Launch button honors the run-target + cloud hand-off

**Files:**
- Modify: `public/js/app.js` (`fgtlLaunch` at `17632-17667`; button-copy helper wherever `fgtl-go` label is set)
- Modify: `package.json` (version bump), `public/index.html` (`?v=` bump ×3)

**Interfaces:**
- Consumes: `getRunTarget()` (`app.js:5847`), `openCloudLive(id)` (existing), the cloud response `{ started:true, cloudId }`.
- Produces: under Cloud VM, `fgtlLaunch` POSTs `target:'cloud'` and hands off to `openCloudLive`; under This machine, behavior is unchanged.

UI change — verified manually (Chrome MCP / `npm run dev:app`), no unit test.

- [ ] **Step 1: Modify `fgtlLaunch` to send the target + branch on cloud**

Replace the body of `fgtlLaunch` (`app.js:17633-17667`) with:

```js
async function fgtlLaunch() {
  const pairs = fgtlPairs();
  if (!pairs.length) return;
  const isCloud = (typeof getRunTarget === 'function' && getRunTarget() === 'cloud');
  const goBtn = document.getElementById('fgtl-go');
  if (goBtn) goBtn.disabled = true;
  let res;
  try {
    res = await fetch('/api/fg/team-launch/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        keywords: fgtlChips,
        pairs,
        month: new Date().toISOString().slice(0, 7),
        target: isCloud ? 'cloud' : 'local',
      }),
    });
  } catch (err) {
    alert('Launch failed: ' + (err && err.message ? err.message : String(err)));
    if (goBtn) goBtn.disabled = false;
    return;
  }
  if (!res.ok) {
    let errMsg = 'Launch failed';
    try { const body = await res.json(); errMsg = body.error || errMsg; } catch (_) {}
    alert(errMsg);
    if (goBtn) goBtn.disabled = false;
    return;
  }
  // Cloud launch: the batch runs on the VM — hand off to the live cloud card
  // (card #2) instead of polling the local team-launch status.
  if (isCloud) {
    let data = {};
    try { data = await res.json(); } catch (_) {}
    if (typeof showCampaignToast === 'function') showCampaignToast('☁︎ Cloud Follower Growth dispatched — it keeps running on the VM even if you close the app.', 6000);
    if (data.cloudId && typeof openCloudLive === 'function') { try { await openCloudLive(data.cloudId); } catch (_) {} }
    if (goBtn) goBtn.disabled = false;
    return;
  }
  const stopBtn = document.getElementById('fgtl-stop');
  if (goBtn) goBtn.style.display = 'none';
  if (stopBtn) { stopBtn.style.display = ''; stopBtn.textContent = 'Stop now'; stopBtn.disabled = false; }
  const cardStop = document.getElementById('fgtl-card-stop');
  if (cardStop) { cardStop.style.display = ''; cardStop.textContent = 'Stop now'; cardStop.disabled = false; }
  fgtlPoll();
}
```

- [ ] **Step 2: Make the button copy reflect the target**

Find where the `#fgtl-go` label text is set when the launch list renders (search `fgtl-go` in `app.js`; the label reads e.g. `Launch N sequentially`). Where that count label is composed, branch on the run-target so the button reads **`Launch N in cloud`** when `getRunTarget() === 'cloud'`, else keep the existing `Launch N sequentially`. Example, at the label-composition site:

```js
const _fgCloud = (typeof getRunTarget === 'function' && getRunTarget() === 'cloud');
goBtn.textContent = _fgCloud ? `Launch ${n} in cloud` : `Launch ${n} sequentially`;
```

Also ensure `refreshRunTarget()` re-renders the FG launch list so the copy updates when the operator flips the tab: confirm the FG launch-list render runs on tab switch (it already calls `renderModeSelector`/`refreshCloudToggle`); if the button label is cached, call the FG list re-render from the FG path too.

- [ ] **Step 3: Verify manually**

```bash
node --check public/js/app.js
```
Expected: no output. Then bump `package.json` version + `public/index.html` `?v=` ×3, relaunch dev:app, and in the app: select Follower Growth → flip **☁︎ Cloud VM** → confirm the button reads "Launch N in cloud" → launch → confirm the cloud card (card #2) opens and a cloud campaign appears on the board. Flip back to **💻 This machine** → confirm the button reads "Launch N sequentially" and a local run still works.

```bash
pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "Electron.*ortus" 2>/dev/null
npm run dev:app > /tmp/dev-app.log 2>&1 &
```

- [ ] **Step 4: Commit**

```bash
git add public/js/app.js package.json public/index.html
git commit -m "feat(fg-cloud): Team Launch button honors Cloud VM tab + hands off to cloud card"
```

---

### Task 8: Engine — parity test for routed claim + name mapping

**Files:**
- Modify (engine repo): `test-campaign-followergrowth.js`

**Interfaces:**
- Consumes: engine `runFollowerGrowth` (`campaign-followergrowth.js`), `store.claimNextLead` (`campaign-store.js:119`).
- Produces: tests asserting (a) a lead with `route_account='accX'` is claimed only by `accX`; (b) each claimed lead's `full_name` flows into the modal-picker `queued` name (`campaign-followergrowth.js:70-75`).

Run in the engine repo: `cd /Users/antoniovarlese/Desktop/Projects/ortus-salesnav-scraper-cloud`.

- [ ] **Step 1: Read the existing test to match its harness**

Run: `sed -n '1,60p' test-campaign-followergrowth.js`
Note the in-memory store fixture / `sendInvites` injection pattern it already uses, and reuse it. The test injects `sendInvites` so no browser is needed.

- [ ] **Step 2: Add the routed-claim isolation test**

Using the file's existing store fixture, add a test where two leads are seeded — one with `route_account='accA'`, one with `route_account='accB'` — then assert `runFollowerGrowth` for `account='accA'` claims only accA's lead (accB's stays pending). Follow the existing test's assertion style (the file's helper for seeding leads + reading status). Capture invited ids via the injected `sendInvites` echo `{ sent:true, invited:[<memberId>] }`.

- [ ] **Step 3: Add the name-mapping test**

Seed a lead with `full_name='Jane Doe'`; inject `sendInvites` to capture its `queued` argument; assert `queued[0].name === 'Jane Doe'` and `queued[0].memberId === String(lead.id)` (matches `campaign-followergrowth.js:70-75`).

- [ ] **Step 4: Run the engine test**

Run: `node --test test-campaign-followergrowth.js`
Expected: PASS (existing + 2 new).

- [ ] **Step 5: Commit (engine repo — local only)**

```bash
git add test-campaign-followergrowth.js
git commit -m "test(fg): routed-claim isolation + full_name→queued mapping parity"
```

Do NOT push. This engine change stays local per the constraints.

---

### Task 9 (DEFERRABLE): Engine — per-account credit snapshot + app write-back

> Ship Tasks 1–8 first. This task adds credit-number parity (`observeFgCredits`). Without it, the FG-sheet budget self-corrects from the `Sent` count — acceptable per the spec. Only do this task if the operator wants exact modal-credit numbers written back.

**Files:**
- Modify (engine): `campaign-followergrowth.js` (persist per-account `creditsAfter`/`allowance`/`refill`), `campaign-store.js` (a `fg_credits` upsert + read), `campaign-api.js` (expose on `GET /api/campaign/:id`).
- Modify (app): `src/connections/fg-cloud-launch.js` `reconcileCloudRun` (call `deps.observeCredits` per account when the campaign response carries credits), `server.js` `reconcileFgCloudRuns` (wire `observeCredits: (a)=>observeFgCredits(a)` + import it), `tests/fg-cloud-launch.test.js` (a test asserting `observeCredits` is called with the exposed numbers).

- [ ] **Step 1:** Write the failing app test: `reconcileCloudRun` calls `deps.observeCredits({account, operator, month, available, allowance, refill})` when `getCampaign` returns `credits: { <profileId>: { available, allowance, refill } }`, and does NOT when absent.
- [ ] **Step 2:** Run it — FAIL (reconcile ignores credits).
- [ ] **Step 3:** Extend `reconcileCloudRun` to look up `camp.credits?.[profileId]` per group and call `deps.observeCredits` when present (guarded so Tasks 1–8 behavior is unchanged when `observeCredits`/credits are absent).
- [ ] **Step 4:** Run app test — PASS. Commit (app repo).
- [ ] **Step 5:** Engine: persist the credit snapshot `runFollowerGrowth` already computes (`result.creditsAfter/allowance/refill`) into a `fg_credits` store keyed by `(campaignId, account, month)`; expose it as `credits` on `GET /api/campaign/:id`. Add an engine test. Run `node --test test-campaign-followergrowth.js` — PASS. Commit (engine repo, local only).

---

## Self-Review

**1. Spec coverage:**
- Server-side `target:'cloud'` branch → Task 6. ✓
- `buildCloudLeads` (rows→leads+routeAccount, dedup, empty-URL drop) → Task 1. ✓
- Proof-at-launch `queueFgInvites` after successful dispatch only → Task 5 + Task 6. ✓
- Durable reconcile record (atomic JSON, never git-add) → Task 3 + Task 6. ✓
- Reconcile via poller + startup hook (`markFgInvited`, STRANDED, idempotent) → Task 4 + Task 6. ✓
- Client run-target read + `openCloudLive` hand-off + copy → Task 7. ✓
- Engine parity test (routed claim + name mapping) → Task 8. ✓
- Engine credit snapshot / `observeFgCredits` → Task 9 (deferrable, as the spec allows). ✓
- Two-record proof (engine Postgres + FG sheet) → engine stamps leads (existing) + Tasks 5/6 FG-sheet writes. ✓
- Error handling table (dispatch fail → no sheet write; sheet fail → STRANDED; app closed → startup reconcile; idempotent) → Tasks 4, 5, 6. ✓
- Off-limits files untouched; local path unchanged; engine local-only; config keys `config.inviteUrl`/`config.monthlyBudget` → Global Constraints + Tasks 5/6. ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows complete code. Task 8 steps 2–3 describe seeding against the file's existing fixture rather than pasting a fictional store API — this is deliberate (the harness must match the real file, which the implementer reads in Step 1) and each assertion target is concrete.

**3. Type consistency:** `perAccount` entry shape (`profileId, account, operator, month, rows, rowsByUrl, count, reason`) is consistent across Tasks 1→2→4→5. The persisted record trims to `{ profileId, account, operator, month, rowsByUrl }` (Task 5) — `invitedWritebackFromLeads` (Task 2) only reads those fields, so reconcile from a reloaded record works. `startCloudCampaign` payload uses `config:{inviteUrl,monthlyBudget}` matching the engine read (`campaign-runtime.js:233-234`). Invited detection (`stage==='Invited' || status==='sent'`) is identical in Tasks 2 and 4. `deps.startCloud` returns `{id}` — consistent with `startCloudCampaign`'s `{started,id}` return (Task 5 reads `.id`). ✓
