# Monitoring Auto-Trigger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire up automatic bulk-check + auto-intro firing during CC+IC monitoring state, with operator-chosen cadence (15min–6h) per campaign, surviving macOS sleep and app restart.

**Architecture:** Per-campaign `checkIntervalMinutes` flows wizard → start payload → `campaign` object → persisted state. The existing `_monitoringWatcherTimer` (60s setInterval) is refactored into a named `tickMonitoringNow` function with two duties: 7-day window expiry (existing) and `runMonitoringCheckAll` when `campaign.nextCheckAt` is overdue (new). Electron `powerMonitor.on('resume')` pings new `POST /api/monitoring/wake` which calls the same tick body, so an overdue check fires immediately after a laptop wake. Re-entrancy guard `_checkInProgress` prevents double-fire.

**Tech Stack:** Node 22 / Electron 33 / Express 4 / vanilla JS / `node --test`

**Spec:** [`docs/superpowers/specs/2026-05-15-monitoring-auto-trigger-design.md`](../specs/2026-05-15-monitoring-auto-trigger-design.md)

---

### Task 1: Persist `checkIntervalMinutes` through restart

**Files:**
- Modify: `src/monitoring-persistence.js:11-31`
- Test: `tests/monitoring-persistence-checkinterval.test.js` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/monitoring-persistence-checkinterval.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert';
import { extractMonitoringSlice, MONITORING_FIELDS } from '../src/monitoring-persistence.js';

test('extractMonitoringSlice round-trips checkIntervalMinutes', () => {
  const campaign = {
    id: 'c1',
    name: 'test',
    state: 'monitoring',
    mode: 'connect_and_introduce',
    checkIntervalMinutes: 30,
    nextCheckAt: '2026-05-15T10:00:00.000Z',
  };
  const slice = extractMonitoringSlice(campaign);
  assert.equal(slice.checkIntervalMinutes, 30);
  assert.ok(MONITORING_FIELDS.includes('checkIntervalMinutes'));
});

test('extractMonitoringSlice omits checkIntervalMinutes when undefined', () => {
  const campaign = { id: 'c1', state: 'monitoring' };
  const slice = extractMonitoringSlice(campaign);
  assert.equal(slice.checkIntervalMinutes, undefined);
});
```

- [ ] **Step 2: Run test, verify FAIL**

```bash
node --test tests/monitoring-persistence-checkinterval.test.js
```
Expected: FAIL — `checkIntervalMinutes` not in MONITORING_FIELDS.

- [ ] **Step 3: Add field to MONITORING_FIELDS**

In `src/monitoring-persistence.js`, append `'checkIntervalMinutes'` to the `MONITORING_FIELDS` array (after `'senderFirstNames'`):

```js
  'senderFirstNames',
  // v2.14.x: operator-chosen cadence (15-360 min) for the monitoring
  // auto-trigger. Survives restart so the watcher tick uses the right
  // interval after rehydration; defaults to 60 if absent (e.g. older
  // state files written before this field shipped).
  'checkIntervalMinutes',
];
```

- [ ] **Step 4: Run test, verify PASS**

```bash
node --test tests/monitoring-persistence-checkinterval.test.js
```

- [ ] **Step 5: Commit**

```bash
git add src/monitoring-persistence.js tests/monitoring-persistence-checkinterval.test.js
git commit -m "feat(monitoring): persist checkIntervalMinutes through restart"
```

---

### Task 2: `recomputeNextCheckAt` accepts cadence

**Files:**
- Modify: `src/monitoring-time.js`
- Test: `tests/monitoring-time-cadence.test.js` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/monitoring-time-cadence.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert';
import { recomputeNextCheckAt } from '../src/monitoring-time.js';

test('recomputeNextCheckAt honors 60-min cadence', () => {
  const sendingEndedAt = new Date('2026-05-15T20:00:00.000Z');
  const now = new Date('2026-05-15T20:00:00.000Z');
  const next = recomputeNextCheckAt(sendingEndedAt, now, 60);
  assert.equal(next.toISOString(), '2026-05-15T21:00:00.000Z');
});

test('recomputeNextCheckAt honors 15-min cadence', () => {
  const sendingEndedAt = new Date('2026-05-15T20:00:00.000Z');
  const now = new Date('2026-05-15T20:07:00.000Z');
  const next = recomputeNextCheckAt(sendingEndedAt, now, 15);
  assert.equal(next.toISOString(), '2026-05-15T20:15:00.000Z');
});

test('recomputeNextCheckAt defaults to 360 min (6h) when cadence omitted', () => {
  const sendingEndedAt = new Date('2026-05-15T20:00:00.000Z');
  const now = new Date('2026-05-15T20:00:00.000Z');
  const next = recomputeNextCheckAt(sendingEndedAt, now);
  assert.equal(next.toISOString(), '2026-05-16T02:00:00.000Z');
});
```

