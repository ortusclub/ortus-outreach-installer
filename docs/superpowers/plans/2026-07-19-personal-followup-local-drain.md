# Personal-Primary Follow-up: Local Drain (Option 1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A cloud CC+IC campaign's follow-up, when the primary is a personal
(local-browser) account, is sent from the owner's own machine via the existing
local `[primary-runner]` — never from the VM.

**Architecture:** The engine keeps creating the `follow_up` task but its
scheduler ignores personal ones. The owner's app polls the engine for its due
personal follow-ups, converts each into the existing local queue
(`buildFollowUpTask` + `enqueuePrimaryTask`), acks the engine, and the existing
runner sends them from the person's own browser. GoLogin primaries unchanged.

**Tech Stack:** Engine — Node (CJS + ESM campaign-lib), Postgres, root `test-*.js`
with real pg. App — Node ≥22, Express 4, vanilla JS, `node --test`.

## Global Constraints

- `sender === 'local-browser'` marks a personal-primary follow-up. GoLogin
  follow-ups (`sender` = a profileId) keep running on the VM — never touch them.
- Reuse existing local primitives verbatim: `buildFollowUpTask`,
  `enqueuePrimaryTask` (dedupeKey `follow-up:<profileId>:<leadUrl>`), the
  `[primary-runner]`. No new send logic, no sheet writes (local follow-ups don't
  stamp the sheet).
- Ack the engine ONLY after the local enqueue succeeds (at-least-once + local
  dedupe → never double-send; never lose a follow-up).
- A personal follow-up must NEVER fall back to the VM.
- Engine `need(res)` guard on every new route (mirror sibling routes). Owner
  scoping via `?owner=` like `GET /api/campaign/list`.
- Two repos: engine = `/Users/antoniovarlese/Desktop/Projects/ortus-salesnav-scraper-cloud`
  (branch `primary-vm-followup`); app = `/Users/antoniovarlese/ortus-gologin-clone`
  (branch `primary-vm-followup`). Nothing pushed to GitHub.

---

### Task 1: Engine store — skip personal follow-ups + pull/delegate accessors

**Files:**
- Modify: `campaign-store.js` (`claimNextDueTask`, add two methods on `class CampaignStore`)
- Test: `test-local-followups-store.js` (new, root)

**Interfaces:**
- Produces: `getPendingLocalFollowups(owner)` → `Array<{taskId, campaignId, sheetUrl, payload}>`;
  `delegateLocalFollowups(taskIds)` → `{delegated: number}`. `claimNextDueTask()`
  no longer returns personal follow_up tasks.

- [ ] **Step 1: Write failing test** `test-local-followups-store.js`

```js
// Real pg + redis. Run:
// PG_URL=postgres://postgres:dev@localhost:5433/campaigns REDIS_URL=redis://localhost:6379 node test-local-followups-store.js
const assert = require('node:assert');
const Redis = require('ioredis');
const { CampaignStore } = require('./campaign-store.js');

(async () => {
  const store = new CampaignStore({ pgUrl: process.env.PG_URL, redis: new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null }), podId: 'lf' });
  const owner = 'owner-test@ortus.test';
  const other = 'other@ortus.test';
  const cid = 'cmp_lf_' + Math.floor(process.hrtime.bigint() % 1000000n);
  await store.pg.query(
    "INSERT INTO campaigns(id,name,mode,status,owner,profile_ids,daily_limit,config) VALUES ($1,'','connect_and_introduce','monitoring',$2,'{}',10,'{\"sheetUrl\":\"https://sheet/x\"}')",
    [cid, owner]);

  const mk = (sender, lead, due) => store.createTask({
    campaignId: cid, type: 'follow_up', dedupeKey: `fu:${sender}:${lead}`,
    dueAt: due, payload: { sender, leadUrl: lead, threadUrl: 't', body: 'b', profileId: 'acc1' },
  });
  const past = new Date(Date.now() - 60000), future = new Date(Date.now() + 3600000);
  await mk('local-browser', 'https://lk/in/a', past);   // due personal → should be pulled + NOT claimed
  await mk('local-browser', 'https://lk/in/b', future);  // future personal → not due
  await mk('gologinProfile1', 'https://lk/in/c', past);  // gologin → claimable, not pulled

  // claimNextDueTask must skip the personal one and hand back the gologin one.
  const claimed = await store.claimNextDueTask();
  assert.ok(claimed && claimed.payload.sender === 'gologinProfile1', 'claims gologin, skips personal');
  assert.strictEqual(await store.claimNextDueTask(), null, 'no more claimable (personal is skipped)');

  // getPendingLocalFollowups: owner-scoped, due-only, personal-only.
  const pend = await store.getPendingLocalFollowups(owner);
  assert.strictEqual(pend.length, 1, 'one due personal follow-up for owner');
  assert.strictEqual(pend[0].payload.leadUrl, 'https://lk/in/a');
  assert.strictEqual(pend[0].sheetUrl, 'https://sheet/x');
  assert.strictEqual((await store.getPendingLocalFollowups(other)).length, 0, 'other owner sees none');

  // delegate → no longer pending.
  const del = await store.delegateLocalFollowups([pend[0].taskId]);
  assert.strictEqual(del.delegated, 1);
  assert.strictEqual((await store.getPendingLocalFollowups(owner)).length, 0, 'delegated drops out of pending');

  await store.pg.query('DELETE FROM campaign_tasks WHERE campaign_id=$1', [cid]);
  await store.pg.query('DELETE FROM campaigns WHERE id=$1', [cid]);
  await store.close();
  console.log('OK test-local-followups-store');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
```

