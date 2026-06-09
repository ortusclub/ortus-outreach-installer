# Honest Check Cadence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the operator's check-cadence setting the single number that governs every acceptance check (sending and monitoring), keeping only the fixed 1-hour first check.

**Architecture:** One shared cadence policy (min/max/clamp) drives the wizard, the server intake clamp, and the campaign engine. The three recurring-check trigger sites (in-batch, idle, monitoring reschedule) all read the one clamped `checkIntervalMinutes`. The hardcoded 6-hour sending interval and the `Math.max(60,…)` monitoring floor are removed; the 1-hour first-check blackout stays.

**Tech Stack:** Vanilla ES-module JS, Node ≥22 `node --test`, Express 4, no bundler.

**Spec:** `docs/superpowers/specs/2026-06-09-honest-check-cadence-design.md`

**Scope:** Affects only `connect_and_introduce` (CC+IC) and `connect_and_message` (CC+DM) — the two modes behind `usesMonitoringCadence`. Tasks must be done in order (later tasks remove constants that earlier tasks stop using).

---

## File Structure

- `public/js/campaign-modes.mjs` — existing shared mode/cadence policy (frontend + server + engine all import it). **Add** the cadence min/max + clamp here so all three layers agree.
- `server.js:839` — HTTP intake clamp. Repoint to the shared clamp.
- `src/campaign.js` — engine: startCampaign intake backstop, in-batch trigger, `shouldFireIdleBulkCheck`, idle call site, monitoring reschedule, constants, log string, comments.
- `public/index.html` — the cadence dropdown options + helper copy.
- `public/js/app.js` — one stale comment.
- Tests: new `tests/cadence-policy.test.js`; update `tests/server-checkinterval-clamp.test.js`, `tests/idle-bulk-check.test.js`, `tests/monitoring-tick.test.js`.

---

### Task 1: Shared cadence policy (min / max / clamp)

**Files:**
- Modify: `public/js/campaign-modes.mjs`
- Test: `tests/cadence-policy.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/cadence-policy.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_CADENCE_MINUTES,
  MAX_CADENCE_MINUTES,
  clampCadenceMinutes,
} from '../public/js/campaign-modes.mjs';

test('min is 60 (1 hour), max is 720 (12 hours)', () => {
  assert.equal(MIN_CADENCE_MINUTES, 60);
  assert.equal(MAX_CADENCE_MINUTES, 720);
});

test('honors in-range values exactly', () => {
  assert.equal(clampCadenceMinutes(60), 60);
  assert.equal(clampCadenceMinutes(120), 120);
  assert.equal(clampCadenceMinutes(360), 360);
  assert.equal(clampCadenceMinutes(720), 720);
});

test('raises below-min values up to 60', () => {
  assert.equal(clampCadenceMinutes(15), 60);
  assert.equal(clampCadenceMinutes(30), 60);
  assert.equal(clampCadenceMinutes(1), 60);
});

test('lowers above-max values down to 720', () => {
  assert.equal(clampCadenceMinutes(9999), 720);
});

test('falls back to 60 on garbage / missing', () => {
  assert.equal(clampCadenceMinutes('banana'), 60);
  assert.equal(clampCadenceMinutes(undefined), 60);
  assert.equal(clampCadenceMinutes(null), 60);
  assert.equal(clampCadenceMinutes(NaN), 60);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/cadence-policy.test.js`
Expected: FAIL — `clampCadenceMinutes`/`MIN_CADENCE_MINUTES`/`MAX_CADENCE_MINUTES` are not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `public/js/campaign-modes.mjs` (after the existing `usesMonitoringCadence` export):

```javascript

// Cadence bounds — single source of truth for the wizard dropdown, the server
// intake clamp, and the engine backstop. The dropdown's smallest/largest
// options MUST equal these (see public/index.html #check-cadence-select).
// Min == 60 means "the picker never offers a value the engine won't honor."
export const MIN_CADENCE_MINUTES = 60;   // 1 hour
export const MAX_CADENCE_MINUTES = 720;  // 12 hours

// Clamp a raw cadence (minutes) into [MIN, MAX]. Non-numeric / missing → MIN.
export function clampCadenceMinutes(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return MIN_CADENCE_MINUTES;
  return Math.max(MIN_CADENCE_MINUTES, Math.min(MAX_CADENCE_MINUTES, n));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/cadence-policy.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add public/js/campaign-modes.mjs tests/cadence-policy.test.js
git commit -m "feat(cadence): shared cadence policy (min 60 / max 720 / clamp)"
```

