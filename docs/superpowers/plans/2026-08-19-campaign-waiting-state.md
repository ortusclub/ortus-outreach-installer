# Campaign Waiting State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A cloud campaign that cannot send says so — naming the accounts, the real date, and the fact that it is still checking acceptances — and sleeps for as long as it is actually blocked.

**Architecture:** One new engine endpoint answers "given these profile ids, what is blocked and until when", from live Redis TTLs. The app consumes it in two places: the existing Waiting card, and a new Start-time prompt. Separately the engine's 6-hour sleep clamp is deleted so a 4.4-day weekly cap sleeps 4.4 days.

**Tech Stack:** Engine — Node >= 22, ioredis, pg, `node:test` + `node:assert/strict`. App — vanilla HTML/CSS/JS, no bundler, no framework, no test suite.

**Spans TWO repos.** Engine `/Users/antoniovarlese/ortus-salesnav-scraper-cloud`, app `/Users/antoniovarlese/ortus-gologin-clone/.worktrees/fg-sheet-input`. Each task names its repo. Never edit both in one task.

## ⚠️ TASK ORDER IS LOAD-BEARING

Task 2 (app: date-aware wake text) MUST land before Task 3 (engine: delete the sleep clamp).

The app's existing Waiting card formats the wake with `toLocaleTimeString` — hour and minute, **no date** (`public/js/app.js:7690`). That is safe only because `BLOCK_CAP_SEC` caps every sleep at 6 hours. Delete the clamp first and a 4.4-day weekly cap renders as *"stands down until 23:59"*, which an operator reads as tonight when it means Saturday.

Doing Task 3 before Task 2 makes the product lie more than it does today. Do not reorder them.

## Global Constraints

- **Monitoring must keep running throughout.** `blocked_until` gates SENDING only. Weekly cap / 429 / daily limit / note credits do NOT stop monitoring — a capped account can still RECEIVE acceptances. `test-monitor-survives-block.js` (already on engine `main`) must keep passing after every engine task.
- **No new campaign status.** Waiting is DERIVED: `status === 'running' && blocked_until > now`. 51 sites test `status === 'running'`.
- **No schema change.** `blocked_until` already exists. No `blocked_reason` column.
- Engine tests: standalone `test-*.js` at repo root, run individually `node test-foo.js`. No `npm test`. No `--test-force-exit`. macOS has no `timeout` binary — never wrap a test in it.
- Engine tests use `const { test } = require("node:test")` and `const assert = require("node:assert/strict")`.
- `CampaignStore`'s constructor IGNORES an injected `pg` — it builds its own Pool from `pgUrl`. Overwrite `store.pg` AFTER construction in tests.
- App: Bugatti command-deck design system — monochrome, hairlines, **gold ONLY on the Start CTA**, radii 0 or 9999, no other accent colours. Tokens at the top of `public/css/style.css`.
- App has **no test suite**. UI verification is manual via `npm run dev:app`.
- Patch-bump `package.json` and both `index.html` `?v=` before any app relaunch.
- Off-limits, never edit: `src/linkedin/outreach.js`, `src/linkedin/actions.js`.
- Do NOT `git add data/monitoring-campaign.json` in the app repo.
- No `kubectl` write commands. No `./deploy.sh`. Shipping is the operator's call.

---

## File Structure

| Repo | File | Responsibility |
|---|---|---|
| engine | `campaign-api.js` | `GET /api/campaign/preflight` — the single source of per-account block truth |
| engine | `campaign-store.js` | `accountBlockStates(profileIds)` — reads park reason + TTL + needs-login. No policy. |
| engine | `campaign-worker.js` | delete the `BLOCK_CAP_SEC` clamp |
| engine | `server.js` | 15-minute unblock re-check in the scale bridge |
| app | `public/js/app.js` | date-aware wake text; preflight-sourced reasons; second clock; Start modal |
| app | `public/css/style.css` | Waiting tokens |

---

### Task 1: Engine — per-account block state + preflight endpoint

**REPO: `/Users/antoniovarlese/ortus-salesnav-scraper-cloud`**

**Files:**
- Modify: `campaign-store.js` (add `accountBlockStates` after `parkTtl`, ~line 970)
- Modify: `campaign-api.js` (new route ABOVE `/api/campaign/:id`)
- Test: `test-campaign-preflight.js` (create)