- [ ] **Step 2: Run → FAIL** (`getPendingLocalFollowups is not a function`, and claim returns the personal task).

- [ ] **Step 3: Implement.** In `claimNextDueTask`, add to the inner SELECT's WHERE:

```sql
WHERE status='pending' AND due_at <= now()
  AND NOT (type='follow_up' AND payload->>'sender' = 'local-browser')
```

Add these methods to `class CampaignStore` (near `getPrimaryBySlug`):

```js
// Due personal-primary follow-ups for one owner's campaigns — the app drains
// these locally (VM never sends a personal follow-up). Join to campaigns for
// owner scope + sheet_url.
async getPendingLocalFollowups(owner) {
  const { rows } = await this.pg.query(
    `SELECT t.id AS task_id, t.campaign_id, t.payload, c.sheet_url
       FROM campaign_tasks t
       JOIN campaigns c ON c.id = t.campaign_id
      WHERE t.type='follow_up' AND t.status='pending' AND t.due_at <= now()
        AND t.payload->>'sender' = 'local-browser'
        AND c.owner = $1
      ORDER BY t.due_at`,
    [owner]
  );
  return rows.map((r) => ({ taskId: r.task_id, campaignId: r.campaign_id, sheetUrl: r.sheet_url || '', payload: r.payload || {} }));
}

// Mark personal follow-ups handed to the owner's app. 'delegated' = sent
// locally: not 'pending' (never re-offered / never claimed by the VM) and
// distinct from 'done' for auditability.
async delegateLocalFollowups(taskIds) {
  if (!Array.isArray(taskIds) || !taskIds.length) return { delegated: 0 };
  const { rowCount } = await this.pg.query(
    `UPDATE campaign_tasks SET status='delegated'
      WHERE id = ANY($1) AND type='follow_up' AND payload->>'sender'='local-browser'`,
    [taskIds]
  );
  return { delegated: rowCount };
}
```

- [ ] **Step 4: Run → PASS.** `node --check campaign-store.js`.

- [ ] **Step 5: Commit** `git add campaign-store.js test-local-followups-store.js` →
  `feat(engine): skip personal follow-ups in claim + pull/delegate accessors`

---

### Task 2: Engine API — local-followups GET + ack POST

**Files:**
- Modify: `campaign-api.js` (add two routes near the primaries routes ~line 299)
- Test: `test-local-followups-api.js` (new, root) — mirror `test-primary-session-endpoint.js` harness

**Interfaces:**
- Consumes: `store.getPendingLocalFollowups`, `store.delegateLocalFollowups` (Task 1).
- Produces: `GET /api/campaign/local-followups?owner=` → `{followups:[...]}`;
  `POST /api/campaign/local-followups/ack` body `{taskIds:[...]}` → `{delegated:n}`.

- [ ] **Step 1: Write failing test** `test-local-followups-api.js` — spin the app
  like `test-primary-session-endpoint.js` (express + mounted `mountCampaignApi`
  with a real store), seed one due personal follow-up for `owner=o@test`, then:
  - `GET /api/campaign/local-followups?owner=o@test` → 200, `followups.length===1`,
    item has `taskId, threadUrl, body, leadUrl, profileId, sheetUrl`.
  - `GET` without `owner` → 400.
  - `POST /api/campaign/local-followups/ack {taskIds:[thatId]}` → 200 `{delegated:1}`;
    a subsequent `GET` → `followups.length===0`.

- [ ] **Step 2: Run → FAIL** (404 — routes not mounted).