---

### Task 2: Server intake uses the shared clamp ([60, 720])

**Files:**
- Modify: `server.js` (import + line ~839)
- Test: `tests/server-checkinterval-clamp.test.js` (rewrite to test the real shared clamp)

- [ ] **Step 1: Rewrite the test to assert the new range via the real function**

Replace the entire contents of `tests/server-checkinterval-clamp.test.js` with:

```javascript
import { test } from 'node:test';
import assert from 'node:assert';
// The server intake MUST use the shared policy clamp — no inline duplicate.
import { clampCadenceMinutes } from '../public/js/campaign-modes.mjs';

test('server clamp accepts 1 hour (default/floor)', () => assert.equal(clampCadenceMinutes(60), 60));
test('server clamp accepts 12 hours (ceiling)', () => assert.equal(clampCadenceMinutes(720), 720));
test('server clamp raises old 15-min setting to 60', () => assert.equal(clampCadenceMinutes(15), 60));
test('server clamp raises old 30-min setting to 60', () => assert.equal(clampCadenceMinutes(30), 60));
test('server clamp lowers 9999 to 720', () => assert.equal(clampCadenceMinutes(9999), 720));
test('server clamp falls back to 60 on garbage', () => assert.equal(clampCadenceMinutes('banana'), 60));
```

- [ ] **Step 2: Run test to verify current state**

Run: `node --test tests/server-checkinterval-clamp.test.js`
Expected: PASS already (it imports the Task 1 function). This step locks the contract; the real change is wiring server.js to it next.

- [ ] **Step 3: Wire server.js to the shared clamp**

In `server.js`, add to the existing import block near the top (where other `./public/js` or `./src` modules are imported — place it with the other ESM imports):

```javascript
import { clampCadenceMinutes } from './public/js/campaign-modes.mjs';
```

Then change the clamp line (currently `server.js:839`):

```javascript
    checkIntervalMinutes: Math.max(15, Math.min(360, Number(checkIntervalMinutes) || 60)),
```

to:

```javascript
    checkIntervalMinutes: clampCadenceMinutes(checkIntervalMinutes),
```

- [ ] **Step 4: Run the full suite to confirm no regression**

Run: `node --test tests/*.test.js`
Expected: PASS (no test should depend on the old [15,360] server behavior now that the clamp test is repointed).

- [ ] **Step 5: Commit**

```bash
git add server.js tests/server-checkinterval-clamp.test.js
git commit -m "feat(cadence): server intake clamps to [60,720] via shared policy"
```

---

### Task 3: Idle trigger honors the operator cadence

**Files:**
- Modify: `src/campaign.js` — `shouldFireIdleBulkCheck` (~line 172-182) and its call site (~line 3300-3308)
- Test: `tests/idle-bulk-check.test.js` (update)

- [ ] **Step 1: Update the test to pass and assert `intervalMs`**

Replace the entire contents of `tests/idle-bulk-check.test.js` with:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldFireIdleBulkCheck } from '../src/campaign.js';

// The between-checks interval is now the operator cadence, passed in as
// intervalMs. The first-hour age gate (campaignStartTime) is unchanged.
const ONE_HOUR = 60 * 60 * 1000;
const baseInput = () => ({
  mode: 'connect_and_introduce',
  campaignStartTime: Date.now() - (75 * 60 * 1000), // 75 min ago — past 60-min age gate
  profileBrowserOpen: false,
  profileWeeklyLimited: false,
  semaphoreAvailable: 1,
  lastBulkCheckAt: Date.now() - (2 * ONE_HOUR), // 2h ago — past a 1h cadence
  intervalMs: ONE_HOUR,                          // operator picked "every hour"
  now: Date.now(),
});

test('fires when all gates pass', () => {
  assert.equal(shouldFireIdleBulkCheck(baseInput()), true);
});

test('skips when mode is not a connect-then-followup mode', () => {
  assert.equal(shouldFireIdleBulkCheck({ ...baseInput(), mode: 'connect_only' }), false);
  assert.equal(shouldFireIdleBulkCheck({ ...baseInput(), mode: 'message_only' }), false);
  assert.equal(shouldFireIdleBulkCheck({ ...baseInput(), mode: 'introduce_back' }), false);
});