- [ ] **Step 2: Run test, verify FAIL**

```bash
node --test tests/monitoring-time-cadence.test.js
```
Expected: FAIL — current `recomputeNextCheckAt` ignores the third arg, returns 6h boundary.

- [ ] **Step 3: Update `recomputeNextCheckAt`**

Replace the function in `src/monitoring-time.js`:

```js
/**
 * Returns the next cadence boundary strictly AFTER `now`, measured from
 * `sendingEndedAt`. If `now` lands exactly on a boundary, returns the next
 * one (strict >). `cadenceMin` defaults to 360 (6h) for backward compat.
 */
export function recomputeNextCheckAt(sendingEndedAt, now, cadenceMin = 360) {
  const s = _toDate(sendingEndedAt).getTime();
  const n = _toDate(now).getTime();
  const elapsed = n - s;
  const intervalMs = cadenceMin * 60_000;
  const ticksPassed = Math.floor(elapsed / intervalMs) + 1;
  return new Date(s + ticksPassed * intervalMs);
}
```

- [ ] **Step 4: Run test, verify PASS**

```bash
node --test tests/monitoring-time-cadence.test.js
```

- [ ] **Step 5: Run full suite to ensure no regressions**

```bash
node --test tests/
```
All 200+ tests should still pass — the default `360` preserves prior behavior for existing callers.

- [ ] **Step 6: Commit**

```bash
git add src/monitoring-time.js tests/monitoring-time-cadence.test.js
git commit -m "feat(monitoring): recomputeNextCheckAt accepts cadence in minutes"
```

---

### Task 3: `transitionToMonitoring` reads cadence from campaign

**Files:**
- Modify: `src/campaign-state-transitions.js`
- Test: `tests/campaign-state-transitions.test.js` (existing — append) OR create new test file if none exists

- [ ] **Step 1: Check whether test file exists**

```bash
ls tests/campaign-state-transitions*.test.js 2>/dev/null
```

If none exists, create `tests/campaign-state-transitions-cadence.test.js`. If one exists, append the test case below to it.

- [ ] **Step 2: Write the failing test**

```js
import { test } from 'node:test';
import assert from 'node:assert';
import { transitionToMonitoring } from '../src/campaign-state-transitions.js';

test('transitionToMonitoring uses campaign.checkIntervalMinutes for first nextCheckAt', () => {
  const campaign = {
    state: 'running',
    mode: 'connect_and_introduce',
    checkIntervalMinutes: 30,
    logs: [],
  };
  const now = new Date('2026-05-15T20:00:00.000Z');
  const next = transitionToMonitoring(campaign, {
    now,
    participatingProfileIds: ['p1'],
  });
  assert.equal(next.state, 'monitoring');
  assert.equal(new Date(next.nextCheckAt).toISOString(), '2026-05-15T20:30:00.000Z');
});

test('transitionToMonitoring defaults to 60 min when checkIntervalMinutes absent', () => {
  const campaign = {
    state: 'running',
    mode: 'connect_and_introduce',
    logs: [],
  };
  const now = new Date('2026-05-15T20:00:00.000Z');
  const next = transitionToMonitoring(campaign, {
    now,
    participatingProfileIds: ['p1'],
  });
  assert.equal(new Date(next.nextCheckAt).toISOString(), '2026-05-15T21:00:00.000Z');
});
```