**Interfaces:**
- Produces: `async accountBlockStates(profileIds) -> [{ id, reason, until, fixable }]`.
  `reason` is one of `""` (free) | `"weekly"` | `"proxy"` | `"throttle"` | `"session"` | `"needslogin"`.
  `until` is an ISO string, or `null` when there is no clock.
  `fixable` is `true` only for `proxy` and `needslogin`.
- Produces: `GET /api/campaign/preflight?profiles=a,b,c` -> `{ accounts, usable, earliest }`.

- [ ] **Step 1: Write the failing test**

Create `test-campaign-preflight.js`:

```js
// test-campaign-preflight.js
//
// Per-account block truth, read from live Redis TTLs. One endpoint serves both
// surfaces: the Start modal asks about a candidate account set, the Waiting card
// asks about a running campaign's set. Same question.
//
// `fixable` is the field that earns its keep. proxy and needs-login clear in a
// minute of operator work; a weekly cap cannot be fixed at all. Today both
// surface identically — as a dead campaign — which is why an operator cannot tell
// "act now" from "come back Saturday".
//
//   node test-campaign-preflight.js
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const Redis = require("ioredis");
const { CampaignStore } = require("./campaign-store");

const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379", { maxRetriesPerRequest: null });
after(() => redis.quit());

const FREE = "pf-free", WEEK = "pf-weekly", PROXY = "pf-proxy", LOGIN = "pf-login";
const ALL = [FREE, WEEK, PROXY, LOGIN];

function makeStore() {
  const s = new CampaignStore({ pgUrl: "postgres://unused", redis, podId: "test-pod" });
  s.pg = { query: async () => ({ rows: [] }) };
  return s;
}

async function seed() {
  await redis.del(...ALL.map((a) => `cmp:park:${a}`), ...ALL.map((a) => `cmp:needslogin:${a}`));
  await redis.set(`cmp:park:${WEEK}`, "weekly", "EX", 383786);   // real measured TTL, 19 Aug 2026
  await redis.set(`cmp:park:${PROXY}`, "proxy", "EX", 66729);    // real measured TTL
  await redis.set(`cmp:needslogin:${LOGIN}`, String(Date.now()), "EX", 7 * 24 * 3600);
}

test("reports reason and real unblock time per account", async () => {
  await seed();
  const rows = await makeStore().accountBlockStates(ALL);
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));

  assert.equal(by[FREE].reason, "", "a free account reports no reason");
  assert.equal(by[FREE].until, null, "a free account has no clock");

  assert.equal(by[WEEK].reason, "weekly");
  assert.ok(new Date(by[WEEK].until).getTime() > Date.now() + 3 * 24 * 3600 * 1000,
    "weekly park reports its REAL multi-day TTL, not a 6h clamp");

  assert.equal(by[PROXY].reason, "proxy");
  assert.equal(by[LOGIN].reason, "needslogin");
  assert.equal(by[LOGIN].until, null,
    "needs-login has no clock — it is not a wait, it is a task for a human");
});

test("fixable separates 'act now' from 'come back Saturday'", async () => {
  await seed();
  const by = Object.fromEntries((await makeStore().accountBlockStates(ALL)).map((r) => [r.id, r]));
  assert.equal(by[PROXY].fixable, true, "proxy: operator fixes the GoLogin profile and hits Retry");
  assert.equal(by[LOGIN].fixable, true, "needs-login: operator logs back in");
  assert.equal(by[WEEK].fixable, false, "weekly cap: NOTHING to fix, only to wait — must not read as a fault");
  assert.equal(by[FREE].fixable, false, "a free account is not 'fixable', it is fine");
});

test("route is registered above /api/campaign/:id", () => {
  // Express matches in order: registered after /:id, "preflight" is read as a
  // campaign id and the route never fires. Same trap capacity and worker-busy
  // both carry a comment about.
  const src = require("fs").readFileSync(require("path").join(__dirname, "campaign-api.js"), "utf8");
  const pre = src.indexOf('"/api/campaign/preflight"');
  const byId = src.indexOf('"/api/campaign/:id"');
  assert.notEqual(pre, -1, "preflight route not found — did it get renamed?");
  assert.notEqual(byId, -1, "/:id route not found — did it get renamed?");
  assert.ok(pre < byId, "preflight MUST be registered before /api/campaign/:id");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node test-campaign-preflight.js`
Expected: FAIL — `store.accountBlockStates is not a function`