test('fires when mode is connect_and_message', () => {
  assert.equal(shouldFireIdleBulkCheck({ ...baseInput(), mode: 'connect_and_message' }), true);
});

test('skips when campaign uptime < 60 min (first-hour blackout)', () => {
  const input = { ...baseInput(), campaignStartTime: Date.now() - (45 * 60 * 1000) };
  assert.equal(shouldFireIdleBulkCheck(input), false);
});

test('skips when profile browser is open (in-batch trigger owns it)', () => {
  assert.equal(shouldFireIdleBulkCheck({ ...baseInput(), profileBrowserOpen: true }), false);
});

test('skips when profile is parked permanently (weeklyLimited)', () => {
  assert.equal(shouldFireIdleBulkCheck({ ...baseInput(), profileWeeklyLimited: true }), false);
});

test('skips when semaphore has no available slot', () => {
  assert.equal(shouldFireIdleBulkCheck({ ...baseInput(), semaphoreAvailable: 0 }), false);
});

test('HONORS the operator cadence: skips when interval not yet elapsed', () => {
  // 30 min since last check, but operator picked every hour → not due yet.
  const input = { ...baseInput(), lastBulkCheckAt: Date.now() - (30 * 60 * 1000) };
  assert.equal(shouldFireIdleBulkCheck(input), false);
});

test('HONORS the operator cadence: a 6h pick is NOT due at 2h', () => {
  const input = { ...baseInput(), intervalMs: 6 * ONE_HOUR, lastBulkCheckAt: Date.now() - (2 * ONE_HOUR) };
  assert.equal(shouldFireIdleBulkCheck(input), false);
});