- [ ] **Step 3: Run test, verify FAIL**

```bash
node --test tests/campaign-state-transitions-cadence.test.js
```
Expected: FAIL — current `transitionToMonitoring` always uses 6h.

- [ ] **Step 4: Update `transitionToMonitoring`**

Replace the relevant lines in `src/campaign-state-transitions.js`:

```js
export function transitionToMonitoring(campaign, { now, participatingProfileIds }) {
  if (campaign.state === 'monitoring' || campaign.state === 'done') return campaign;

  if (campaign.mode !== 'connect_and_introduce' || !participatingProfileIds || participatingProfileIds.length === 0) {
    return { ...campaign, state: 'done' };
  }

  const sendingEndedAt = new Date(now);
  const monitoringUntil = computeMonitoringUntil(sendingEndedAt);
  const cadenceMin = campaign.checkIntervalMinutes || 60;
  const nextCheckAt = recomputeNextCheckAt(sendingEndedAt, sendingEndedAt, cadenceMin);
  const logs = [...(campaign.logs || []), `${_logTs(sendingEndedAt)} 🛏 Monitoring started · next check at ${_hhmm(nextCheckAt)} (cadence=${cadenceMin}m)`];

  return {
    ...campaign,
    state: 'monitoring',
    sendingEndedAt: sendingEndedAt.toISOString(),
    monitoringUntil: monitoringUntil.toISOString(),
    nextCheckAt: nextCheckAt.toISOString(),
    participatingProfileIds: [...participatingProfileIds],
    logs,
    // Persist the resolved cadence so post-restart rehydration uses it.
    checkIntervalMinutes: cadenceMin,
  };
}
```

- [ ] **Step 5: Run tests, verify PASS**

```bash
node --test tests/campaign-state-transitions-cadence.test.js
node --test tests/
```

- [ ] **Step 6: Commit**

```bash
git add src/campaign-state-transitions.js tests/campaign-state-transitions-cadence.test.js
git commit -m "feat(monitoring): transitionToMonitoring reads cadence from campaign"
```

---

### Task 4: `startCampaign` accepts cadence + `tickMonitoringNow` extraction + nextCheckAt firing

**Files:**
- Modify: `src/campaign.js` (multiple sites: `startCampaign` signature, `campaign` global initialization, `_monitoringWatcherTimer` block)
- Test: `tests/monitoring-tick.test.js` (new)

This is the largest task — extracting the timer body, adding the re-entrancy guard, and wiring the new firing duty.

- [ ] **Step 1: Write the failing test**