- [ ] **Step 3: Implement** in `campaign-api.js`:

```js
app.get("/api/campaign/local-followups", async (req, res) => {
  if (need(res)) return;
  const owner = req.query.owner;
  if (!owner) { res.status(400).json({ error: "owner required" }); return; }
  try {
    const rows = await store.getPendingLocalFollowups(owner);
    const followups = rows.map((r) => ({
      taskId: r.taskId, campaignId: r.campaignId, sheetUrl: r.sheetUrl,
      threadUrl: r.payload.threadUrl || "", body: r.payload.body || "",
      leadUrl: r.payload.leadUrl || "", leadName: r.payload.leadName || "",
      primaryName: r.payload.primaryName || "", primaryUrl: r.payload.primaryUrl || "",
      introTitle: r.payload.introTitle || "", profileId: r.payload.profileId || "",
      dueAt: r.payload.dueAt || null,
    }));
    res.json({ followups });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/campaign/local-followups/ack", async (req, res) => {
  if (need(res)) return;
  const taskIds = (req.body && req.body.taskIds) || [];
  if (!Array.isArray(taskIds) || !taskIds.length) { res.status(400).json({ error: "taskIds required" }); return; }
  try { res.json(await store.delegateLocalFollowups(taskIds)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
```

- [ ] **Step 4: Run → PASS.** `node --check campaign-api.js`.

- [ ] **Step 5: Commit** `git add campaign-api.js test-local-followups-api.js` →
  `feat(engine): local-followups pull + ack endpoints`

---

### Task 3: Engine — retire personal VM-replay branch + migrate stuck tasks

**Files:**
- Modify: `campaign-runtime.js` (`handleFollowUp` — remove the personal branch)
- Create: `migrate-reset-local-followups.js` (one-off, root)

**Interfaces:** none new. `handleFollowUp` now only handles GoLogin follow-ups
(the scheduler never hands it a personal one after Task 1).

- [ ] **Step 1:** In `campaign-runtime.js` `handleFollowUp`, after the idempotency
  guard, replace the personal branch with a defensive no-op (the scheduler no
  longer routes personal follow-ups here, but guard against a stale task):

```js
if (primarySource === "local-browser") {
  // Personal follow-ups are drained by the owner's app (see local-drain design).
  // The scheduler skips them; if one still reaches here (stale), leave it for the
  // app rather than sending from the VM. Never send a personal follow-up here.
  d.log(`follow_up ${leadKey || "(no lead)"} is personal — left for local drain`);
  return { status: "delegated" };
}
```

Delete the `_ps` (`primary-session`) require + the launch/gate/park code that
followed. Keep the GoLogin branch above it unchanged. `node --check campaign-runtime.js`.

- [ ] **Step 2:** Create `migrate-reset-local-followups.js` — reset personal
  follow_up tasks stuck by the old VM path back to `pending` so the app drains them:

