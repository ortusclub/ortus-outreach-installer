# Follower Growth — Team Launch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the per-operator FG build→queue→send flow with a single Team Launch screen that pairs several Ortus employees to their GoLogin profiles (auto-matched by email) and runs them as one sequential batch, streaming a live campaign card.

**Architecture:** A new server-side sequential engine (`fg-team-launch.js`) loops the selected employee→profile pairs one at a time, reusing the existing `buildFgTargets()` → `launchProfile()` → `runFollowerInvites()` → write-back chain. Write-back keeps the FG sheet/budgets in sync by appending the invited rows and flipping them to Invited (no permanent Queued rows, no Apps Script change). The `#nav-follower-growth` UI is rebuilt to the verified sketch B (filter chips + match board + real `vj-card` live log) and driven by polling a new `/api/fg/team-launch/status`.

**Tech Stack:** Node ≥22, Express 4, vanilla JS frontend (no bundler), `node --test`, GoLogin SDK + puppeteer-core, central FG Apps Script (unchanged).

## Global Constraints

- Runtime Node ≥22; Express 4; vanilla JS frontend, no bundler.
- Test framework: `node --test` only (no Jest/Vitest). Pure-helper unit tests preferred; UI changes verified manually via `npm run dev:app`.
- **One GoLogin browser open at a time** — the engine must `await` close before the next launch; a second team-launch cannot start while one runs (the documented multi-browser crash constraint).
- **Off-limits files:** `src/linkedin/outreach.js`, `src/linkedin/actions.js` — do NOT touch. `src/linkedin/follower-invite.js` is the FG sender and IS in scope.
- **No Apps Script redeploy:** reuse existing `fgQueue`/`fgMarkInvited` actions; do not change `fg-apps-script.js`.
- **DNC stays on** — `buildFgTargets()` is used unchanged (DNC-safe).
- Bump `package.json` version before relaunching dev:app (current 2.115.6 → target 2.116.0). Auto-relaunch `npm run dev:app` after each commit that touches runtime code (per repo rules).
- Design system: monochrome + hairlines, gold only on the primary CTA; reuse `/css/style.css` + `dashboard-v0.3.css` tokens; the live card reuses the existing `.vj-*` classes.
- Never `git add data/monitoring-campaign.json` or other tracked runtime-state foot-guns.

---

## File Structure

- Create: `src/connections/fg-team-launch.js` — sequential batch engine (dependency-injected for testing).
- Create: `tests/fg-team-launch.test.js` — engine sequencing/skip/abort/write-back unit tests.
- Create: `tests/fg-colleagues.test.js` — colleague-roster helper test.
- Modify: `src/connections/search-service.js` — add `listFgColleagues()` (distinct warmVia owners + counts).
- Modify: `server.js` — add `/api/fg/colleagues` + `/api/fg/team-launch/{start,status,stop}`; wire the engine.
- Modify: `public/index.html` — rebuild `#nav-follower-growth` to the Team Launch layout (filter card + match board + `vj-card`).
- Modify: `public/js/app.js` — rewrite `initFollowerGrowth()` + new client funcs; drop old build/queue/send from the happy path.
- Modify: `package.json` — version bump.

---

## Task 1: Colleague roster helper (`listFgColleagues`)

**Files:**
- Modify: `src/connections/search-service.js` (add export near `buildFgTargets`, ~line 219)
- Test: `tests/fg-colleagues.test.js`

**Interfaces:**
- Consumes: `getAnnotated(dir, cachePath)` → array of `{ contact, warmVia:[email], dnc }`; `getColleagues()` → `{ [email]: { name } }` (both already in `search-service.js`).
- Produces: `listFgColleagues({ dir, cachePath } = {})` → `[{ email, name, connCount }]` sorted by `name`. `connCount` = number of non-DNC annotated rows whose `warmVia` includes that email.

- [ ] **Step 1: Write the failing test**