Create `tests/monitoring-tick.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert';
import { _setTestState, tickMonitoringNow, getCampaignState } from '../src/campaign.js';

test('tickMonitoringNow does nothing when state is not monitoring', async () => {
  _setTestState({ state: 'idle', nextCheckAt: new Date(Date.now() - 60_000).toISOString() });
  let fired = false;
  globalThis.__monitoringFiredForTest = () => { fired = true; };
  await tickMonitoringNow({ _testStub: () => { fired = true; } });
  assert.equal(fired, false);
});

test('tickMonitoringNow does nothing when nextCheckAt is in the future', async () => {
  _setTestState({
    state: 'monitoring',
    nextCheckAt: new Date(Date.now() + 60_000).toISOString(),
    monitoringUntil: new Date(Date.now() + 86400_000).toISOString(),
  });
  let fired = false;
  await tickMonitoringNow({ _testStub: () => { fired = true; } });
  assert.equal(fired, false);
});

test('tickMonitoringNow fires when nextCheckAt is overdue and reschedules', async () => {
  const past = new Date(Date.now() - 1000);
  _setTestState({
    state: 'monitoring',
    nextCheckAt: past.toISOString(),
    monitoringUntil: new Date(Date.now() + 86400_000).toISOString(),
    checkIntervalMinutes: 30,
    logs: [],
  });
  let fired = false;
  await tickMonitoringNow({ _testStub: async () => { fired = true; } });
  assert.equal(fired, true);
  const s = getCampaignState();
  const nextMs = new Date(s.nextCheckAt).getTime();
  assert.ok(nextMs > Date.now() + 29 * 60_000, 'nextCheckAt should be ~30 min in the future');
  assert.ok(nextMs <= Date.now() + 31 * 60_000, 'nextCheckAt should not exceed 30 min + slack');
});

test('tickMonitoringNow does not reschedule when state changes during fire', async () => {
  const past = new Date(Date.now() - 1000);
  _setTestState({
    state: 'monitoring',
    nextCheckAt: past.toISOString(),
    monitoringUntil: new Date(Date.now() + 86400_000).toISOString(),
    checkIntervalMinutes: 30,
    logs: [],
  });
  const originalNext = past.toISOString();
  await tickMonitoringNow({
    _testStub: async () => { _setTestState({ state: 'done' }); },
  });
  const s = getCampaignState();
  assert.equal(s.nextCheckAt, originalNext, 'nextCheckAt should NOT be advanced after state changed away from monitoring');
});
```

- [ ] **Step 2: Run test, verify FAIL**

```bash
node --test tests/monitoring-tick.test.js
```
Expected: FAIL — `tickMonitoringNow` does not exist yet.

- [ ] **Step 3: Modify `startCampaign` signature in `src/campaign.js:963`**

Find:
```js
export async function startCampaign({ profileIds, sheetUrl, templates, dailyLimit = 50, mode = 'connect_only', messageOpenProfiles = false, delayMin = 15, delayMax = 45, linkedinColumn = '', senderFirstNames = {}, concurrency = 1, name = '', acceptanceTrackingDays = 0, preflightCheckStatus = false, createdBy = null }) {
```

Replace with (adding `checkIntervalMinutes`):
```js
export async function startCampaign({ profileIds, sheetUrl, templates, dailyLimit = 50, mode = 'connect_only', messageOpenProfiles = false, delayMin = 15, delayMax = 45, linkedinColumn = '', senderFirstNames = {}, concurrency = 1, name = '', acceptanceTrackingDays = 0, preflightCheckStatus = false, checkIntervalMinutes = 60, createdBy = null }) {
```

Then find the existing block where templates/senderFirstNames/etc. get stashed on `campaign` (the lines about "monitoring path can read them"), and add:

```js
  // v2.14.x: operator-chosen cadence for the monitoring auto-trigger.
  // Read by transitionToMonitoring (initial nextCheckAt) and by
  // tickMonitoringNow (reschedule after each fire). Persisted via
  // monitoring-persistence so post-restart rehydration honors it.
  campaign.checkIntervalMinutes = checkIntervalMinutes;
```

- [ ] **Step 4: Extract `tickMonitoringNow` function**

Replace the entire `startMonitoringWatcher` block (currently `src/campaign.js:3069-3093`) with:

