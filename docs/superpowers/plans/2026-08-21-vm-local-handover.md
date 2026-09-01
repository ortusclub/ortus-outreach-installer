# VM ↔ Local Campaign Handover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator move a live campaign between the cloud VM and their own Mac at any point (sending, checking, monitoring), with exactly one owner at all times.

**Architecture:** Ownership is one persisted field, `runs_on ∈ {vm, local}`. Both sides refuse to act on a campaign they do not own. The move itself generalises the shipped `edit-redispatch` pattern: stop side A, confirm it stopped, read what the sheet says is already done, resume the remainder on side B excluding those leads, reset the check cadence.

**Tech Stack:** Engine = Node CommonJS + Postgres, standalone `test-*.js` run individually. App = Node ESM + Express 4 + vanilla JS frontend, `node --test tests/*.test.js`.

**Spec:** `docs/superpowers/specs/2026-08-21-vm-local-handover-design.md`

## Global Constraints

- **Never a second intro DM.** Handover is strictly serialised: the target side MUST NOT begin until the source side is confirmed stopped and any in-flight sweep has ended. If the source cannot be confirmed stopped, the handover ABORTS and the campaign stays where it was. Never proceed on a maybe. This rule may not be relaxed for speed.
- **Exactly one owner at all times.** Both sides read `runs_on` before acting.
- The in-flight lead is treated as pending and retried on the new side (operator's explicit decision, accepting a possible duplicate connect request).
- The adaptive check cadence RESETS on every switch: `empty_check_streak = 0`, next check recomputed from now at the operator's base interval.
- A campaign moved local STAYS local. No auto-fallback to the VM. The card must show it is waiting on the laptop, never look stalled.
- **Off-limits files, never modify:** `src/linkedin/outreach.js`, `src/linkedin/actions.js`. Read them freely.
- Never `git add data/monitoring-campaign.json`.
- No em dashes in any operator-visible copy. Use commas or colons. (Literal sheet values like `Failed — …` stay verbatim.)
- Engine cadence rule to mirror exactly: factor 1 below streak 3, ×2 at 3-5, ×4 at 6+, capped at 240 min but NEVER returning a cadence shorter than the operator's own interval (`Math.max(base, Math.min(base * factor, 240))`).
- Two repos. Engine tasks land in `/Users/antoniovarlese/ortus-salesnav-scraper-cloud` on `main` (deploy.sh commits and pushes main, so a feature branch breaks the deploy step). App tasks land in `/Users/antoniovarlese/ortus-gologin-clone/.worktrees/fg-sheet-input` on `fg-sheet-input-3117`.

---

### Task 1: Engine — the `runs_on` column

**Files:**
- Modify: `db/campaigns-schema.sql` (append beside the other `ADD COLUMN IF NOT EXISTS` lines, ~line 149)
- Modify: `campaign-store.js` (beside `setEmptyCheckStreak`)
- Test: `test-campaign-runs-on.js` (new)

**Interfaces:**
- Consumes: nothing.
- Produces: `store.setRunsOn(campaignId, side)` where `side ∈ {'vm','local'}`; campaigns read back with `c.runs_on`, defaulting to `'vm'`.

- [ ] **Step 1: Add the column**

```sql
-- Which side currently OWNS this campaign: 'vm' (the cloud worker) or 'local'
-- (the operator's Mac). Exactly one owner at all times. Every actor checks this
-- before acting, so a handed-over campaign is never worked by both sides at once
-- (which is the only way two intro DMs can reach the same lead: both sweeps see a
-- blank Introduction Status before either has stamped it).
-- Defaults to 'vm' because every campaign that exists today was cloud-dispatched.
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS runs_on TEXT NOT NULL DEFAULT 'vm';
```

- [ ] **Step 2: Add the store setter**

```js
  // Move ownership of a campaign between the cloud worker and the operator's
  // machine. Rejects anything that is not one of the two known sides rather than
  // writing a value every ownership guard would then treat as "not mine".
  async setRunsOn(campaignId, side) {
    const v = side === "local" ? "local" : side === "vm" ? "vm" : null;
    if (!v) throw new Error(`runs_on must be 'vm' or 'local', got ${JSON.stringify(side)}`);
    await this.pg.query(`UPDATE campaigns SET runs_on=$2 WHERE id=$1`, [campaignId, v]);
    return v;
  }
```

- [ ] **Step 3: Write the test**

```js
// test-campaign-runs-on.js
//
// Ownership of a campaign: 'vm' (cloud worker) or 'local' (operator's Mac).
// Real SQL against the local dev Postgres, because what matters is that the
// column exists, defaults to 'vm' for every campaign that already exists, and
// round-trips.
//
// Run:  node --test test-campaign-runs-on.js
const test = require("node:test");
const assert = require("node:assert");
const { CampaignStore } = require("./campaign-store");

const PG = process.env.TEST_PG_URL || "postgres://postgres:dev@localhost:5433/campaigns";

test("runs_on defaults to vm, round-trips, and refuses anything else", async (t) => {
  const store = new CampaignStore({ pgUrl: PG });
  await store.migrate();
  const id = "test-runson-" + process.pid;
  await store.pg.query("DELETE FROM campaigns WHERE id=$1", [id]);
  await store.pg.query(
    `INSERT INTO campaigns (id, name, mode, owner, status) VALUES ($1,'runs_on test','connect_only','t@t','monitoring')`,
    [id]
  );
  t.after(async () => {
    await store.pg.query("DELETE FROM campaigns WHERE id=$1", [id]);
    await store.close?.();
  });

  assert.equal((await store.getCampaign(id)).runs_on, "vm",
    "every campaign that exists today was cloud-dispatched, so vm is the only safe default");

  await store.setRunsOn(id, "local");
  assert.equal((await store.getCampaign(id)).runs_on, "local");

  await store.setRunsOn(id, "vm");
  assert.equal((await store.getCampaign(id)).runs_on, "vm");

  await assert.rejects(() => store.setRunsOn(id, "laptop"),
    /runs_on must be/,
    "a typo'd side must fail loudly, not write a value every guard reads as 'not mine'");
  assert.equal((await store.getCampaign(id)).runs_on, "vm", "the rejected write changed nothing");
});
```

- [ ] **Step 4: Run it**

Run: `node --test test-campaign-runs-on.js`
Expected: PASS, 1 test.

- [ ] **Step 5: Commit**

```bash
git add db/campaigns-schema.sql campaign-store.js test-campaign-runs-on.js
git commit -m "feat(engine): campaigns carry which side owns them"
```

---

### Task 2: Engine — the ownership guard

**Files:**
- Modify: `campaign-monitor-tick.js` (add `ownsCampaign`, guard `monitoringTick`'s loop, add to `module.exports`)
- Test: `test-campaign-ownership-guard.js` (new)

**Interfaces:**
- Consumes: `c.runs_on` from Task 1.
- Produces: `ownsCampaign(campaign)` exported from `campaign-monitor-tick.js` (NOT campaign-monitor.js), returns boolean.

- [ ] **Step 1: Write the failing test**

```js
// test-campaign-ownership-guard.js
//
// The VM must not sweep a campaign the operator has taken onto their own Mac.
// Without this guard, a handed-over monitoring campaign is swept by BOTH sides,
// and two sweeps can each see the same lead as newly-Connected with a blank
// Introduction Status before either has stamped it — two intro DMs to one person,
// which is the one outcome the operator ruled out.
//
// Run:  node --test test-campaign-ownership-guard.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { ownsCampaign, monitoringTick } = require("./campaign-monitor-tick");

test("the VM owns a campaign whose runs_on is vm, or absent (older rows)", () => {
  assert.equal(ownsCampaign({ runs_on: "vm" }), true);
  assert.equal(ownsCampaign({}), true, "a row written before this column existed is the VM's");
});

test("the VM does not own a campaign running on the operator's Mac", () => {
  assert.equal(ownsCampaign({ runs_on: "local" }), false);
});

test("the tick arms no task for a locally-owned campaign", async () => {
  const armed = [];
  const store = {
    getMonitoringCampaigns: async () => ([
      { id: "vm-one", runs_on: "vm", next_check_at: new Date(0).toISOString(), monitoring_until: new Date(Date.now() + 8.64e7).toISOString(), auto_checks_enabled: true },
      { id: "local-one", runs_on: "local", next_check_at: new Date(0).toISOString(), monitoring_until: new Date(Date.now() + 8.64e7).toISOString(), auto_checks_enabled: true },
    ]),
    armMonitorTask: async (id) => { armed.push(id); return true; },
    setMonitorState: async () => {}, setCampaignStatus: async () => {}, clearMonitorTask: async () => {},
  };
  await monitoringTick({ store });
  assert.deepEqual(armed, ["vm-one"],
    "both are overdue; only the VM-owned one may be swept");
});
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `node --test test-campaign-ownership-guard.js`
Expected: FAIL, `ownsCampaign is not a function`.

- [ ] **Step 3: Implement the guard**

In `campaign-monitor-tick.js`, above `monitoringTick`:

```js
// Does the cloud worker own this campaign? An absent value means the row predates
// the column, and every campaign that existed then was cloud-dispatched.
//
// This is the concurrency rule the never-a-second-intro requirement rests on: a
// campaign the operator has taken onto their Mac must not also be swept here.
// Introduction Status only dedups intros AFTER one side has stamped it; two
// concurrent sweeps both read it blank.
function ownsCampaign(c) {
  return !c || !c.runs_on || c.runs_on === "vm";
}
```

Inside `monitoringTick`'s loop, as the first statement of the body:

```js
    if (!ownsCampaign(c)) continue;
```

Add `ownsCampaign` to the `module.exports` list.

- [ ] **Step 4: Run it, confirm it passes**

Run: `node --test test-campaign-ownership-guard.js`
Expected: PASS, 3 tests.

- [ ] **Step 5: Run the neighbours**

Run: `node --test test-campaign-monitor-tick.js test-campaign-monitor.js test-monitor-manual-mark-race.js`
Expected: all pass, no count regression.

- [ ] **Step 6: Commit**

```bash
git add campaign-monitor-tick.js test-campaign-ownership-guard.js
git commit -m "feat(engine): the VM refuses to sweep a campaign running on the operator's Mac"
```

---

### Task 3: Engine — the release endpoint

**Files:**
- Modify: `campaign-api.js` (beside `/api/campaign/:id/stop`, ~line 502)
- Test: `test-campaign-handover-release.js` (new)

**Interfaces:**
- Consumes: `store.setRunsOn` (Task 1), `store.getCampaign`, `store.clearMonitorTask`, `store.getMonitorTaskState`.
- Produces: `POST /api/campaign/:id/handover-release` → `{ ok: true, released: true, status }` or `{ ok: false, reason: 'sweep_in_flight' }` with HTTP 409.

- [ ] **Step 1: Write the failing test**

```js
// test-campaign-handover-release.js
//
// The engine half of a handover: give up ownership, but ONLY once nothing is
// mid-sweep. Reporting "released" while a sweep is still claimed would let the
// operator's Mac start while the VM is still working the same leads, which is
// exactly how one lead gets two intro DMs.
//
// Run:  node --test test-campaign-handover-release.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { mountCampaignApi } = require("./campaign-api");

// campaign-api requires only http + pure modules, and mountCampaignApi never runs
// at module scope, so a fake `app` captures the real handler.
function mount(store) {
  const routes = new Map();
  const app = { get: (p, h) => routes.set(`GET ${p}`, h), post: (p, h) => routes.set(`POST ${p}`, h) };
  mountCampaignApi(app, store, { log: () => {} });
  return routes;
}
function reply() {
  const r = { code: 200, body: null };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}

test("a campaign with no sweep in flight is released to local", async () => {
  const calls = [];
  const store = {
    getCampaign: async () => ({ id: "c1", status: "monitoring", runs_on: "vm" }),
    getMonitorTaskState: async () => ({ status: "pending" }),
    setCampaignStatus: async (...a) => calls.push(["status", ...a]),
    clearMonitorTask: async (...a) => calls.push(["clearTask", ...a]),
    setRunsOn: async (...a) => calls.push(["runsOn", ...a]),
    setEmptyCheckStreak: async (...a) => calls.push(["streak", ...a]),
  };
  const h = mount(store).get("POST /api/campaign/:id/handover-release");
  const res = reply();
  await h({ params: { id: "c1" }, query: {}, body: {} }, res);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.released, true);
  assert.ok(calls.some(([k, , v]) => k === "runsOn" && v === "local"),
    "ownership must actually move, not just be reported as moved");
});

test("a campaign mid-sweep is REFUSED, and keeps its ownership", async () => {
  const calls = [];
  const store = {
    getCampaign: async () => ({ id: "c1", status: "monitoring", runs_on: "vm" }),
    getMonitorTaskState: async () => ({ status: "claimed" }),   // a pod is sweeping right now
    setCampaignStatus: async (...a) => calls.push(["status", ...a]),
    clearMonitorTask: async (...a) => calls.push(["clearTask", ...a]),
    setRunsOn: async (...a) => calls.push(["runsOn", ...a]),
    setEmptyCheckStreak: async () => {},
  };
  const h = mount(store).get("POST /api/campaign/:id/handover-release");
  const res = reply();
  await h({ params: { id: "c1" }, query: {}, body: {} }, res);
  assert.equal(res.code, 409);
  assert.equal(res.body.reason, "sweep_in_flight");
  assert.ok(!calls.some(([k]) => k === "runsOn"),
    "a refused release must not move ownership — the caller aborts and the campaign stays put");
});
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `node --test test-campaign-handover-release.js`
Expected: FAIL, the route is not registered.

- [ ] **Step 3: Implement the route**

```js
  // ── handover: give up ownership to the operator's machine ──────────────────
  // The engine half of "move this campaign to my Mac". Deliberately REFUSES while
  // a monitor task is claimed: a claimed row means a pod has a browser open on
  // these very leads. Releasing then would let the Mac start alongside it, and two
  // concurrent sweeps both read Introduction Status blank — two intro DMs to one
  // person, the outcome the operator ruled out. The caller aborts on this 409 and
  // leaves the campaign where it is.
  app.post("/api/campaign/:id/handover-release", async (req, res) => {
    if (need(res)) return;
    try {
      const c = await store.getCampaign(req.params.id);
      if (!c) return res.status(404).json({ error: "not found" });

      const task = await (store.getMonitorTaskState ? store.getMonitorTaskState(req.params.id) : null);
      if (task && task.status === "claimed") {
        return res.status(409).json({ ok: false, reason: "sweep_in_flight" });
      }

      // Stop claiming work here BEFORE moving ownership, so there is no instant in
      // which the row is local-owned yet still in the VM's active-send set.
      if (c.status === "running" || c.status === "paused") {
        await store.setCampaignStatus(req.params.id, "cancelled");
      }
      try { await store.clearMonitorTask(req.params.id); } catch (_) { /* best-effort */ }
      await store.setRunsOn(req.params.id, "local");
      // The operator moved it because they want to see something happen: the
      // adaptive backoff re-earns itself on the new side from scratch.
      try { await store.setEmptyCheckStreak(req.params.id, 0); } catch (_) { /* best-effort */ }

      log(`campaign ${req.params.id} → released to local`);
      res.json({ ok: true, released: true, status: c.status });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });
```

- [ ] **Step 4: Run it, confirm it passes**

Run: `node --test test-campaign-handover-release.js`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit (do NOT deploy — the app half lands first)**

```bash
git add campaign-api.js test-campaign-handover-release.js
git commit -m "feat(engine): release a campaign to the operator's machine, refusing mid-sweep"
```

---

### Task 4: App — the local side gets the adaptive cadence

**Files:**
- Create: `src/monitoring-cadence.js`
- Modify: `src/campaign.js` (the `finally` that reschedules in `tickMonitoringNow`, ~line 6044-6072)
- Test: `tests/monitoring-cadence.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `checkCadenceMin({ baseMin, emptyStreak })` and `nextEmptyStreak({ newlyAccepted, current })`, byte-identical in behaviour to the engine's `campaign-monitor.js` versions.

**Context:** measured 2026-08-21, `src/campaign.js` has NO empty-check streak. The 1h → 2h → 4h backoff shipped yesterday lives only in the engine. Without this task, a monitoring campaign moved local silently loses the feature.

- [ ] **Step 1: Write the failing test**

```js
// The local half of the adaptive check cadence.
//
// Ported from the engine's campaign-monitor.js so a campaign moved onto the
// operator's Mac keeps backing off instead of silently returning to hourly
// forever. Same thresholds, same cap, same critical property: the cap must never
// hand back a cadence SHORTER than the operator's own interval.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCadenceMin, nextEmptyStreak } from '../src/monitoring-cadence.js';

test('a campaign still finding acceptances is never slowed', () => {
  assert.equal(checkCadenceMin({ baseMin: 60, emptyStreak: 0 }), 60);
  assert.equal(checkCadenceMin({ baseMin: 60, emptyStreak: 2 }), 60);
});

test('three empty sweeps double it, six quadruple it', () => {
  assert.equal(checkCadenceMin({ baseMin: 60, emptyStreak: 3 }), 120);
  assert.equal(checkCadenceMin({ baseMin: 60, emptyStreak: 5 }), 120);
  assert.equal(checkCadenceMin({ baseMin: 60, emptyStreak: 6 }), 240);
  assert.equal(checkCadenceMin({ baseMin: 60, emptyStreak: 99 }), 240);
});

test('the cap never returns LESS than the operator asked for', () => {
  // The bug this exact assertion caught in the engine: a 6h campaign was being
  // checked MORE often for going quiet.
  assert.equal(checkCadenceMin({ baseMin: 360, emptyStreak: 3 }), 360);
  assert.equal(checkCadenceMin({ baseMin: 720, emptyStreak: 6 }), 720);
});

test('a missing or nonsense base falls back to hourly', () => {
  assert.equal(checkCadenceMin({ emptyStreak: 0 }), 60);
  assert.equal(checkCadenceMin({ baseMin: 0, emptyStreak: 9 }), 240);
});

test('any acceptance resets the streak, otherwise it advances', () => {
  assert.equal(nextEmptyStreak({ newlyAccepted: 1, current: 8 }), 0);
  assert.equal(nextEmptyStreak({ newlyAccepted: 0, current: 8 }), 9);
  assert.equal(nextEmptyStreak({ current: -3 }), 1, 'a corrupt streak never goes negative');
});
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `node --test tests/monitoring-cadence.test.js`
Expected: FAIL, cannot resolve `../src/monitoring-cadence.js`.

- [ ] **Step 3: Write the module**

```js
// The adaptive acceptance-check cadence, local half.
//
// Ported from the engine's campaign-monitor.js (checkCadenceMin / nextEmptyStreak)
// so a campaign moved onto the operator's Mac keeps the same behaviour. Kept as a
// separate module, not inlined into campaign.js, so the two implementations can be
// diffed against each other: every cloud bug this project has had was a divergence
// between a local primitive and its VM copy.
//
// Checks cost a real LinkedIn login on every account, and on a quiet campaign
// almost all of them find nothing. So: base interval below 3 consecutive empty
// sweeps, doubled at 3-5, quadrupled at 6+, and any acceptance resets it.

export const CHECK_CADENCE_CAP_MIN = 240;

export function checkCadenceMin({ baseMin, emptyStreak } = {}) {
  const base = Number(baseMin) > 0 ? Number(baseMin) : 60;
  const n = Math.max(0, Number(emptyStreak) || 0);
  const factor = n >= 6 ? 4 : n >= 3 ? 2 : 1;
  if (factor === 1) return base;
  // Math.max, not Math.min alone: the cap must never return a cadence SHORTER
  // than the operator's own interval. A 6h campaign checked every 4h for going
  // quiet is the opposite of the intent.
  return Math.max(base, Math.min(base * factor, CHECK_CADENCE_CAP_MIN));
}

export function nextEmptyStreak({ newlyAccepted = 0, current = 0 } = {}) {
  if ((Number(newlyAccepted) || 0) > 0) return 0;
  return Math.max(0, Number(current) || 0) + 1;
}
```

- [ ] **Step 4: Run it, confirm it passes**

Run: `node --test tests/monitoring-cadence.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Wire it into the monitoring tick**

In `src/campaign.js`, import at the top beside the other `./monitoring-*` imports:

```js
import { checkCadenceMin, nextEmptyStreak } from './monitoring-cadence.js';
```

In `tickMonitoringNow`'s `finally`, replace the line `const cadenceMin = campaign.checkIntervalMinutes || 60;` (the one INSIDE `if (campaign.state === 'monitoring')`, not the one before the try) with:

```js
        // Adaptive cadence, mirroring the VM: consecutive sweeps that find nobody
        // stretch the interval, any acceptance snaps it straight back. The base is
        // always the operator's own setting, never the stretched value, or the
        // slowdown would compound every cycle.
        const baseMin = campaign.checkIntervalMinutes || 60;
        campaign.emptyCheckStreak = nextEmptyStreak({
          newlyAccepted: campaign._lastCheckNewlyAccepted || 0,
          current: campaign.emptyCheckStreak,
        });
        const cadenceMin = checkCadenceMin({ baseMin, emptyStreak: campaign.emptyCheckStreak });
```

Add `'emptyCheckStreak'` to `MONITORING_FIELDS` in `src/monitoring-persistence.js` so the streak survives an app restart, with a one-line comment saying an absent value means 0.

Set `campaign._lastCheckNewlyAccepted` where `runMonitoringCheckAll` reports its result. Read that function first and use whatever count it already computes. If it does not surface one, report BLOCKED rather than inventing a number: a wrong count here silently freezes or resets the cadence.

- [ ] **Step 6: Run the suite**

Run: `npm test`
Expected: all pass, count up by 5.

- [ ] **Step 7: Commit**

```bash
git add src/monitoring-cadence.js src/campaign.js src/monitoring-persistence.js tests/monitoring-cadence.test.js
git commit -m "feat: the local monitoring loop backs off like the VM does"
```

---

### Task 5: App — the handover endpoint

**Files:**
- Create: `src/handover.js`
- Modify: `server.js` (beside `/api/campaign/cloud/:id/edit-redispatch`, ~line 2116)
- Test: `tests/handover.test.js`

**Interfaces:**
- Consumes: `store.setRunsOn` via the engine's `POST /api/campaign/:id/handover-release` (Task 3); `startCampaign({ ..., excludedUrls })` (`src/campaign.js:1825`, already supports the exclude list); `getCloudCampaignLeads`; `handleStartCloud` with `excludeLeadUrls`.
- Produces: `POST /api/campaign/:id/handover` `{ to: 'local' | 'vm' }`; and the pure `processedLeadUrls(leads)` + `handoverPlan({ from, to, status })` from `src/handover.js`.

- [ ] **Step 1: Write the failing test**

```js
// The handover's pure decisions. The endpoint itself is integration-tested by
// hand; what is worth locking down is which leads are excluded and the ORDER of
// operations, because reversing that order is what would let both sides run at
// once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processedLeadUrls, handoverPlan } from '../src/handover.js';

test('every non-pending lead is excluded from the new side', () => {
  const urls = processedLeadUrls([
    { leadUrl: 'https://a', status: 'sent' },
    { leadUrl: 'https://b', status: 'pending' },
    { leadUrl: 'https://c', status: 'failed' },
    { leadUrl: 'https://d', status: 'skipped' },
    { leadUrl: '', status: 'sent' },
  ]);
  assert.deepEqual(urls.sort(), ['https://a', 'https://c', 'https://d'],
    'pending is the only status that means "still to do"; a blank URL is unusable');
});

test('the lead in flight is NOT excluded, so the new side retries it', () => {
  // The operator chose retry over drain, accepting a possible duplicate connect.
  // in_progress must therefore read as still-to-do.
  assert.deepEqual(processedLeadUrls([{ leadUrl: 'https://x', status: 'in_progress' }]), []);
});

test('the plan always stops the source before starting the target', () => {
  const steps = handoverPlan({ from: 'vm', to: 'local' }).map((s) => s.kind);
  assert.deepEqual(steps, ['release-source', 'read-sheet', 'start-target', 'reset-cadence']);
  assert.ok(steps.indexOf('release-source') < steps.indexOf('start-target'),
    'THE rule: the target may not start until the source is confirmed stopped');
});

test('a handover to the side already running is a no-op, not a restart', () => {
  assert.deepEqual(handoverPlan({ from: 'local', to: 'local' }), [],
    'a double-click must never stop and restart a healthy campaign');
});
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `node --test tests/handover.test.js`
Expected: FAIL, cannot resolve `../src/handover.js`.

- [ ] **Step 3: Write the pure module**

```js
// Pure decisions behind moving a campaign between the VM and this Mac.
//
// Kept out of server.js so the ORDER of operations is testable. That order is the
// whole safety story: the target side may not start until the source is confirmed
// stopped. Two sides sweeping at once both read Introduction Status blank, and the
// same lead gets two intro DMs.

// Which leads must the new side skip? Everything the old side already finished.
// `pending` and `in_progress` are both still-to-do: the operator chose to RETRY the
// lead that was in flight rather than drain it, accepting that a lead the old side
// had actually sent may get a second connect request.
export function processedLeadUrls(leads) {
  return (Array.isArray(leads) ? leads : [])
    .filter((l) => l && l.leadUrl && l.status !== 'pending' && l.status !== 'in_progress')
    .map((l) => l.leadUrl);
}

// The fixed sequence. Returned as data so a test can assert the order without
// running any of it.
export function handoverPlan({ from, to }) {
  if (!to || from === to) return [];
  return [
    { kind: 'release-source', from },
    { kind: 'read-sheet' },
    { kind: 'start-target', to },
    { kind: 'reset-cadence' },
  ];
}
```

- [ ] **Step 4: Run it, confirm it passes**

Run: `node --test tests/handover.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Add the endpoint**

In `server.js`, beside `edit-redispatch`. Follow that route's shape exactly, it is the closest working precedent.

VM → local: call the engine's `handover-release`. On a 409 with `reason: 'sweep_in_flight'`, ABORT and return 409 to the client with a message naming the wait; change nothing else. On success, read the campaign's leads, compute `processedLeadUrls`, and call `startCampaign({ ...cloudConfig, excludedUrls })`.

Local → VM: stop the local campaign, WAIT for it to be confirmed stopped (reuse the existing stop/drain path, do not add a new one), then `handleStartCloud` with `excludeLeadUrls` from the sheet, then `POST /api/campaign/:id/handover-release` in reverse (add the `to` body field in Task 3's route if the reverse direction needs it, and say so in your report).

Both directions log a line into the campaign's event log so the card can say "moved N min ago".

- [ ] **Step 6: Run the suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/handover.js server.js tests/handover.test.js
git commit -m "feat: move a live campaign between the VM and this Mac"
```

---

### Task 6: App — the RUNNING ON control (variant C)

**Files:**
- Modify: `public/js/app.js` (the card renderer that owns `#active-card`, and the cloud card renderer at ~11388)
- Modify: `public/css/style.css` (append the `.wh` block from the sketch)
- Reference: `public/sketches/2026-08-21-vm-local-handover.html` (approved, commit `ed5d47b`)

**Interfaces:**
- Consumes: `runsOn` from the campaign status payload (Task 7 puts it there).
- Produces: `window.campaignHandover(id, to, btn)`.

- [ ] **Step 1: Port the CSS**

Copy the `.wh`, `.wh-lab`, `.wh-seg`, `.wh-note`, `.wh-warn` and `.wh-confirm` rules from the sketch's `<style>` verbatim into `style.css` beside the other card rules. They use only existing tokens (`--ink`, `--bg`, `--gray`, `--hairline`). Do not introduce a colour. Gold stays reserved for Start.

- [ ] **Step 2: Render the control**

Below the live line on the card, for any campaign in `sending`, `checking` or `monitoring`. Current side filled. Exact markup is in the sketch's `seg()`.

- [ ] **Step 3: The confirm strip**

Clicking the other side opens the inline strip, never a modal. Lines in this order, wording from the sketch:

```
Move this campaign to <b>this Mac</b>?
· The VM stops now. N lead(s) still to send continue here.
· The lead being sent right now is retried here, so that one person may get a second request.
· GoLogin browsers open on this Mac. Keep the app open or the campaign waits.
· Acceptance checks go back to every <base> from the switch.
```

`N` is real, from the campaign's pending count. Never a placeholder.

- [ ] **Step 4: The three states**

`handing over` (both buttons locked, live line narrates the direction), `moved` (new side filled, "moved N min ago"), and `waiting for this Mac` (local-owned, nothing running, stated as waiting rather than stalled). The last one is load-bearing: the operator must never read it as stuck.

On a 409 `sweep_in_flight`, show the reason and leave both sides as they were. Never a bare "failed".

- [ ] **Step 5: Verify**

Run: `node --check public/js/app.js`
Then load `http://localhost:7847`, open a campaign card, and confirm all three states render. There is no test suite for UI. Report what you saw; do not claim a state you did not render.

- [ ] **Step 6: Commit**

```bash
git add public/js/app.js public/css/style.css
git commit -m "feat: the card says which side a campaign runs on, and moves it"
```

---

### Task 7: App — carry `runsOn` through to both card renderers

**Files:**
- Modify: `public/js/vjcard.mjs` (`statusFromItem`)
- Modify: `public/js/app.js` (the two status-mapping sites)
- Test: `tests/vjcard-runs-on.test.js`

**Context:** `statusFromItem` is a WHITELIST. Yesterday's cadence work shipped with exactly this bug: the board dropped the two new fields and told the operator "checks every 4h" as if it were their own setting. The same trap is here.

- [ ] **Step 1: Write the failing test**

```js
// statusFromItem is a whitelist, so every new field has to be added by hand or the
// board silently drops it. Yesterday's adaptive-cadence work shipped with exactly
// this bug. A dropped runsOn is worse: the board would show the VM/Mac control in
// its default position on a campaign that is running on the other side.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statusFromItem } from '../public/js/vjcard.mjs';

test('runsOn survives the whitelist', () => {
  const s = statusFromItem({ id: 'c1', state: 'monitoring', runsOn: 'local' });
  assert.equal(s.runsOn, 'local');
});

test('a campaign with no runsOn reads as the VM, never as undefined', () => {
  const s = statusFromItem({ id: 'c1', state: 'monitoring' });
  assert.equal(s.runsOn, 'vm',
    'an absent value must not leave the control unrendered or half-lit');
});
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `node --test tests/vjcard-runs-on.test.js`
Expected: FAIL, `undefined !== 'local'`.

- [ ] **Step 3: Add the field**

Add `runsOn` to the whitelist in `statusFromItem`, defaulting to `'vm'` when absent, with a comment pointing at this failure mode. Then add it to BOTH mapping sites in `app.js` (the campaign-tab card and the board strip). Find them by searching for the sites that map cloud items into card status; yesterday's equivalent change touched two.

- [ ] **Step 4: Run it, confirm it passes**

Run: `node --test tests/vjcard-runs-on.test.js`
Expected: PASS, 2 tests.

- [ ] **Step 5: Run the suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add public/js/vjcard.mjs public/js/app.js tests/vjcard-runs-on.test.js
git commit -m "fix: the board carries which side a campaign runs on"
```

---

### Task 8: Ship

**Files:**
- Modify: `package.json`, `public/index.html`

- [ ] **Step 1: Bump**

`3.1.33` → `3.1.34` in `package.json` and BOTH `?v=` strings in `public/index.html`.

Verify: `grep -c '?v=3.1.34' public/index.html` returns `2`, and `grep -c '3\.1\.33' public/index.html package.json` returns `0` for both.

- [ ] **Step 2: Full suite**

Run: `npm test`
Expected: 0 failures. Record the count.

- [ ] **Step 3: Deploy the engine**

```bash
cd /Users/antoniovarlese/ortus-salesnav-scraper-cloud
git push origin main
bash deploy.sh
```

Record which deployments moved to the new tag. `salesnav-worker` is often left behind by the busy guard: say so explicitly and state whether the handover code path runs there.

- [ ] **Step 4: Commit and relaunch**

```bash
git add package.json public/index.html
git commit -m "chore: v3.1.34 — VM/local handover"
pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "Electron.*ortus" 2>/dev/null
npm run dev:app > /tmp/dev-app.log 2>&1 &
```

Confirm `/tmp/dev-app.log` shows `v3.1.34`.

- [ ] **Step 5: Verify live**

Move one real monitoring campaign to local and back. Report what the card showed at each step, and confirm from the engine that `runs_on` actually changed. Do not claim a state you did not observe.