- [ ] **Step 3: Implement the store read**

In `campaign-store.js`, after `parkTtl` (~line 970):

```js
  // Per-account block truth for the app: WHY an account cannot send and WHEN it
  // could again. Read from live Redis TTLs rather than stored anywhere, because a
  // sleeping campaign has no pod to keep a stored copy fresh and a stale reason is
  // worse than none — it is what the monitor-log scrape already gets wrong.
  //
  // `fixable` is the load-bearing field. proxy and needs-login clear in a minute of
  // operator work; a weekly cap cannot be fixed at all, only waited out. Today both
  // reach the operator as the same dead campaign.
  async accountBlockStates(profileIds) {
    const out = [];
    for (const id of profileIds || []) {
      const reason = await this.getParkReason(id);
      if (reason) {
        const ttl = Number(await this.parkTtl(id));
        out.push({
          id, reason,
          until: ttl > 0 ? new Date(Date.now() + ttl * 1000).toISOString() : null,
          fixable: reason === "proxy",
        });
        continue;
      }
      if (await this.isNeedsLogin(id)) {
        // No `until`: this is not a wait, it is a task for a human. Giving it a
        // clock would tell the operator to sit and wait for something that will
        // never clear on its own.
        out.push({ id, reason: "needslogin", until: null, fixable: true });
        continue;
      }
      out.push({ id, reason: "", until: null, fixable: false });
    }
    return out;
  }
```

- [ ] **Step 4: Implement the route**

In `campaign-api.js`, immediately after the `worker-busy` route (~line 300) and well ABOVE `/api/campaign/:id`:

```js
  // Per-account block truth for the app's Waiting card and its Start prompt.
  // MUST stay above /api/campaign/:id — Express matches in order and "preflight"
  // would otherwise be read as a campaign id, exactly like capacity and
  // worker-busy above.
  //
  // 500 on error, never an empty account list: an invented "everything is fine"
  // would let the Start prompt wave through a campaign that cannot send at all.
  app.get("/api/campaign/preflight", async (req, res) => {
    if (need(res)) return;
    try {
      const profiles = String(req.query.profiles || "").split(",").map((s) => s.trim()).filter(Boolean);
      const accounts = await store.accountBlockStates(profiles);
      const usable = accounts.filter((a) => !a.reason).length;
      const clocks = accounts.map((a) => a.until).filter(Boolean).sort();
      res.json({ accounts, usable, earliest: usable ? null : (clocks[0] || null) });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
```

- [ ] **Step 5: Run it to verify it passes**

Run: `node test-campaign-preflight.js`
Expected: PASS, 3 tests

- [ ] **Step 6: Confirm no regression**

Run: `node test-monitor-survives-block.js`
Expected: PASS, 2 tests

- [ ] **Step 7: Commit**

```bash
git add campaign-store.js campaign-api.js test-campaign-preflight.js
git commit -m "feat: per-account block state + preflight endpoint"
```

---

### Task 2: App — date-aware wake text (MUST precede Task 3)

**REPO: `/Users/antoniovarlese/ortus-gologin-clone/.worktrees/fg-sheet-input`**

**Files:**
- Modify: `public/js/app.js:7684-7693` (the existing Waiting branch in `_cloudCurrentAction`)

**Interfaces:**
- Produces: `_wakeWhenText(ms)` — a module-level helper in `app.js`, used again by Task 5.

Read `public/js/app.js:7676-7700` before editing. The Waiting branch already exists; you are amending it, not adding one.

- [ ] **Step 1: Add the helper**

Above `_cloudCurrentAction` in `public/js/app.js`:

```js
// Wake-time text for a blocked campaign. Date-aware ON PURPOSE.
//
// This used to be a bare toLocaleTimeString (hour+minute), which was safe only
// while the engine clamped every sleep to 6 hours. Once a campaign can sleep out
// a real weekly cap (~4.4 days), "until 23:59" reads as tonight when it means
// Saturday — a worse lie than the "Working…" this card was built to replace.
function _wakeWhenText(ms) {
  const d = new Date(ms);
  const now = new Date();
  const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return hm;
  return `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}, ${hm}`;
}
```

- [ ] **Step 2: Use it**

In the Waiting branch, replace:

```js
      const when = new Date(wake).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
```

with:

```js
      const when = _wakeWhenText(wake);
```

- [ ] **Step 3: Verify manually**