```js
/**
 * v2.14 — Module-level tick callback. Two duties on each fire:
 *   1. T+7d auto-end: if monitoringUntil has elapsed, stop monitoring.
 *   2. Auto-check: if nextCheckAt is overdue, fire runMonitoringCheckAll
 *      and reschedule nextCheckAt by the operator-chosen cadence.
 *
 * Re-entrancy guard (_checkInProgress) prevents double-fire when the bulk
 * check takes longer than the heartbeat interval.
 *
 * The `_testStub` param is for unit tests only — when provided, it
 * replaces runMonitoringCheckAll. Production callers omit it.
 */
let _monitoringWatcherTimer = null;
let _checkInProgress = false;

export async function tickMonitoringNow({ _testStub = null } = {}) {
  try {
    if (campaign.state !== 'monitoring') return;

    // Duty 1: 7-day window expiry (existing behavior)
    if (campaign.monitoringUntil) {
      const until = new Date(campaign.monitoringUntil).getTime();
      if (Date.now() >= until) {
        await stopMonitoring({ reason: 'window-elapsed' }).catch((err) => {
          console.warn('[monitoring-tick] stopMonitoring threw:', err.message);
        });
        return;
      }
    }

    // Duty 2: fire bulk-check + auto-intros when nextCheckAt is overdue
    if (!campaign.nextCheckAt) return;
    if (Date.now() < new Date(campaign.nextCheckAt).getTime()) return;
    if (_checkInProgress) return;

    _checkInProgress = true;
    const cadenceMin = campaign.checkIntervalMinutes || 60;
    const ts = `[${new Date().toISOString()}]`;
    campaign.logs = campaign.logs || [];
    campaign.logs.push(`${ts} 🛏 Monitoring · auto-check starting (cadence=${cadenceMin}m)`);

    try {
      if (_testStub) {
        await _testStub();
      } else {
        await runMonitoringCheckAll();
      }
    } catch (err) {
      console.warn('[monitoring-tick] runMonitoringCheckAll threw:', err.message);
    } finally {
      // Reschedule ONLY if still in monitoring state (operator may have stopped mid-fire)
      if (campaign.state === 'monitoring') {
        const ms = (campaign.checkIntervalMinutes || 60) * 60_000;
        campaign.nextCheckAt = new Date(Date.now() + ms).toISOString();
        try { await writeMonitoringState(campaign); } catch { /* */ }
        const hhmm = (d) => `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
        campaign.logs.push(`[${new Date().toISOString()}] 🛏 Monitoring · next check at ${hhmm(new Date(campaign.nextCheckAt))}`);
      }
      _checkInProgress = false;
    }
  } catch (err) {
    console.warn('[monitoring-tick] outer threw:', err.message);
    _checkInProgress = false;
  }
}

export function startMonitoringWatcher() {
  if (_monitoringWatcherTimer) return;
  _monitoringWatcherTimer = setInterval(() => {
    tickMonitoringNow().catch((err) => console.warn('[monitoring-watcher] tick threw:', err.message));
  }, 60 * 1000);
}

export function stopMonitoringWatcher() {
  if (_monitoringWatcherTimer) {
    clearInterval(_monitoringWatcherTimer);
    _monitoringWatcherTimer = null;
  }
}
```

Note: `writeMonitoringState` is already imported from `monitoring-persistence.js`; verify the import line at the top of `campaign.js` (around line 30) and add it if missing.

- [ ] **Step 5: Run tests, verify PASS**

```bash
node --test tests/monitoring-tick.test.js
```
All 4 tick tests must pass.

- [ ] **Step 6: Run full suite — no regressions**

```bash
node --test tests/
```
All prior tests must still pass. Especially watch for any test that asserts on the existing watcher behavior.

- [ ] **Step 7: Commit**

```bash
git add src/campaign.js tests/monitoring-tick.test.js
git commit -m "feat(monitoring): tickMonitoringNow fires bulk-check + auto-intros on cadence"
```

---

### Task 5: Server clamps `checkIntervalMinutes` + new `/api/monitoring/wake` endpoint

**Files:**
- Modify: `server.js` (start endpoint at line 500, monitoring routes around line 691)
- Test: `tests/server-checkinterval-clamp.test.js` (new) — pure helper test, not HTTP round-trip

- [ ] **Step 1: Write the failing test**

Create `tests/server-checkinterval-clamp.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert';