```js
// tests/fg-colleagues.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __setFgColleaguesFixtures, listFgColleagues } from '../src/connections/search-service.js';

test('listFgColleagues returns distinct owners with non-DNC connection counts, sorted by name', () => {
  __setFgColleaguesFixtures({
    annotated: [
      { contact: { firstname: 'A' }, warmVia: ['bea@ortusclub.com'], dnc: false },
      { contact: { firstname: 'B' }, warmVia: ['bea@ortusclub.com', 'sam@ortusclub.com'], dnc: false },
      { contact: { firstname: 'C' }, warmVia: ['sam@ortusclub.com'], dnc: true }, // DNC excluded
    ],
    colleagues: {
      'bea@ortusclub.com': { name: 'Beatrice Talusan' },
      'sam@ortusclub.com': { name: 'Sam Adcock' },
    },
  });
  const out = listFgColleagues();
  assert.deepEqual(out, [
    { email: 'bea@ortusclub.com', name: 'Beatrice Talusan', connCount: 2 },
    { email: 'sam@ortusclub.com', name: 'Sam Adcock', connCount: 1 },
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/fg-colleagues.test.js`
Expected: FAIL — `__setFgColleaguesFixtures`/`listFgColleagues` not exported.

- [ ] **Step 3: Implement the helper + test seam**

Add to `src/connections/search-service.js` (after `buildFgTargets`):

```js
// Test seam: when set, listFgColleagues uses these instead of the real DB.
let _fgColleaguesFixtures = null;
export function __setFgColleaguesFixtures(f) { _fgColleaguesFixtures = f; }

// Distinct warm-via owners (the Ortus colleagues whose networks are in the DB)
// with their non-DNC connection counts — the employee roster for Team Launch.
export function listFgColleagues({ dir, cachePath } = {}) {
  const annotated = _fgColleaguesFixtures ? _fgColleaguesFixtures.annotated : getAnnotated(dir, cachePath);
  const colleagues = _fgColleaguesFixtures ? _fgColleaguesFixtures.colleagues : getColleagues();
  const counts = new Map();
  for (const r of annotated) {
    if (r.dnc) continue;
    for (const email of (r.warmVia || [])) counts.set(email, (counts.get(email) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([email, connCount]) => ({ email, name: colleagues[email]?.name || email, connCount }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/fg-colleagues.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/connections/search-service.js tests/fg-colleagues.test.js
git commit -m "feat(fg): listFgColleagues — employee roster with non-DNC connection counts"
```

---

## Task 2: Sequential batch engine (`fg-team-launch.js`)

**Files:**
- Create: `src/connections/fg-team-launch.js`
- Test: `tests/fg-team-launch.test.js`

**Interfaces:**
- Consumes (injected `deps` for testability): `buildTargets(pair, ctx)` → `{ rows, count }` (rows in FG_HEADER order); `launch(pair)` → `{ page, close }`; `send({ page, queued, log, shouldAbort })` → `{ invited:[memberId], skipped:[...], creditsBefore, creditsAfter }`; `record({ rows, invitedIds, account, operator, month })` → Promise; `log(line)`; `now()` → ISO string.
- Produces: `runTeamLaunch(pairs, ctx, deps)` → mutates and returns a `status` object (see shape below). `pairToQueued(rows)` → `[{ name, jobTitle, company, memberId }]` mapping FG_HEADER rows for the sender. `makeInitialStatus(pairs)` → status object.
- `pair` shape: `{ operator, operatorName, account, profileId }`. `ctx`: `{ keywords, month, getAbort:()=>bool }`.
- `status` shape:
  ```js
  { running, phase, totalAccounts, doneAccounts, currentAccount,
    sent, skipped, invitesTotal,
    perAccount:[{ account, status:'waiting|running|done|skipped', invited:0, reason:'' }],
    logs:[String], error:null }
  ```

- [ ] **Step 1: Write the failing test**