Bump `package.json` patch version and both `index.html` `?v=` query strings, then:

```bash
pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "Electron.*ortus" 2>/dev/null
npm run dev:app > /tmp/dev-app.log 2>&1 &
```

In the Electron window's devtools console, check both branches directly — this needs no live campaign:

```js
_wakeWhenText(Date.now() + 2 * 3600 * 1000)      // → "14:30"   (same day, bare time)
_wakeWhenText(Date.now() + 4.4 * 24 * 3600 * 1000) // → "Sat 23 Aug, 23:59"
```

Expected: the multi-day case carries a **date**. That is the whole point of this task.

- [ ] **Step 4: Commit**

```bash
git add public/js/app.js package.json public/index.html
git commit -m "fix: date-aware wake text so a multi-day block cannot read as tonight"
```

---

### Task 3: Engine — sleep to the real unblock time

**REPO: `/Users/antoniovarlese/ortus-salesnav-scraper-cloud`**

**DO NOT START until Task 2 is committed.** See "TASK ORDER IS LOAD-BEARING" above.

**Files:**
- Modify: `campaign-worker.js` (`_maybeSleepCampaign`, ~line 869)
- Test: `test-campaign-sleep-real-ttl.js` (create)

- [ ] **Step 1: Write the failing test**

Create `test-campaign-sleep-real-ttl.js`:

```js
// test-campaign-sleep-real-ttl.js
//
// A campaign whose accounts are all blocked should sleep for as long as they are
// ACTUALLY blocked. BLOCK_CAP_SEC clamped every sleep to 6h, so a 4.4-day weekly
// cap woke a pod ~4x a day for 4.4 days to rediscover the same wall.
//
// BLOCK_FLOOR_SEC stays. Its comment records a real bug: the session bench is
// exactly 30 minutes and the floor is exactly 30 minutes, so `>` (rather than
// `>=`) meant a campaign whose only blocker was a benched account never slept —
// it woke every half hour, all night. Campaign f5ccb53d, 17-18 Aug: 20 hours
// awake, blocked_until still NULL.
//
//   node test-campaign-sleep-real-ttl.js
const { test } = require("node:test");
const assert = require("node:assert/strict");

const HOUR = 3600;

test("a multi-day park sleeps multi-day, not 6h", () => {
  const { clampSleepSec } = require("./campaign-worker");
  const weekly = 4.4 * 24 * HOUR;
  assert.ok(clampSleepSec(weekly) > 24 * HOUR,
    "a 4.4-day weekly cap must not be clamped to 6h — that is ~18 pointless pod wakes");
  assert.equal(clampSleepSec(weekly), weekly, "sleep exactly as long as the block actually lasts");
});

test("the 30-minute floor still holds", () => {
  const { clampSleepSec } = require("./campaign-worker");
  assert.equal(clampSleepSec(20 * 60), 0, "below the floor: do not sleep, stay responsive");
  assert.equal(clampSleepSec(30 * 60), 30 * 60,
    ">= not >: the session bench is EXACTLY 30 min and so is the floor — `>` meant it never slept");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node test-campaign-sleep-real-ttl.js`
Expected: FAIL — `clampSleepSec is not a function`

- [ ] **Step 3: Implement**

In `campaign-worker.js`, replace the `BLOCK_CAP_SEC` constant and extract the decision so it is testable without a DB. Delete `const BLOCK_CAP_SEC = 6 * 3600;` and add near `BLOCK_FLOOR_SEC`:

```js
// How long to sleep, given the seconds until the earliest account frees up.
// 0 means "do not sleep".
//
// There is deliberately NO upper clamp. There used to be a 6h cap, which meant a
// 4.4-day weekly park slept 6h, woke a pod, rediscovered the same 4-day wall and
// slept again — ~4 wakes a day for 4.4 days. The unblock estimate comes from the
// real Redis TTL, so it is as good as the park itself; capping it did not make it
// safer, only more expensive. Early wake-ups (unbenchAccount, account edits, the
// frontend's 15-min re-check) are what protect against an over-long sleep.
function clampSleepSec(secs) {
  return secs >= BLOCK_FLOOR_SEC ? secs : 0;
}
```

Then in `_maybeSleepCampaign` replace:

```js
    if (!(secs >= BLOCK_FLOOR_SEC)) return;
    const until = new Date(Date.now() + Math.min(secs, BLOCK_CAP_SEC) * 1000);
```