// Reproduce the clamp inline so we test the exact rule we wire into server.js.
function clampCadence(v) {
  return Math.max(15, Math.min(360, Number(v) || 60));
}

test('clamp accepts 60 (default)', () => assert.equal(clampCadence(60), 60));
test('clamp accepts 15 (floor)', () => assert.equal(clampCadence(15), 15));
test('clamp accepts 360 (ceiling)', () => assert.equal(clampCadence(360), 360));
test('clamp raises 5 to 15', () => assert.equal(clampCadence(5), 15));
test('clamp lowers 9999 to 360', () => assert.equal(clampCadence(9999), 360));
test('clamp falls back to 60 on garbage', () => assert.equal(clampCadence('banana'), 60));
test('clamp falls back to 60 on undefined', () => assert.equal(clampCadence(undefined), 60));
```

- [ ] **Step 2: Run test, verify PASS**

```bash
node --test tests/server-checkinterval-clamp.test.js
```
This is purely a logic test; it should pass immediately. The test exists to lock the clamp contract.

- [ ] **Step 3: Plumb `checkIntervalMinutes` into `POST /api/campaign/start`**

In `server.js` find the destructure around line 500:

```js
const { profileIds, sheetUrl, templates, dailyLimit, mode, primaryName, ..., acceptanceTrackingDays, preflightCheckStatus } = body || {};
```

Add `checkIntervalMinutes` to the destructure list and to the config object that gets passed to `startCampaign`. Locate the existing config block (around line 519) and add:

```js
checkIntervalMinutes: Math.max(15, Math.min(360, Number(checkIntervalMinutes) || 60)),
```

- [ ] **Step 4: Add `/api/monitoring/wake` endpoint**

In `server.js`, after the existing `/api/monitoring/state` route (around line 737), add:

```js
// v2.14.x: macOS sleep-resume hook. Called by electron/main.js when the
// system wakes — kicks an immediate tick so an overdue auto-check fires
// without waiting up to 60s for the next setInterval boundary.
app.post('/api/monitoring/wake', async (_req, res) => {
  try {
    const { tickMonitoringNow } = await import('./src/campaign.js');
    tickMonitoringNow().catch((err) => console.warn('[wake] tick threw:', err.message));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 5: Run full suite**

```bash
node --test tests/
```

- [ ] **Step 6: Commit**

```bash
git add server.js tests/server-checkinterval-clamp.test.js
git commit -m "feat(monitoring): server clamps checkIntervalMinutes + adds /api/monitoring/wake"
```

---

### Task 6: Electron `powerMonitor` resume hook

**Files:**
- Modify: `electron/main.js`

No test — Electron-side code, manual verification only.

- [ ] **Step 1: Add `powerMonitor` import and resume listener**

At the top of `electron/main.js`, find the existing Electron imports and add `powerMonitor`. Then in the `app.whenReady().then(...)` block (around line 173), after `tray = new Tray(...)`, add:

```js
      // v2.14.x: macOS sleep-resume hook. When the lid opens (or the system
      // wakes from sleep), ping the server's monitoring-wake endpoint so an
      // overdue auto-check fires immediately rather than waiting up to 60s
      // for the next setInterval tick.
      try {
        const { powerMonitor } = await import('electron');
        powerMonitor.on('resume', () => {
          if (!serverPort) return;
          fetch(`http://127.0.0.1:${serverPort}/api/monitoring/wake`, { method: 'POST' })
            .catch((err) => console.warn('[powerMonitor.resume] ping failed:', err.message));
        });
      } catch (err) {
        console.warn('[powerMonitor] setup failed:', err.message);
      }