```js
// tests/fg-team-launch.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTeamLaunch, pairToQueued, makeInitialStatus } from '../src/connections/fg-team-launch.js';

const FG_ROW = (name, mid) => [name, `url/${mid}`, mid, 'Co', 'Head of Marketing', 'marketing', 'Milan', 'Op', 'acct', 'Queued', '', '', '2026-06'];

test('pairToQueued maps FG_HEADER rows to the sender shape', () => {
  assert.deepEqual(pairToQueued([FG_ROW('Marta Rossi', 'm1')]), [
    { name: 'Marta Rossi', jobTitle: 'Head of Marketing', company: 'Co', memberId: 'm1' },
  ]);
});

test('runTeamLaunch runs accounts sequentially, skips empty/zero-target, records invited, never overlaps launches', async () => {
  const events = [];
  let open = 0, maxOpen = 0;
  const recorded = [];
  const pairs = [
    { operator: 'a@x', operatorName: 'A', account: 'a@x', profileId: 'p1' }, // sends m1
    { operator: 'b@x', operatorName: 'B', account: 'b@x', profileId: 'p2' }, // 0 targets → skip
    { operator: 'c@x', operatorName: 'C', account: 'c@x', profileId: 'p3' }, // sends m3
  ];
  const targetsByOp = { 'a@x': [FG_ROW('A1','m1')], 'b@x': [], 'c@x': [FG_ROW('C1','m3')] };
  const deps = {
    buildTargets: (pair) => ({ rows: targetsByOp[pair.operator], count: targetsByOp[pair.operator].length }),
    launch: async (pair) => { open++; maxOpen = Math.max(maxOpen, open); events.push(`launch:${pair.operator}`); return { page: {}, close: async () => { open--; events.push(`close:${pair.operator}`); } }; },
    send: async ({ queued }) => ({ invited: queued.map((q) => q.memberId), skipped: [], creditsBefore: 30, creditsAfter: 30 - queued.length }),
    record: async ({ account, invitedIds }) => { recorded.push({ account, invitedIds }); },
    log: (l) => events.push(`log:${l}`),
    now: () => '2026-06-23T00:00:00.000Z',
  };
  const ctx = { keywords: ['marketing'], month: '2026-06', getAbort: () => false };
  const status = makeInitialStatus(pairs);
  await runTeamLaunch(pairs, ctx, deps, status);

  assert.equal(maxOpen, 1, 'only one browser open at a time');
  assert.equal(status.running, false);
  assert.equal(status.phase, 'done');
  assert.equal(status.sent, 2);
  assert.equal(status.skipped, 1);
  assert.equal(status.invitesTotal, 2);
  assert.deepEqual(status.perAccount.map((a) => a.status), ['done', 'skipped', 'done']);
  assert.equal(status.perAccount[1].reason, 'no targets');
  assert.deepEqual(recorded, [
    { account: 'a@x', invitedIds: ['m1'] },
    { account: 'c@x', invitedIds: ['m3'] },
  ]);
  // launches never interleave
  assert.deepEqual(events.filter((e) => e.startsWith('launch') || e.startsWith('close')),
    ['launch:a@x', 'close:a@x', 'launch:c@x', 'close:c@x']);
});

test('runTeamLaunch aborts before the next account when getAbort flips', async () => {
  const pairs = [
    { operator: 'a@x', operatorName: 'A', account: 'a@x', profileId: 'p1' },
    { operator: 'b@x', operatorName: 'B', account: 'b@x', profileId: 'p2' },
  ];
  let aborted = false;
  const deps = {
    buildTargets: () => ({ rows: [FG_ROW('X','mX')], count: 1 }),
    launch: async () => ({ page: {}, close: async () => {} }),
    send: async ({ queued }) => { aborted = true; return { invited: queued.map((q) => q.memberId), skipped: [], creditsBefore: 30, creditsAfter: 29 }; },
    record: async () => {},
    log: () => {},
    now: () => '2026-06-23T00:00:00.000Z',
  };
  const ctx = { keywords: [], month: '2026-06', getAbort: () => aborted }; // flips true after first send
  const status = makeInitialStatus(pairs);
  await runTeamLaunch(pairs, ctx, deps, status);
  assert.equal(status.perAccount[0].status, 'done');
  assert.equal(status.perAccount[1].status, 'skipped');
  assert.equal(status.perAccount[1].reason, 'stopped');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/fg-team-launch.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the engine**

```js
// src/connections/fg-team-launch.js
// Sequential Follower-Growth batch: run each employee→profile pair one at a time
// (one browser open at any moment), reusing buildTargets/launch/send/record via
// injected deps so the loop is unit-testable without a real browser or sheet.

// FG_HEADER indices used to map a built row to the sender's queued shape.
const I_NAME = 0, I_MEMBER = 2, I_COMPANY = 3, I_TITLE = 4;

export function pairToQueued(rows) {
  return (rows || []).map((r) => ({
    name: r[I_NAME], jobTitle: r[I_TITLE], company: r[I_COMPANY], memberId: String(r[I_MEMBER] || ''),
  }));
}

export function makeInitialStatus(pairs) {
  return {
    running: true, phase: 'launching', totalAccounts: pairs.length, doneAccounts: 0,
    currentAccount: null, sent: 0, skipped: 0, invitesTotal: 0,
    perAccount: pairs.map((p) => ({ account: p.account, status: 'waiting', invited: 0, reason: '' })),
    logs: [], error: null,
  };
}