with:

```js
    const sleepFor = clampSleepSec(secs);
    if (!sleepFor) return;
    const until = new Date(Date.now() + sleepFor * 1000);
```

Export `clampSleepSec` from `campaign-worker.js`'s `module.exports`.

- [ ] **Step 4: Fix the sleep message**

The existing `_evt` line renders `until.toISOString().slice(11, 16)` — **hour and minute only**, the same date-blind bug Task 2 fixed in the app. Replace that line's time expression with a date-carrying form:

```js
    const untilTxt = until.toISOString().slice(0, 16).replace("T", " ") + " UTC";
```

and use `${untilTxt}` in the message.

- [ ] **Step 5: Run tests**

Run: `node test-campaign-sleep-real-ttl.js` → PASS, 2 tests
Run: `node test-monitor-survives-block.js` → PASS, 2 tests
Run: `node test-campaign-parkedmodes.js` → PASS (nearest existing coverage of park behaviour)

- [ ] **Step 6: Commit**

```bash
git add campaign-worker.js test-campaign-sleep-real-ttl.js
git commit -m "feat: sleep to the real unblock time, not a 6h clamp"
```

---

### Task 4: Engine — early wake

**REPO: `/Users/antoniovarlese/ortus-salesnav-scraper-cloud`**

**Files:**
- Modify: `campaign-store.js` (`unbenchAccount`, line 810)
- Modify: `server.js` (scale-bridge tick)
- Test: `test-campaign-unblock-hooks.js` (create)

**Interfaces:**
- Consumes: `clearCampaignBlocked(id)` (already exists, `campaign-store.js:156`).
- Produces: `async clearBlockedForAccount(account)` — clears `blocked_until` on every running campaign holding that profile id.

- [ ] **Step 1: Write the failing test**

Create `test-campaign-unblock-hooks.js`:

```js
// test-campaign-unblock-hooks.js
//
// A campaign may now sleep for days. That is only safe if the things which make
// it workable again wake it immediately — otherwise an operator fixes an account
// and watches nothing happen until Saturday.
//
//   node test-campaign-unblock-hooks.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { CampaignStore } = require("./campaign-store");

function makeStore(capture) {
  const s = new CampaignStore({
    pgUrl: "postgres://unused",
    redis: { del: async () => 1 },
    podId: "test-pod",
  });
  s.pg = { query: async (sql, params) => { capture.push({ sql: sql.replace(/\s+/g, " "), params }); return { rows: [] }; } };
  return s;
}

test("clearing an account's bench wakes the campaigns holding it", async () => {
  const capture = [];
  await makeStore(capture).clearBlockedForAccount("acct-1");
  const upd = capture.find((c) => /UPDATE campaigns/.test(c.sql) && /blocked_until=NULL/.test(c.sql));
  assert.ok(upd, "an operator who fixes an account must not then wait out the original estimate");
  assert.ok(upd.params.includes("acct-1"), "scoped to the campaigns holding THAT account");
});

test("unbenchAccount performs the wake as part of the same operation", async () => {
  const capture = [];
  const s = makeStore(capture);
  await s.unbenchAccount("acct-1");
  assert.ok(capture.some((c) => /blocked_until=NULL/.test(c.sql)),
    "Retry clears the park AND the campaign sleep — clearing only the park leaves the campaign asleep on a stale estimate");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node test-campaign-unblock-hooks.js`
Expected: FAIL — `store.clearBlockedForAccount is not a function`

- [ ] **Step 3: Implement**

In `campaign-store.js`, add before `unbenchAccount`:

```js
  // Wake every running campaign that holds this account. Called whenever the
  // account becomes workable again — a campaign may now sleep for DAYS, so
  // without this an operator fixes a profile, hits Retry, and watches nothing
  // happen until the original estimate elapses.
  //
  // Deliberately only touches campaigns that are actually asleep, so this can
  // never disturb a running one.
  async clearBlockedForAccount(account) {
    await this.pg.query(
      `UPDATE campaigns SET blocked_until=NULL, updated_at=now()
        WHERE blocked_until IS NOT NULL
          AND status IN ('queued','running')
          AND profile_ids ? $1`,
      [account]
    );
  }
```

Then in `unbenchAccount` (line 810), after the existing `redis.del(...)`:

```js
    // Best-effort: never let a Postgres blip stop the Redis unbench that the
    // operator actually pressed Retry for.
    try { await this.clearBlockedForAccount(account); } catch (_) {}
```