test('fires when the operator interval elapses exactly (boundary)', () => {
  const t = Date.now();
  const input = { ...baseInput(), now: t, intervalMs: ONE_HOUR, lastBulkCheckAt: t - ONE_HOUR };
  assert.equal(shouldFireIdleBulkCheck(input), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/idle-bulk-check.test.js`
Expected: FAIL — the function still compares against the 6h constant, so the "HONORS the operator cadence" cases (30 min / 6h-pick) come out wrong.

- [ ] **Step 3: Change the function to read `ctx.intervalMs`**

In `src/campaign.js`, in `shouldFireIdleBulkCheck` (~line 172), change the cooldown line. Current:

```javascript
  if (ctx.now - ctx.lastBulkCheckAt < IN_CAMPAIGN_BULK_CHECK_INTERVAL_MS) return false;
```

to:

```javascript
  // Between-checks interval is the operator cadence (ms), passed in by the
  // caller. Defaults to 1h if a caller forgets it (matches the picker minimum).
  const intervalMs = Number.isFinite(ctx.intervalMs) ? ctx.intervalMs : 60 * 60 * 1000;
  if (ctx.now - ctx.lastBulkCheckAt < intervalMs) return false;
```

Also update the JSDoc `@param` list above the function to add:

```javascript
 * @param {number}  ctx.intervalMs            - operator cadence between checks, in ms (defaults to 1h if absent)
```

- [ ] **Step 4: Pass `intervalMs` at the call site**

In `src/campaign.js` (~line 3300), the call builds a ctx object. Current:

```javascript
            const _fire = shouldFireIdleBulkCheck({
              mode,
              campaignStartTime,
              profileBrowserOpen: sessions.has(_profileId),
              profileWeeklyLimited: weeklyLimited.has(_profileId),
              semaphoreAvailable: _semAvailable,
              lastBulkCheckAt: _lastBulkCheckAt,
              now: Date.now(),
            });
```

Add the `intervalMs` field (here `checkIntervalMinutes` is the clamped startCampaign param, in scope):

```javascript
            const _fire = shouldFireIdleBulkCheck({
              mode,
              campaignStartTime,
              profileBrowserOpen: sessions.has(_profileId),
              profileWeeklyLimited: weeklyLimited.has(_profileId),
              semaphoreAvailable: _semAvailable,
              lastBulkCheckAt: _lastBulkCheckAt,
              intervalMs: checkIntervalMinutes * 60_000,
              now: Date.now(),
            });
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test tests/idle-bulk-check.test.js`
Expected: PASS (all cases).

- [ ] **Step 6: Commit**

```bash
git add src/campaign.js tests/idle-bulk-check.test.js
git commit -m "feat(cadence): idle trigger honors operator cadence instead of 6h"
```

---

### Task 4: In-batch trigger + startCampaign clamp + retire 6h constant + fix log/comments

**Files:**
- Modify: `src/campaign.js` — startCampaign intake (~line 1264 / 1382), in-batch trigger (~line 2902-2903), constant (~line 75), comments (~line 61-79)

- [ ] **Step 1: Clamp the cadence at startCampaign intake**

In `src/campaign.js`, add the shared clamp import to the existing import block near the top (alongside `import { checkAndConnectPrimary } from './linkedin/primary-connection.js';`):

```javascript
import { clampCadenceMinutes } from '../public/js/campaign-modes.mjs';
```

Then clamp the param. Change the store line (currently `campaign.js:1382`):

```javascript
  campaign.checkIntervalMinutes = checkIntervalMinutes;
```

to:

```javascript
  // Backstop clamp (defense in depth — the server already clamps, but other
  // callers like restore/resume must not slip an out-of-range value through).
  checkIntervalMinutes = clampCadenceMinutes(checkIntervalMinutes);
  campaign.checkIntervalMinutes = checkIntervalMinutes;
```

> Note: reassigning the destructured param `checkIntervalMinutes` is intentional so the in-batch trigger and the idle call site (Task 3) both read the clamped value.

- [ ] **Step 2: In-batch trigger reads the operator cadence**

In `src/campaign.js` (~line 2902), change the gate. Current:

```javascript
                } else if (Date.now() - last >= IN_CAMPAIGN_BULK_CHECK_INTERVAL_MS) {
                  log(`  📡 [${pName}] In-batch bulk Connection Status check (60-min cooldown elapsed)…`);
```

to:

```javascript
                } else if (Date.now() - last >= checkIntervalMinutes * 60_000) {
                  log(`  📡 [${pName}] In-batch bulk Connection Status check (${checkIntervalMinutes}-min cadence elapsed)…`);
```

(The 1-hour blackout gate two lines above — `if (_campaignAgeMs < FIRST_HOUR_BLACKOUT_MS)` — is left exactly as-is: first check still at 1h.)

- [ ] **Step 3: Retire the now-unused 6h constant and fix the contradictory comments**

In `src/campaign.js`, the `IN_CAMPAIGN_BULK_CHECK_INTERVAL_MS` constant (~line 75) now has no readers (idle uses `ctx.intervalMs` from Task 3; in-batch uses `checkIntervalMinutes`). Delete the constant line:

```javascript
const IN_CAMPAIGN_BULK_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
```

Replace the stale comment block above it (currently `campaign.js:61-74`, the "v2.71 … one bulk-check per hour … v2.79 … every 6h" block) with an accurate one:

```javascript
// Acceptance-check timing:
//   • First check is gated by FIRST_HOUR_BLACKOUT_MS (in-batch) and
//     IDLE_CAMPAIGN_MIN_DURATION_MS (idle) — always ~1h after campaign start,
//     regardless of cadence. (Gives LinkedIn time to start accepting.)
//   • After that, the gap between checks is the operator's cadence
//     (checkIntervalMinutes), honored identically during sending and
//     monitoring. Manual /api/bulk-check-now bypasses both rules.
```

Keep `FIRST_HOUR_BLACKOUT_MS` and `IDLE_CAMPAIGN_MIN_DURATION_MS` and their comments.

- [ ] **Step 4: Verify nothing else references the deleted constant**

Run: `grep -n "IN_CAMPAIGN_BULK_CHECK_INTERVAL_MS" src/campaign.js`
Expected: **no output** (zero matches).

- [ ] **Step 5: Run the full suite**

Run: `node --test tests/*.test.js`
Expected: PASS. (`idle-bulk-check` from Task 3 already updated; nothing else should reference the old constant.)

- [ ] **Step 6: Commit**

```bash
git add src/campaign.js
git commit -m "feat(cadence): in-batch trigger uses operator cadence; retire 6h constant; clamp at intake; fix log+comments"
```

---

### Task 5: Remove the monitoring reschedule floor

**Files:**
- Modify: `src/campaign.js` (~line 4202)
- Test: `tests/monitoring-tick.test.js` (update the floor assertion)

- [ ] **Step 1: Update the test to expect the cadence honored (no floor)**

In `tests/monitoring-tick.test.js`, the test `'tickMonitoringNow fires when nextCheckAt is overdue and reschedules'` currently sets `checkIntervalMinutes: 30` and asserts ~60 (the floor). Replace that test (lines ~23-41) with:

```javascript
test('tickMonitoringNow fires when overdue and reschedules by the EXACT cadence (no floor)', async () => {
  const past = new Date(Date.now() - 1000);
  _setTestState({
    state: 'monitoring',
    nextCheckAt: past.toISOString(),
    monitoringUntil: new Date(Date.now() + 86400_000).toISOString(),
    checkIntervalMinutes: 30, // set directly (bypasses intake clamp) to prove the reschedule does NOT floor
    logs: [],
  });
  let fired = false;
  await tickMonitoringNow({ _testStub: async () => { fired = true; } });
  assert.equal(fired, true);
  const s = getCampaignState();
  const nextMs = new Date(s.nextCheckAt).getTime();
  // No 60-min floor anymore: a 30-min value reschedules ~30 min out, not ~60.
  assert.ok(nextMs > Date.now() + 29 * 60_000, 'nextCheckAt should be ~30 min out');
  assert.ok(nextMs <= Date.now() + 31 * 60_000, 'nextCheckAt should not exceed 30 min + slack');
});
```

(Leave the other three tests in the file unchanged.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/monitoring-tick.test.js`
Expected: FAIL — the current `Math.max(60, …)` floors 30 up to 60, so `nextMs` lands ~60 min out, failing the ≤31-min assertion.

- [ ] **Step 3: Remove the floor**

In `src/campaign.js` (~line 4202), inside the reschedule `finally` block. Current:

```javascript
        const cadenceMin = Math.max(60, campaign.checkIntervalMinutes || 60);
```

to:

```javascript
        // Honor the operator cadence exactly — no floor here. The value was
        // clamped to >= MIN_CADENCE_MINUTES at startCampaign intake.
        const cadenceMin = campaign.checkIntervalMinutes || 60;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/monitoring-tick.test.js`
Expected: PASS (all four tests).

- [ ] **Step 5: Commit**

```bash
git add src/campaign.js tests/monitoring-tick.test.js
git commit -m "feat(cadence): drop the 60-min monitoring reschedule floor"
```

---

### Task 6: Wizard dropdown options + honest helper copy

**Files:**
- Modify: `public/index.html` (~line 530-547)
- Modify: `public/js/app.js` (~line 3099 comment only)

- [ ] **Step 1: Replace the dropdown options**

In `public/index.html`, replace the `<select id="check-cadence-select">` options block (currently `index.html:537-545`):

```html
              <select id="check-cadence-select" class="intro-config-select">
                <option value="15">15 minutes</option>
                <option value="30">30 minutes</option>
                <option value="60" selected>1 hour</option>
                <option value="90">1.5 hours</option>
                <option value="120">2 hours</option>
                <option value="180">3 hours</option>
                <option value="360">6 hours</option>
              </select>
```

with:

```html
              <select id="check-cadence-select" class="intro-config-select">
                <option value="60" selected>1 hour</option>
                <option value="120">2 hours</option>
                <option value="240">4 hours</option>
                <option value="360">6 hours</option>
                <option value="720">12 hours</option>
              </select>
```

- [ ] **Step 2: Fix the comment and helper copy to be honest**

In `public/index.html`, change the comment (currently `index.html:530`):

```html
        <!-- v2.14.x: Auto-check cadence (CC+IC only). -->
```

to:

```html
        <!-- Auto-check cadence (CC+IC + CC+DM). Honored during sending AND monitoring. Options must match MIN/MAX_CADENCE_MINUTES in campaign-modes.mjs. -->
```

And change the hint (currently `index.html:547`):

```html
            <div class="intro-config-hint">How often the app re-checks for new acceptances and fires the intro DM during the 7-day monitoring window. Faster cadences increase LinkedIn API load.</div>
```

to:

```html
            <div class="intro-config-hint">How often we check each account for new acceptances and fire the follow-up — during sending and after. The first check is always ~1 hour in; after that it follows this interval. A little later if all browsers are busy sending.</div>
```

- [ ] **Step 3: Fix the stale clamp comment in app.js**

In `public/js/app.js` (~line 3099), change:

```javascript
    // Server clamps to [15, 360] and ignores the field for other modes.
```

to:

```javascript
    // Server clamps to [60, 720] (shared clampCadenceMinutes) and ignores the field for other modes.
```

- [ ] **Step 4: Manual UI verification**

Run: `pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "Electron.*ortus" 2>/dev/null; npm run dev:app > /tmp/dev-app.log 2>&1 &`
Then in the Electron app (Cmd+R to reload), open the launch wizard for a CC+IC campaign and confirm the cadence dropdown shows exactly: 1 hour / 2 hours / 4 hours / 6 hours / 12 hours, default "1 hour". Confirm it also appears for CC+DM.

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/js/app.js
git commit -m "feat(cadence): wizard offers 1/2/4/6/12h with honest helper copy"
```

---

### Task 7: Full verification, version bump, relaunch

**Files:**
- Modify: `package.json` (version)

- [ ] **Step 1: Run the entire test suite**

Run: `node --test tests/*.test.js`
Expected: PASS, output pristine. The only tests touched by this change are the three updated in Tasks 2/3/5 (`server-checkinterval-clamp`, `idle-bulk-check`, `monitoring-tick`). Verified that the other cadence tests stay green because they exercise functions this plan does NOT change, with directly-set values:
- `monitoring-time-cadence.test.js` — tests `recomputeNextCheckAt` (unchanged, 360 default kept).
- `campaign-state-transitions-cadence.test.js` — tests `transitionToMonitoring` (unchanged; no floor was ever there).
- `monitoring-persistence-checkinterval.test.js` — tests persistence pass-through (unchanged).

If any of these unexpectedly fails, read it and fix the test's expectation to match the new policy — do NOT change production code to satisfy a stale test.

- [ ] **Step 2: Confirm no orphaned references**

Run: `grep -rn "IN_CAMPAIGN_BULK_CHECK_INTERVAL_MS\|Math.max(15\|Math.min(360\|60-min cooldown" src/ server.js public/`
Expected: **no output**.

- [ ] **Step 3: Bump the version (operator rule: bump before relaunch)**

In `package.json`, change `"version": "2.86.10"` to `"version": "2.86.11"`.

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "chore: bump to 2.86.11 (honest check cadence)"
```

- [ ] **Step 5: Relaunch the dev app (operator rule)**

Run: `pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "Electron.*ortus" 2>/dev/null; pkill -f "node_modules/electron/dist" 2>/dev/null; npm run dev:app > /tmp/dev-app.log 2>&1 &`
Confirm the UI footer shows `✦ Ortus Outreach v2.86.11`.

---

## Self-Review

**Spec coverage:**
- "First check at 1h" → preserved (Task 4 leaves `FIRST_HOUR_BLACKOUT_MS`; idle age gate kept in Task 3). ✓
- "After first check, every X, sending + monitoring" → in-batch (Task 4), idle (Task 3), monitoring reschedule (Task 5). ✓
- "No 6h rule" → constant retired (Task 4). ✓
- "No silent floor" → `Math.max(60,…)` removed (Task 5). ✓
- "Picker offers 1/2/4/6/12h, default 1h" → Task 6. ✓
- "Min picker == engine min" → shared `MIN_CADENCE_MINUTES` used by clamp (Tasks 1, 2, 4) and dropdown (Task 6). ✓
- "Server clamp supports 12h" → [60,720] (Task 2). ✓
- "Fix lying log + comments" → Task 4. ✓
- "Scope CC+IC + CC+DM only" → all trigger sites already gate on these two; no mode logic changed. ✓
- Tests for idle/reschedule/clamp/first-check → Tasks 1,2,3,5 + suite gate Task 7. ✓

**Placeholder scan:** No TBD/TODO; every code step shows exact old→new text. ✓

**Type/name consistency:** `clampCadenceMinutes`, `MIN_CADENCE_MINUTES`, `MAX_CADENCE_MINUTES`, `ctx.intervalMs`, `checkIntervalMinutes` used consistently across tasks. ✓

**Note on ordering:** Task 3 must precede Task 4 (Task 4 deletes the constant only after Task 3 removes its last idle reader). Tasks run in listed order.