```js
const Redis = require('ioredis');
const { CampaignStore } = require('./campaign-store.js');
(async () => {
  const store = new CampaignStore({ pgUrl: process.env.PG_URL, redis: new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null }), podId: 'migrate' });
  const { rowCount } = await store.pg.query(
    `UPDATE campaign_tasks SET status='pending', claimed_by=NULL, claimed_at=NULL
      WHERE type='follow_up' AND payload->>'sender'='local-browser'
        AND status IN ('error','claimed')`
  );
  console.log('reset personal follow-ups →', rowCount);
  await store.close(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 3:** `node --check` both files. (The migrate script is run against
  prod during deploy, not in tests.)

- [ ] **Step 4: Commit** `git add campaign-runtime.js migrate-reset-local-followups.js` →
  `refactor(engine): retire personal VM follow-up branch; migrate stuck tasks to local drain`

---

### Task 4: App client — getLocalFollowups + ackLocalFollowups

**Files:**
- Modify: `src/campaigns-client.js`
- Test: `tests/campaigns-client-local-followups.test.js` (new)

**Interfaces:**
- Produces: `getLocalFollowups(owner)` → `{followups:[...]}|{error}`;
  `ackLocalFollowups(taskIds)` → `{delegated:n}|{error}`.

- [ ] **Step 1: Write failing test** — stub global `fetch`, assert the GET path is
  `/api/campaign/local-followups?owner=o%40test` with a Bearer header, and the ack
  POSTs `{taskIds}` to `/api/campaign/local-followups/ack`. (Follow the existing
  campaigns-client test style; if none, `node --test` with a `globalThis.fetch` stub.)

- [ ] **Step 2: Run → FAIL** (functions undefined).

- [ ] **Step 3: Implement** (append near `getPrimarySession`, reuse `requestOnce`):

```js
export function getLocalFollowups(owner) {
  return requestWithRetry('GET', '/api/campaign/local-followups?owner=' + encodeURIComponent(owner || ''));
}
export function ackLocalFollowups(taskIds) {
  return requestOnce('POST', '/api/campaign/local-followups/ack', { taskIds: taskIds || [] });
}
```

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit** `git add src/campaigns-client.js tests/campaigns-client-local-followups.test.js` →
  `feat(app): campaigns-client local-followups pull + ack`

---

### Task 5: App poller core — pull → enqueue local → ack

**Files:**
- Create: `src/cloud-followup-poller.js`
- Test: `tests/cloud-followup-poller.test.js` (new)

**Interfaces:**
- Consumes: `getLocalFollowups`, `ackLocalFollowups` (Task 4); `buildFollowUpTask`,
  `enqueuePrimaryTask` (`src/primary-tasks.js`); `getOperatorEmail`
  (`src/operator-identity.js`).
- Produces: `pollOnce(deps)` → `{enqueued:number, acked:number, late:number}`;
  `startCloudFollowupPoller()` / `stopCloudFollowupPoller()`.

- [ ] **Step 1: Write failing test** `tests/cloud-followup-poller.test.js`:
  - `pollOnce` with injected deps: `getOperatorEmail` → `'o@test'`;
    `getLocalFollowups` → two followups (one with `dueAt` 40 min ago → late);
    spy `enqueuePrimaryTask` (returns the task); spy `ackLocalFollowups`.
    Assert: `buildFollowUpTask` called with mapped fields
    (`campaignProfileId===profileId`, `sender==='local-browser'`, `delayMinutes===0`,
    `threadUrl/body/leadUrl/sheetUrl` propagated); ack called with BOTH taskIds;
    result `{enqueued:2, acked:2, late:1}`.
  - **Ack-after-enqueue ordering:** make `enqueuePrimaryTask` throw for the 2nd
    item → assert ack is called with ONLY the 1st taskId (never ack an item that
    didn't enqueue), result `enqueued:1`.
  - No operator email (`getOperatorEmail` → `''`) → `getLocalFollowups` NOT called,
    result `{enqueued:0, acked:0, late:0}`.

- [ ] **Step 2: Run → FAIL** (module missing).

- [ ] **Step 3: Implement** `src/cloud-followup-poller.js`:

```js
/**
 * Drains a cloud campaign's PERSONAL-primary follow-ups to the local machine.
 * The VM never sends a personal follow-up (LinkedIn invalidates a personal
 * session replayed from a datacenter IP). The engine leaves each due personal
 * follow-up pending; this poller pulls the owner's, enqueues them into the SAME
 * local queue a local campaign uses (so the existing [primary-runner] sends
 * them from the person's own browser), then acks the engine.
 */
import { getLocalFollowups, ackLocalFollowups } from './campaigns-client.js';
import { buildFollowUpTask, enqueuePrimaryTask } from './primary-tasks.js';
import { getOperatorEmail } from './operator-identity.js';

const LATE_MS = 30 * 60_000; // a follow-up due >30 min ago = the app was closed; surface it
let _timer = null;
let _lastLate = 0; // last poll's late count, for the UI nudge

export function lastLateCount() { return _lastLate; }

export async function pollOnce(deps = {}) {
  const {
    getOperatorEmail: opEmail = getOperatorEmail,
    getLocalFollowups: getFn = getLocalFollowups,
    ackLocalFollowups: ackFn = ackLocalFollowups,
    buildFollowUpTask: build = buildFollowUpTask,
    enqueuePrimaryTask: enqueue = enqueuePrimaryTask,
    now = () => Date.now(),
    log = (m) => console.log(`[cloud-followup-poller] ${m}`),
  } = deps;

  const owner = opEmail();
  if (!owner) return { enqueued: 0, acked: 0, late: 0 };

  const res = await getFn(owner);
  if (!res || res.error || !Array.isArray(res.followups) || !res.followups.length) {
    _lastLate = 0;
    return { enqueued: 0, acked: 0, late: 0 };
  }

  const acked = [];
  let late = 0;
  for (const fu of res.followups) {
    try {
      const task = build({
        campaignProfileId: fu.profileId, sheetUrl: fu.sheetUrl, sender: 'local-browser',
        threadUrl: fu.threadUrl, introTitle: fu.introTitle, leadName: fu.leadName,
        leadUrl: fu.leadUrl, primaryName: fu.primaryName, primaryUrl: fu.primaryUrl,
        body: fu.body, delayMinutes: 0, now: now(),
      });
      await enqueue(task);                 // dedupes on follow-up:<profileId>:<leadUrl>
      acked.push(fu.taskId);               // ack ONLY what actually enqueued
      if (fu.dueAt && (now() - new Date(fu.dueAt).getTime()) > LATE_MS) late++;
    } catch (e) {
      log(`enqueue failed for ${fu.leadUrl || fu.taskId}: ${e.message} — will retry next poll`);
    }
  }

  if (acked.length) { try { await ackFn(acked); } catch (e) { log(`ack failed: ${e.message}`); } }
  _lastLate = late;
  if (acked.length) log(`drained ${acked.length} personal follow-up(s)${late ? `, ${late} late` : ''}`);
  return { enqueued: acked.length, acked: acked.length, late };
}