- [ ] **Step 4: Wake on accounts being ADDED to a campaign**

Third trigger from the spec, and the one most easily missed. An operator whose campaign is asleep for four days may fix it by adding a fresh account rather than by repairing a capped one — new capacity appeared, so the stored estimate is now wrong.

Find the route that edits a campaign's `profile_ids` (the counterpart of `removeCloudCampaignAccount`, which the app calls at `public/js/app.js:8113`). After the update succeeds, add:

```js
    // Accounts were added, so the stored blocked_until was computed against a set
    // that no longer exists. Clear it and let the next poll recompute — a fresh
    // account is the fastest possible unblock and must not wait out an estimate
    // made before it existed.
    try { await store.clearCampaignBlocked(campaignId); } catch (_) {}
```

Removing an account cannot make a campaign MORE workable, so this belongs on the add path only.

- [ ] **Step 5: Add the 15-minute re-check**

In `server.js`, in the existing scale-bridge interval, gate this on a tick counter so it runs every 15 minutes rather than every tick:

```js
// Pull a sleeping campaign's wake-up IN when reality beat the estimate — a park
// cleared by a path that does not route through unbenchAccount, or a TTL that
// simply expired sooner than computed. Worst case becomes 15 minutes of
// not-sending instead of days.
//
// It may ONLY pull the wake-up IN, never push it out. Pushing out on a stale read
// would let a transient Redis hiccup extend an operator's wait, which is the exact
// failure this whole plan exists to remove.
_unblockTick = (_unblockTick + 1) % 60;                 // scale bridge runs ~15s
if (_unblockTick === 0) {
  try {
    const { rows } = await store.pg.query(
      `SELECT id, profile_ids, blocked_until FROM campaigns
        WHERE blocked_until IS NOT NULL AND blocked_until > now()
          AND status IN ('queued','running')`
    );
    for (const c of rows) {
      const states = await store.accountBlockStates(c.profile_ids || []);
      const anyFree = states.some((s) => !s.reason);
      const clocks = states.map((s) => s.until).filter(Boolean).sort();
      const earliest = clocks[0] ? new Date(clocks[0]).getTime() : null;
      // Wake if ANY account is usable now, or if the real earliest unblock is
      // sooner than what we stored. Note the strict `<`: equal estimates must not
      // churn a write every 15 minutes.
      if (anyFree || (earliest !== null && earliest < new Date(c.blocked_until).getTime())) {
        await store.clearCampaignBlocked(c.id);
      }
    }
  } catch (_) { /* a blip here must never disturb the scale bridge */ }
}
```

Declare `let _unblockTick = 0;` beside the scale-bridge's other module-level state.

- [ ] **Step 6: Run tests**

Run: `node test-campaign-unblock-hooks.js` → PASS, 2 tests
Run: `node test-monitor-survives-block.js` → PASS
Run: `node test-campaign-scalebridge.js` → PASS (server.js touched)

- [ ] **Step 7: Commit**

```bash
git add campaign-store.js server.js test-campaign-unblock-hooks.js
git commit -m "feat: wake a sleeping campaign when its accounts become workable"
```

---

### Task 5: App — Waiting card with real reasons and the second clock

**REPO: `/Users/antoniovarlese/ortus-gologin-clone/.worktrees/fg-sheet-input`**

**Files:**
- Modify: `public/js/app.js` (the Waiting branch in `_cloudCurrentAction`, ~7684)
- Modify: `public/css/style.css` (Waiting tokens)

**Interfaces:**
- Consumes: `GET /api/campaign/preflight?profiles=…` from Task 1; `_wakeWhenText` from Task 2.

- [ ] **Step 1: Fetch preflight for the campaign's accounts**

The existing `why` comes from `_cloudWaitingReason(d.monitorLog)` — scraping the monitor log, which the engine's own comment says goes stale within 15 minutes. Replace it with a preflight call keyed on the campaign's `profile_ids`, cached per campaign for 60s so the 5s poller does not hammer the endpoint.

- [ ] **Step 2: Build the summary line**

Group the preflight rows by reason and lead with the FIXABLE ones, because those are the only ones the operator can act on:

- all capped → `5 accounts capped until Sat 23 Aug`
- mixed → `1 account needs re-login, 4 capped until Sat 23 Aug`
- single → `1 account capped until Sat 23 Aug`