```

(If `powerMonitor` is already imported statically at the top of the file, use that import instead of the dynamic one. Inspect imports first.)

- [ ] **Step 2: Manual verification**

```bash
pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "Electron.*ortus" 2>/dev/null
npm run dev:app > /tmp/dev-app.log 2>&1 &
```

Wait ~5s for the app to boot, then:
1. Launch a dummy CC+IC campaign (cadence=15min, 1 lead).
2. Wait for campaign to enter monitoring state.
3. Close the lid (or run `pmset sleepnow`).
4. Wait 30s.
5. Open the lid.
6. Watch `/tmp/dev-app.log` for `[wake] tick` or `Monitoring · auto-check starting`.

Expected: within a few seconds of wake, an auto-check fires.

- [ ] **Step 3: Commit**

```bash
git add electron/main.js
git commit -m "feat(monitoring): powerMonitor.resume kicks an immediate monitoring tick"
```

---

### Task 7: Wizard dropdown UI

**Files:**
- Modify: `public/index.html` (markup near line 265, after primary-person-block)
- Modify: `public/js/app.js` (payload construction at line 2482, visibility toggle wherever `primary-person-block` is shown/hidden)
- Modify: `public/css/style.css` (minor — match existing wizard row styles)

- [ ] **Step 1: Find the visibility-toggle code for primary-person-block**

```bash
grep -n "primary-person-block" /Users/antoniovarlese/ortus-gologin-clone/public/js/app.js | head -10
```

Note the function(s) that toggle `display` on `primary-person-block` — we'll add our new block to the same toggle so both appear/disappear together when mode changes.

- [ ] **Step 2: Add the dropdown markup**

In `public/index.html`, after the closing `</div>` of `primary-person-block` (line 265, before the closing `</div>` at line 267), insert:

```html
      <!-- v2.14.x: Auto-check cadence (CC+IC only). Sets how often the
           monitoring watcher fires the bulk-check + auto-intro DM during
           the 7-day acceptance window. -->
      <div id="check-cadence-block" style="display:none; margin-top:24px; padding:18px; border:1px solid var(--hairline); border-radius:6px; background:var(--bg-soft, #faf9f7);">
        <div style="font-family:var(--display); font-size:11px; letter-spacing:0.08em; text-transform:uppercase; color:var(--gray); margin-bottom:14px;">Auto-check &amp; intro cadence</div>
        <div style="display:flex; align-items:center; gap:10px; margin-bottom:6px;">
          <span style="font-size:0.95rem; color:var(--ink);">Every</span>
          <select id="check-cadence-select" style="background:transparent; border:none; border-bottom:1px solid var(--hairline); color:var(--ink); padding:6px 0; font-family:var(--body); font-size:0.95rem; outline:none;">
            <option value="15">15 minutes</option>
            <option value="30">30 minutes</option>
            <option value="60" selected>1 hour</option>
            <option value="90">1.5 hours</option>
            <option value="120">2 hours</option>
            <option value="180">3 hours</option>
            <option value="360">6 hours</option>
          </select>
        </div>
        <div style="font-size:11px; color:var(--gray); margin-top:8px">How often the app re-checks for new acceptances and fires the intro DM during the 7-day monitoring window. Faster cadences increase LinkedIn API load.</div>
      </div>
```

- [ ] **Step 3: Wire visibility toggle**

In `public/js/app.js`, find every place where `primary-person-block`'s `display` is set. Add a parallel update for `check-cadence-block`:

```js
const ccBlock = document.getElementById('check-cadence-block');
if (ccBlock) ccBlock.style.display = (mode === 'connect_and_introduce') ? '' : 'none';
```

- [ ] **Step 4: Send `checkIntervalMinutes` in the start payload**

In `public/js/app.js` around line 2510 (inside the `body` object passed to `submitStartCampaign`), add a new field after `preflightCheckStatus`:

```js
    // v2.14.x: operator-chosen cadence for the monitoring auto-trigger.
    // Only relevant for CC+IC mode; server clamps to [15, 360] and ignores
    // the field for non-CC+IC modes.
    checkIntervalMinutes: (() => {
      if (mode !== 'connect_and_introduce') return undefined;
      const v = parseInt(document.getElementById('check-cadence-select')?.value, 10);
      return Number.isFinite(v) ? v : 60;
    })(),