export function startCloudFollowupPoller() {
  if (_timer) return;
  _timer = setInterval(() => { pollOnce().catch((e) => console.warn(`[cloud-followup-poller] tick: ${e.message}`)); }, 60_000);
  if (_timer.unref) _timer.unref();
  console.log('[cloud-followup-poller] started (60s tick).');
}
export function stopCloudFollowupPoller() { if (_timer) { clearInterval(_timer); _timer = null; } }
```

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit** `git add src/cloud-followup-poller.js tests/cloud-followup-poller.test.js` →
  `feat(app): cloud follow-up poller — drain personal follow-ups to the local runner`

---

### Task 6: App — boot the poller + fix the misleading login copy

**Files:**
- Modify: `server.js` (start the poller next to `startPrimaryTaskRunner()` ~line 5686)
- Modify: `public/js/primary-session-render.mjs` (+ `public/js/app.js` if the string
  lives there) — replace the "waiting for X to log in" copy
- Modify: `package.json` (patch bump) + `public/index.html` (`?v=` bump)

**Interfaces:** Consumes `startCloudFollowupPoller` (Task 5), `lastLateCount`.

- [ ] **Step 1:** `server.js` — import and start:

```js
import { startCloudFollowupPoller } from './src/cloud-followup-poller.js';
// ... near startPrimaryTaskRunner():
startPrimaryTaskRunner();
startCloudFollowupPoller();
```

- [ ] **Step 2:** Copy fix. Find the personal-primary warning string ("waiting for
  … to log in" / needs_login framing) in `primary-session-render.mjs` / `app.js`.
  For a personal primary there is no VM login — replace with the local-drain truth.
  When `lastLateCount() > 0`, show e.g. `"N follow-up(s) waiting to send from this
  machine — keep the app open."` Otherwise no scary "log in" banner. (Reuse the
  existing render surface; do not add a new component.)

- [ ] **Step 3:** Patch-bump `package.json` version + the `?v=` query on the app's
  script/style includes in `public/index.html` (operator rule: version visible so
  Antonio confirms the build).

- [ ] **Step 4:** Manual verify — `npm run dev:app`, load the app, confirm the
  poller logs `started (60s tick)` and no console errors; the primary warning no
  longer says "log in".

- [ ] **Step 5: Commit** `git add server.js public/js/primary-session-render.mjs public/js/app.js public/index.html package.json` →
  `feat(app): boot cloud follow-up poller; fix personal-primary login copy`

---

## Deploy (after all tasks + reviews)

1. Engine: Cloud Build a new image; roll `campaign-worker` + frontend. Run
   `migrate-reset-local-followups.js` once (or rely on it running via a one-off
   exec) so the currently-stuck task 35 (and any siblings) become pending and the
   app drains them. Do NOT push to GitHub.
2. App: dev build for Antonio's machine (operator-gated DMG later). End-to-end:
   one cloud CC+IC with Antonio as personal primary → follow-up sends from his
   local browser after the intro; verify it lands in the thread and no VM launch.

## Self-Review

- **Coverage:** engine skip (T1) + endpoints (T2) + retire/migrate (T3) + client
  (T4) + poller (T5) + boot/copy (T6) — every spec section mapped.
- **Types:** `getPendingLocalFollowups`/`delegateLocalFollowups` signatures match
  between store (T1), api (T2). `buildFollowUpTask` field names match
  `src/primary-tasks.js`. Engine payload fields match `campaign-autointro.js`
  (`threadUrl, body, leadUrl, leadName, primaryName, primaryUrl, introTitle,
  profileId, sender`).
- **Ack ordering** asserted in T5 (never ack an un-enqueued item).
- **No placeholder** steps; every code step has code.