- [ ] **Step 3: Add the second clock**

The card must state that monitoring is still alive, because it is. Weekly cap does not stop acceptance checks — only proxy park, needs-login and the busy lock skip an account in a sweep. Render:

```
Not sending — 5 accounts capped until Sat 23 Aug
Still checking acceptances hourly · next check 14:12
```

`next_check_at` is already available on the card (`app.js:3927 showWaiting`). Without this line an operator reads Waiting as "stopped" and may cancel a campaign that is still collecting acceptances and firing intros.

- [ ] **Step 4: Style it**

In `public/css/style.css`, near the existing status tokens: Waiting is **grey (`--gray`), never red**. A weekly cap is not a fault and there is nothing to fix. Red is reserved for proxy / needs-login, which a human clears in a minute. That distinction is the point of the whole card. No new accent colours; gold stays reserved for the Start CTA.

- [ ] **Step 5: Verify manually**

Bump `package.json` and both `index.html` `?v=`, relaunch `npm run dev:app`, and check against the real blocked campaign state (as of 19 Aug: `cmp:park:*` shows 13 weekly, 1 proxy). Confirm: a date appears, the reason names accounts, and the monitoring line is present.

- [ ] **Step 6: Commit**

```bash
git add public/js/app.js public/css/style.css package.json public/index.html
git commit -m "feat: Waiting card shows real per-account reasons and the monitoring clock"
```

---

### Task 6: App — Start-time prompt when nothing can send

**REPO: `/Users/antoniovarlese/ortus-gologin-clone/.worktrees/fg-sheet-input`**

**Files:**
- Modify: `public/js/app.js` (the `/api/campaign/start-cloud` path, ~line 11669)

Sketch to match: `public/sketches/2026-08-19-waiting-state-variants.html`, variant B. Open it with `npx http-server public -p 8850` and read it before building.

- [ ] **Step 1: Gate the cloud start**

Before `fetch('/api/campaign/start-cloud', …)` at ~11669, call preflight with the selected profile ids. When `usable > 0`, proceed exactly as today — no prompt, no change.

- [ ] **Step 2: Build the modal for `usable === 0`**

Per the sketch: title **"Nothing can send yet"**, every account listed with its reason, fixable ones (proxy / re-login) visually separated from just-wait (weekly cap), and an explicit line that acceptance checking still runs on the capped accounts.

Three buttons — **Back** / **Start anyway** / **Fix accounts**. Three because "start anyway" is legitimate: the leads send themselves when the cap lifts. Forcing a single path is what makes prompts hated.

- [ ] **Step 3: Fail open**

If preflight errors or times out, **do not block the start**. A campaign that cannot start because a diagnostic endpoint is down is worse than one that starts into a wait.

- [ ] **Step 4: Verify manually**

Relaunch and try starting a cloud campaign whose accounts are all capped. Confirm the modal lists them with dates, that "Start anyway" proceeds, and that a campaign with at least one free account shows **no** modal.

- [ ] **Step 5: Commit**

```bash
git add public/js/app.js package.json public/index.html
git commit -m "feat: tell the operator at Start when no account can send"
```

---

## Verification

- [ ] `node test-campaign-preflight.js` — PASS (3)
- [ ] `node test-campaign-sleep-real-ttl.js` — PASS (2)
- [ ] `node test-campaign-unblock-hooks.js` — PASS (2)
- [ ] `node test-monitor-survives-block.js` — PASS (2) — the campaign still sweeps while asleep
- [ ] `node test-monitor-backoff.js` — PASS (10)
- [ ] `node test-campaign-scalebridge.js` — PASS
- [ ] Manual: a multi-day block renders a **date**, not a bare time
- [ ] Manual: the Waiting card names accounts and shows the monitoring clock
- [ ] Manual: Start prompt appears only when `usable === 0`, and fails open

**Not done by this plan:** `./deploy.sh`, any `kubectl apply`, and any push. Shipping is the operator's call.

## Out of scope

Local `src/campaign.js` sleeping/monitoring. The account-picker warning (variant C in the sketch). `pushed 0, failed 200`. Pod capacity / KEDA / `cooldownPeriod` (measured as not the constraint; `cooldownPeriod: 90` is committed on engine `main` and deliberately not applied). Account supply itself — 13 weekly-capped accounts is a LinkedIn limit; this plan makes the wait legible, not shorter.