```

- [ ] **Step 5: Manual verification**

```bash
pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "Electron.*ortus" 2>/dev/null
npm run dev:app > /tmp/dev-app.log 2>&1 &
```

1. Cmd+R the dashboard to reload.
2. Open the launch wizard.
3. Switch mode to `Connect + Introduce Back` — the dropdown should appear under the primary-person block.
4. Switch mode to anything else — dropdown should hide.
5. Pick a non-default value (e.g. 30 min), open devtools network tab, click Start, verify the `POST /api/campaign/start` request body contains `"checkIntervalMinutes": 30`.

- [ ] **Step 6: Commit**

```bash
git add public/index.html public/js/app.js
git commit -m "feat(monitoring): wizard dropdown sends checkIntervalMinutes for CC+IC campaigns"
```

---

### Task 8: "Checking now…" feedback in cockpit + run-bar

**Files:**
- Modify: `src/campaign.js` (`getCampaignStatus` — add `_checkInProgress` to payload)
- Modify: `public/js/app.js` (cockpit + run-bar rendering — show "checking now…" when flag is true)

- [ ] **Step 1: Export `_checkInProgress` status**

In `src/campaign.js`, add a getter near `getCampaignState` (around line 3151):

```js
export function isMonitoringCheckInProgress() {
  return _checkInProgress;
}
```

Then in `getCampaignStatus` (search for the function — likely around line 2960-2980), add to the returned object:

```js
    monitoringCheckInProgress: _checkInProgress,
```

- [ ] **Step 2: Read the flag in `public/js/app.js` cockpit render**

In `public/js/app.js`, find the monitoring branch of `renderCockpit` (the block that displays `next HH:MM · ends in Xd Yh`). Replace the existing text with a conditional:

```js
const monoLine = c.monitoringCheckInProgress
  ? 'checking now…'
  : `next ${nextHHMM} · ends in ${remaining}`;
```

(Adapt to the exact variable names used in the existing block.)

- [ ] **Step 3: Read the flag in the run-bar mirror**

In `public/js/app.js`'s `initRunBarMirror` sync function, find the existing monitoring branch and apply the same conditional swap.

- [ ] **Step 4: Manual verification**

```bash
pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "Electron.*ortus" 2>/dev/null
npm run dev:app > /tmp/dev-app.log 2>&1 &
```

1. Reload dashboard.
2. Launch a CC+IC campaign with cadence=15min and a 1-lead sheet.
3. Wait ~15 min for the first auto-check to fire.
4. Watch the cockpit's monospace label — it should briefly flip to `checking now…` during the bulk-check, then back to `next HH:MM · ends in …`.

- [ ] **Step 5: Commit**

```bash
git add src/campaign.js public/js/app.js
git commit -m "feat(monitoring): cockpit shows 'checking now…' while bulk-check runs"
```

---

### Final Verification

After all 8 tasks:

- [ ] **Run full test suite**
  ```bash
  node --test tests/
  ```
  All tests pass.

- [ ] **Manual end-to-end**
  1. Launch CC+IC campaign with cadence=15min, 1 dummy lead.
  2. Confirm cockpit displays "next HH:MM (15min from now)".
  3. After ~15min, confirm the log shows `🛏 Monitoring · auto-check starting (cadence=15m)`.
  4. Confirm cockpit shows `checking now…` during the check.
  5. After check completes, confirm cockpit shows `next HH:MM` (another 15min).
  6. Close laptop, open after 30min, confirm an auto-check fires within seconds of wake.

- [ ] **Auto-relaunch dev:app** (per operator rule):
  ```bash
  pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "Electron.*ortus" 2>/dev/null
  npm run dev:app > /tmp/dev-app.log 2>&1 &
  ```

No push yet — user is bundling this with other unrelated fixes for a single GitHub push later.