export async function runTeamLaunch(pairs, ctx, deps, status) {
  const stamp = (m) => { const line = `[${deps.now()}] ${m}`; status.logs.push(line); if (status.logs.length > 200) status.logs.shift(); try { deps.log(m); } catch (_) {} };
  stamp(`▶ Team launch started · ${pairs.length} account(s) · roles: ${(ctx.keywords || []).join(', ') || 'all'}`);
  try {
    for (let i = 0; i < pairs.length; i++) {
      const pair = pairs[i];
      const slot = status.perAccount[i];
      if (ctx.getAbort()) { slot.status = 'skipped'; slot.reason = 'stopped'; status.skipped++; stamp(`✗ [${pair.account}] Skipped — stopped`); continue; }
      status.currentAccount = pair.account;
      const { rows, count } = deps.buildTargets(pair, ctx);
      if (!count) { slot.status = 'skipped'; slot.reason = 'no targets'; status.skipped++; stamp(`✗ [${pair.account}] Skipped — no targets (filtered/budget/already-invited)`); status.doneAccounts++; continue; }
      slot.status = 'running'; status.phase = 'inviting';
      stamp(`🔄 [${pair.account}] Opening profiles & sending follow invites — ${count} target(s)…`);
      let handle = null;
      try {
        handle = await deps.launch(pair);
        const out = await deps.send({ page: handle.page, queued: pairToQueued(rows), log: (m) => stamp(`[${pair.account}] ${m}`), shouldAbort: ctx.getAbort });
        const invitedIds = out.invited || [];
        if (invitedIds.length) await deps.record({ rows, invitedIds, account: pair.account, operator: pair.operator, month: ctx.month });
        slot.status = 'done'; slot.invited = invitedIds.length; status.sent++; status.invitesTotal += invitedIds.length;
        stamp(`✓ [${pair.account}] Invites sent · ${invitedIds.length} sent, ${out.creditsAfter} credits left`);
      } catch (err) {
        slot.status = 'skipped'; slot.reason = err.message; status.skipped++; stamp(`✗ [${pair.account}] Error — ${err.message}`);
      } finally {
        try { if (handle) await handle.close(); } catch (_) {}
      }
      status.doneAccounts++;
    }
    status.phase = 'done';
    stamp(`■ Team launch complete — ${status.sent} sent, ${status.skipped} skipped`);
  } catch (err) {
    status.phase = 'error'; status.error = err.message; stamp(`✗ Fatal — ${err.message}`);
  } finally {
    status.running = false; status.currentAccount = null;
  }
  return status;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/fg-team-launch.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/connections/fg-team-launch.js tests/fg-team-launch.test.js
git commit -m "feat(fg): sequential team-launch engine (one browser at a time, injected deps)"
```

---

## Task 3: Server routes — colleagues + team-launch start/status/stop

**Files:**
- Modify: `server.js` (add after the FG send block, ~line 1508; add `/api/fg/colleagues` near `/api/fg/operators` ~line 1395)
- Test: manual (route smoke) — pure logic is covered by Task 2.

**Interfaces:**
- Consumes: `listFgColleagues` (Task 1), `runTeamLaunch`/`makeInitialStatus` (Task 2), existing `buildFgTargets`, `fgCriteria`, `fgRemaining`, `fgMonth`, `getFgState`, `queueFgInvites`, `markFgInvited`, `launchProfile`, `closeProfile`, `launchLocalBrowser`, `closeLocalBrowser`, `runFollowerInvites`, `ORTUS_PAGE_INVITE_URL`, `campaignLog`, `preventSleep`, `allowSleep`.
- Produces: `GET /api/fg/colleagues` → `{ colleagues:[{email,name,connCount}] }`. `POST /api/fg/team-launch/start` body `{ keywords:[], pairs:[{operator,operatorName,account,profileId}], month }` → `{ started:true }`. `GET /api/fg/team-launch/status` → status object. `POST /api/fg/team-launch/stop` → `{ ok:true }`.

- [ ] **Step 1: Add the imports + colleagues route**

At the top of `server.js` where `buildFgTargets` is imported from `search-service.js`, add `listFgColleagues`. Add the team-launch engine import near the other `src/connections` imports:

```js
import { runTeamLaunch, makeInitialStatus } from './src/connections/fg-team-launch.js';
```

Add the route next to `/api/fg/operators` (~line 1395):

```js
// Employee roster for the Team Launch board (colleagues with DB coverage + counts).
app.get('/api/fg/colleagues', (_req, res) => {
  try { res.json({ colleagues: listFgColleagues() }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
```

- [ ] **Step 2: Add the team-launch state + start/status/stop routes**

Add after the `/api/fg/send/start` handler (~line 1508):

```js
// ── Follower Growth — Team Launch (sequential multi-account batch) ──────────
// Replaces the build→queue→send queue. For each employee→profile pair, build
// targets fresh, launch ONE browser, send, write back (append invited rows then
// flip to Invited — no permanent Queued rows), then the next pair. One browser
// open at a time (multi-browser crash constraint).
let _fgTeam = { running: false, phase: 'idle', totalAccounts: 0, doneAccounts: 0, currentAccount: null, sent: 0, skipped: 0, invitesTotal: 0, perAccount: [], logs: [], error: null };
let _fgTeamAbort = false;

app.get('/api/fg/team-launch/status', (_req, res) => res.json(_fgTeam));
app.post('/api/fg/team-launch/stop', (_req, res) => { _fgTeamAbort = true; res.json({ ok: true }); });

app.post('/api/fg/team-launch/start', async (req, res) => {
  if (_fgTeam.running) return res.status(409).json({ error: 'A team launch is already running.' });
  const b = req.body || {};
  const pairs = Array.isArray(b.pairs) ? b.pairs.filter((p) => p && p.operator && p.account && p.profileId) : [];
  if (!pairs.length) return res.status(400).json({ error: 'At least one paired account is required.' });
  const month = b.month || fgMonth();
  const keywords = Array.isArray(b.keywords) ? b.keywords : [];
  res.json({ started: true });

  _fgTeam = makeInitialStatus(pairs);
  _fgTeam.phase = 'launching';
  _fgTeamAbort = false;
  const token = process.env.GOLOGIN_API_TOKEN;
  const { closeProfile } = await import('./src/gologin-launcher.js');
  preventSleep('fg-team-launch');

  const deps = {
    // Build this account's targets fresh (DNC-safe, keyword-filtered, deduped vs
    // already-invited, budget-capped) immediately before its send.
    buildTargets: (pair) => {
      // NOTE: getFgState is async; we snapshot it once per account via the closure below.
      const snap = _fgTeamSnap;
      const alreadyInvited = (snap.invites || []).map((r) => String(r['Member ID'] || '') || (r['LinkedIn URL'] || ''));
      const budget = fgRemaining(snap.budgets, pair.account, month);
      return buildFgTargets(fgCriteria({ jobTitles: keywords }), { operator: pair.operator, operatorName: pair.operatorName, account: pair.account, month, alreadyInvited, budget });
    },
    launch: async (pair) => {
      const isLocal = pair.profileId === 'local-browser';
      campaignLog(`[FG-team] Launching ${isLocal ? 'local browser' : `profile ${pair.profileId}`} for ${pair.account}`);
      const launched = isLocal ? await launchLocalBrowser() : await launchProfile(pair.profileId, token);
      return { page: launched.page, close: async () => { await (isLocal ? closeLocalBrowser() : closeProfile(pair.profileId)); } };
    },
    send: ({ page, queued, log, shouldAbort }) => runFollowerInvites({ page, inviteUrl: ORTUS_PAGE_INVITE_URL, queued, log, shouldAbort }),
    // Write-back: append the invited rows then flip them to Invited (+bump budget).
    // End state has NO Queued rows; reuses existing Apps Script actions.
    record: async ({ rows, invitedIds, account, operator }) => {
      const set = new Set(invitedIds.map(String));
      const invitedRows = rows.filter((r) => set.has(String(r[2])));
      if (invitedRows.length) { await queueFgInvites(invitedRows); await markFgInvited({ memberIds: invitedIds, account, operator, month }); }
      _fgTeamSnap = await getFgState(); // refresh so the next account dedups against these
    },
    log: (m) => { try { campaignLog(`[FG-team] ${m}`); } catch (_) {} },
    now: () => new Date().toISOString(),
  };

  let _fgTeamSnap = { invites: [], budgets: [] };
  (async () => {
    try {
      _fgTeamSnap = await getFgState();
      await runTeamLaunch(pairs, { keywords, month, getAbort: () => _fgTeamAbort }, deps, _fgTeam);
    } catch (err) {
      _fgTeam.running = false; _fgTeam.phase = 'error'; _fgTeam.error = err.message;
    } finally {
      try { allowSleep(); } catch (_) {}
    }
  })();
});
```

NOTE for the implementer: `_fgTeamSnap` is referenced by `deps.buildTargets`/`deps.record` and assigned in the IIFE — declare `let _fgTeamSnap = { invites: [], budgets: [] };` **above** the `const deps = {...}` block (hoist the declaration before `deps`). Move the declaration up so there is no TDZ error.

- [ ] **Step 3: Verify the server boots and routes respond**

```bash
pkill -f "node server.js" 2>/dev/null; node server.js > /tmp/fg-team-server.log 2>&1 &
sleep 2
curl -s localhost:3000/api/fg/colleagues | head -c 300
curl -s localhost:3000/api/fg/team-launch/status
```

Expected: colleagues route returns `{"colleagues":[...]}` (or a clear DB error, not a crash); status returns the idle `_fgTeam` JSON.

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat(fg): team-launch routes (colleagues + sequential start/status/stop)"
```

---

## Task 4: Rebuild the `#nav-follower-growth` panel HTML

**Files:**
- Modify: `public/index.html` (replace the inner markup of `#nav-follower-growth`, lines ~1456–1534)

**Interfaces:**
- Produces these element IDs consumed by Task 5/6: `#fgtl-chips`, `#fgtl-chip-input`, `#fgtl-presets`, `#fgtl-match`, `#fgtl-search`, `#fgtl-search-clear`, `#fgtl-selall`, `#fgtl-emps`, `#fgtl-gls`, and the live card IDs `#fgtl-card`, `#fgtl-eyebrow`, `#fgtl-when`, `#fgtl-bar`, `#fgtl-pct`, `#fgtl-sent`, `#fgtl-total`, `#fgtl-accts`, `#fgtl-inv`, `#fgtl-seq`, `#fgtl-loghead`, `#fgtl-logbody`, `#fgtl-copy`, `#fgtl-sum-sent`, `#fgtl-sum-skip`, and the dock `#fgtl-dn`, `#fgtl-ds`, `#fgtl-go`.

- [ ] **Step 1: Replace the panel inner markup**

Port the verified sketch (`public/sketches/fg-launch-B-board.html`) body into `#nav-follower-growth`, renaming the sketch's IDs to the `fgtl-` prefix above to avoid clashes with the app's existing `fg-*` IDs. Keep the `.vj-card` block verbatim (so it inherits the live campaign-card styling), but with `fgtl-` IDs. Use the sketch's filter-card, match board (search + select-all + `#fgtl-emps` / `#fgtl-gls`), the `vj-card` live log, and a launch dock containing `#fgtl-go`.

Reference the sketch for exact structure; the only changes are ID prefixes (`fg…` → `fgtl-…`) and that this lives inside the existing `<div id="nav-follower-growth" ...>` container instead of a standalone `.sk-wrap`.

- [ ] **Step 2: Move the sketch's `<style>` into a scoped block**

Copy the sketch's CSS (filter chips, board, search toolbar) into a `<style>` near the panel, scoping selectors under `#nav-follower-growth` so they don't leak (e.g. `#nav-follower-growth .chips { … }`). The `.vj-*` rules already exist globally — do NOT re-declare them.

- [ ] **Step 3: Verify it renders (no JS yet)**

```bash
# version bump first (runtime UI change)
# package.json: 2.115.6 → 2.116.0
pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "Electron.*ortus" 2>/dev/null
npm run dev:app > /tmp/dev-app.log 2>&1 &
```

In the app, select mode **Follower Growth** → the panel shows the filter card + match board skeleton + the live card (empty). No console errors about missing elements (data fills in Task 5).

- [ ] **Step 4: Commit**

```bash
# do NOT add data/ runtime-state files
git add public/index.html package.json
git commit -m "feat(fg): rebuild Follower Growth panel as the Team Launch board (markup) (v2.116.0)"
```

---

## Task 5: Rewrite `initFollowerGrowth()` + board client logic

**Files:**
- Modify: `public/js/app.js` (`initFollowerGrowth` ~line 13196; add new helpers nearby; keep old `fgBuild`/`fgQueue`/`fgSendStart` defined but unreferenced)

**Interfaces:**
- Consumes: `GET /api/fg/colleagues` → `{colleagues:[{email,name,connCount}]}`; existing profile list (`allProfilesData` / the same source `fgRenderSendAccounts` used) deduped by email; `GET /api/fg/db` for FG Budgets (credit bands via existing `fgAccountCredit`).
- Produces: `fgtlState` (module-scoped `{ [email]: { selected, profileName } }`), `fgtlRenderEmps()`, `fgtlRenderGls()`, `fgtlAutoPair(email)`, `fgtlVisibleEmployees()`, `fgtlUpdateDock()`, and chip helpers `fgtlKeywords` (array). `initFollowerGrowth()` now boots the board.

- [ ] **Step 1: Repoint `initFollowerGrowth()`**

Replace the body of `initFollowerGrowth()` to: (a) fetch `/api/fg/colleagues` and the profiles + budgets; (b) build `fgtlState` with auto-pair by email; (c) render chips (default `['marketing','brand','growth','content','demand','comms','cmo']`), the employee list, and the GoLogin panel; (d) wire search, select-all, chip add/remove. Port the verified JS from the sketch (`fg-launch-B-board.html` `<script>`), renaming `state`→`fgtlState`, `keywords`→`fgtlKeywords`, and the render fns to the `fgtl…` names, and replacing the sketch's `FGL.employees/profiles` with the fetched data:

- Employees: from `/api/fg/colleagues` → `[{ email, name, connInDb: connCount }]`.
- Profiles: the app's deduped GoLogin list → `[{ name(email), creditsTotal, creditsUsed }]` where credits come from `fgAccountCredit(email)` (`remaining`/`allowance`) for the current month.
- `fgtlAutoPair(email)` = profile whose `name` equals the employee email (case-insensitive).

- [ ] **Step 2: Verify board populates**

Reload dev:app (Cmd+R). Follower Growth panel now lists real colleagues with connection counts; ticking one auto-pairs its GoLogin profile (green) or shows a manual dropdown; search filters by name/email/account; select-all respects search; the dock count updates. Use the browser MCP/console to confirm no errors.

- [ ] **Step 3: Commit**

```bash
git add public/js/app.js
git commit -m "feat(fg): Team Launch board logic — colleagues, auto-pair, search, select-all"
```

---

## Task 6: Launch → poll → drive the live card; retire the queue path

**Files:**
- Modify: `public/js/app.js` (add `fgtlLaunch()`, `fgtlPoll()`, `fgtlRenderCard(status)`; bind `#fgtl-go`)

**Interfaces:**
- Consumes: `POST /api/fg/team-launch/start` `{ keywords, pairs, month }`; `GET /api/fg/team-launch/status`; `v3RenderLogLine(line)` (existing, for `vj-log-line` rendering); `POST /api/fg/team-launch/stop`.
- Produces: a 2s poll loop that maps the status object onto the `#fgtl-*` card IDs exactly as the sketch does (eyebrow, `#fgtl-bar` width, `#fgtl-pct`, `#fgtl-sent`/`#fgtl-total`, `#fgtl-accts`, `#fgtl-inv`, `#fgtl-seq`, `#fgtl-logbody` via `v3RenderLogLine`, `#fgtl-sum-sent`/`#fgtl-sum-skip`).

- [ ] **Step 1: Implement launch + poll**

```js
// pairs from selected employees with a paired profile
function fgtlPairs() {
  return Object.entries(fgtlState)
    .filter(([, s]) => s.selected && s.profileName)
    .map(([email, s]) => {
      const emp = fgtlEmployees.find((e) => e.email === email);
      const prof = fgtlProfiles.find((p) => p.name === s.profileName);
      return { operator: email, operatorName: emp?.name || email, account: s.profileName, profileId: prof?.id || s.profileName };
    });
}

async function fgtlLaunch() {
  const pairs = fgtlPairs();
  if (!pairs.length) return;
  document.getElementById('fgtl-go').disabled = true;
  const r = await fetch('/api/fg/team-launch/start', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keywords: fgtlKeywords, pairs, month: new Date().toISOString().slice(0, 7) }) });
  if (!r.ok) { const e = await r.json().catch(() => ({})); alert(e.error || 'Launch failed'); document.getElementById('fgtl-go').disabled = false; return; }
  fgtlPoll();
}

function fgtlPoll() {
  const tick = async () => {
    const s = await fetch('/api/fg/team-launch/status').then((x) => x.json()).catch(() => null);
    if (!s) return;
    fgtlRenderCard(s);
    if (s.running) setTimeout(tick, 2000);
    else document.getElementById('fgtl-go').disabled = false;
  };
  tick();
}
```

NOTE: `fgtlProfiles` must carry the GoLogin profile `id` (so `profileId` is the real GoLogin id, not the email). Ensure Task 5's profile objects include `{ name, id, creditsTotal, creditsUsed }`. For `local-browser`, `id` is `'local-browser'`.

- [ ] **Step 2: Implement `fgtlRenderCard` (mirror the sketch)**

Map `status` → card IDs: set eyebrow text (`● Launching` while `running`, `✓ Complete` when done, `Ready to launch` when idle), `#fgtl-bar` width = `doneAccounts/totalAccounts`, `#fgtl-pct`, `#fgtl-sent`=`sent`+`skipped` processed / `#fgtl-total`=`totalAccounts`, `#fgtl-accts`, `#fgtl-inv`=`invitesTotal`, `#fgtl-seq` label, summary `#fgtl-sum-sent`/`#fgtl-sum-skip`, and render `status.logs.slice(-15)` into `#fgtl-logbody` via `v3RenderLogLine`. Add `is-monitor` to `#fgtl-card` while running, remove on done.

- [ ] **Step 3: Bind the button + verify end to end**

Bind `#fgtl-go` → `fgtlLaunch`. Reload dev:app. With a test FG sheet + a GoLogin account that matches an employee email, select 1–2 employees and launch. Confirm: card goes Launching → streams `vj-log-line`s → Complete; FG Invites sheet gets Invited rows (no lingering Queued); FG Budgets bumped; only one browser opened at a time.

(If a live LinkedIn run isn't desired during dev, verify the wiring with the engine's behavior by checking `/api/fg/team-launch/status` transitions and the card updates; the send path itself is already proven by the existing `/api/fg/send/start`.)

- [ ] **Step 4: Commit**

```bash
git add public/js/app.js
git commit -m "feat(fg): Team Launch — launch, poll, drive the vj-card live log + summary"
```

---

## Task 7: Drop the old queue UI from the happy path + cleanup

**Files:**
- Modify: `public/js/app.js` (ensure `fgQueue` / old send is unreferenced from the new panel), `public/index.html` (confirm no leftover old FG DOM)

- [ ] **Step 1: Confirm the queue path is unreachable from the UI**

Grep for stale references and dead buttons:

```bash
grep -n "fg-queue-btn\|fgQueue(\|fg-build-btn\|fg-send-btn" public/index.html public/js/app.js
```

Expected: no remaining wired buttons in `#nav-follower-growth`. `fgQueue`/`fgBuild`/`fgSendStart` may remain defined (dead) — leave them; do not delete server `/api/fg/queue` (kept per spec).

- [ ] **Step 2: Full test sweep**

```bash
node --test tests/fg-team-launch.test.js tests/fg-colleagues.test.js
```

Expected: all PASS.

- [ ] **Step 3: Manual verification checklist (per CLAUDE.md, UI has no test suite)**

- Follower Growth panel = Team Launch board (no Build/Queue/Send buttons).
- Auto-pair by email works; unmatched employee → manual GoLogin dropdown.
- Search matches name/email/account; select-all respects search.
- Launch disabled until ≥1 selected employee has a paired profile.
- Live card mirrors the sketch; finish shows correct sent/skipped.
- FG sheet shows Invited rows (no permanent Queued); budgets bumped.

- [ ] **Step 4: Commit**

```bash
git add public/index.html public/js/app.js
git commit -m "chore(fg): retire build/queue/send from the FG happy path (Team Launch is the screen)"
```

---

## Self-Review notes

- **Spec coverage:** filter chips (Task 4/5), match board + search + select-all (4/5), auto-pair by email (5), sequential one-browser engine (2/3), write-back without permanent Queued rows (3 `deps.record`), vj-card live log (4/6), replace old screen (4/7), DNC unchanged (3 reuses `buildFgTargets`), stop/abort (2/3). Colleague roster source (1).
- **No Apps Script change:** `record` reuses `queueFgInvites` + `markFgInvited`; momentary Queued rows are flipped to Invited within the same account step — end state has none.
- **One-browser guarantee:** engine `await handle.close()` in `finally` before the loop advances; `/start` 409s if `_fgTeam.running`.
- **TDZ caution:** `_fgTeamSnap` must be declared before `const deps` in Task 3 Step 2.
