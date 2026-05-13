# Monitoring Phase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the Monitoring Phase for `connect_and_introduce` campaigns per `docs/superpowers/specs/2026-05-13-monitoring-phase-design.md`. End-of-list bulk-check fires immediately, campaign transitions to a new `monitoring` state for exactly 7 days, the same log stream stays live, the Schedules-lane card surfaces it in the dashboard, the schedule survives restart, and the misleading "daily limit" copy is renamed.

**Architecture:** Add a new campaign state `monitoring` between `running` and `done`. Persisted fields `sendingEndedAt`, `monitoringUntil`, `nextCheckAt`, `participatingProfileIds` drive the lifecycle. Pure time-math helpers (`computeMonitoringUntil`, `recomputeNextCheckAt`) are extracted for testability. The existing `post-campaign-bulk-check.js` scheduler is extended with a `logAppend` callback so 6-hourly check logs go into the campaign's own log array. A new dashboard renderer adds the Monitoring card to the Schedules lane (collapsed + expandable). Operator escape hatches: `⚡ Check now` and `✕ Stop monitoring`. Restart-resume rehydrates the schedule from disk.

**Tech Stack:** Node 22+ ESM, Electron, Express 4, vanilla JS frontend, `node --test`, GoLogin SDK 2.2.8, puppeteer-core ^22.15.0. No new deps.

**Off-limits files:** `src/linkedin/outreach.js`, `src/linkedin/actions.js` — do not modify. Read-only.

**Pre-flight:** Every task that touches `google-apps-script.js` must `cp` the same content to `/Users/antoniovarlese/Desktop/ortus-outreach-sheets-bridge.gs` in the same commit. (Per durable user rule.) No Apps Script changes are expected in this plan, but the rule stands.

**After each commit:** Kill + restart `npm run dev:app` in the background. (Per durable user rule.)

---

## Task 1: Time-math helpers (pure)

**Files:**
- Create: `src/monitoring-time.js`
- Test:   `tests/monitoring-time.test.js`

- [ ] **Step 1: Write failing tests first**

```js
// tests/monitoring-time.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMonitoringUntil, recomputeNextCheckAt, MONITORING_WINDOW_MS, CHECK_INTERVAL_MS } from '../src/monitoring-time.js';

const ISO = (s) => new Date(s);

test('computeMonitoringUntil returns sendingEndedAt + 7 days exactly', () => {
  const sent = ISO('2026-05-13T01:31:45.000Z');
  const until = computeMonitoringUntil(sent);
  assert.equal(until.toISOString(), '2026-05-20T01:31:45.000Z');
});

test('MONITORING_WINDOW_MS is exactly 7 days', () => {
  assert.equal(MONITORING_WINDOW_MS, 7 * 24 * 60 * 60 * 1000);
});

test('CHECK_INTERVAL_MS is exactly 6 hours', () => {
  assert.equal(CHECK_INTERVAL_MS, 6 * 60 * 60 * 1000);
});

test('recomputeNextCheckAt returns the next 6h boundary >= now', () => {
  const sent = ISO('2026-05-13T01:00:00.000Z');
  // 4 hours later — next boundary is sent + 6h = 07:00
  assert.equal(recomputeNextCheckAt(sent, ISO('2026-05-13T05:00:00.000Z')).toISOString(), '2026-05-13T07:00:00.000Z');
});

test('recomputeNextCheckAt skips past multiple intervals if now is far ahead', () => {
  const sent = ISO('2026-05-13T01:00:00.000Z');
  // 25 hours later — next boundary is sent + 30h = 07:00 next day
  assert.equal(recomputeNextCheckAt(sent, ISO('2026-05-14T02:00:00.000Z')).toISOString(), '2026-05-14T07:00:00.000Z');
});

test('recomputeNextCheckAt returns sendingEndedAt + 6h when now == sendingEndedAt', () => {
  const sent = ISO('2026-05-13T01:00:00.000Z');
  assert.equal(recomputeNextCheckAt(sent, sent).toISOString(), '2026-05-13T07:00:00.000Z');
});

test('recomputeNextCheckAt: exactly on a boundary returns the NEXT boundary (strict > not >=)', () => {
  const sent = ISO('2026-05-13T01:00:00.000Z');
  const exactBoundary = ISO('2026-05-13T07:00:00.000Z');
  assert.equal(recomputeNextCheckAt(sent, exactBoundary).toISOString(), '2026-05-13T13:00:00.000Z');
});

test('recomputeNextCheckAt accepts both Date and ISO-string inputs', () => {
  const r = recomputeNextCheckAt('2026-05-13T01:00:00.000Z', '2026-05-13T05:00:00.000Z');
  assert.equal(r.toISOString(), '2026-05-13T07:00:00.000Z');
});
```

- [ ] **Step 2: Run tests; confirm they fail**

```
node --test tests/monitoring-time.test.js
# Expected: module not found / cannot import
```

- [ ] **Step 3: Implement helpers**

```js
// src/monitoring-time.js
export const MONITORING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

function _toDate(d) {
  return d instanceof Date ? d : new Date(d);
}

export function computeMonitoringUntil(sendingEndedAt) {
  const s = _toDate(sendingEndedAt);
  return new Date(s.getTime() + MONITORING_WINDOW_MS);
}

/**
 * Returns the next 6h check boundary strictly AFTER `now`, measured from
 * `sendingEndedAt`. If `now` lands exactly on a boundary, returns the next
 * one (strict >).
 */
export function recomputeNextCheckAt(sendingEndedAt, now) {
  const s = _toDate(sendingEndedAt).getTime();
  const n = _toDate(now).getTime();
  const elapsed = n - s;
  const ticksPassed = Math.floor(elapsed / CHECK_INTERVAL_MS) + 1;
  return new Date(s + ticksPassed * CHECK_INTERVAL_MS);
}
```

- [ ] **Step 4: Run tests; confirm pass**

```
node --test tests/monitoring-time.test.js
# Expected: 7/7 pass
```

- [ ] **Step 5: Commit**

```
git add src/monitoring-time.js tests/monitoring-time.test.js
git commit -m "feat(monitoring): add time-math helpers (computeMonitoringUntil, recomputeNextCheckAt)"
```

---

## Task 2: End-of-list detection (pure helper)

**Files:**
- Modify or create: helper exported from `src/campaign.js` (or new `src/end-of-list.js` if exporting from campaign.js creates a circular)
- Test: `tests/end-of-list-detection.test.js`

- [ ] **Step 1: Write failing tests**

```js
// tests/end-of-list-detection.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isEndOfList } from '../src/end-of-list.js';

test('isEndOfList: all queues empty + no in-flight → true', () => {
  const state = {
    queuesByProfile: { p1: [], p2: [] },
    inFlight: new Set(),
    connectionSentCount: { p1: 3, p2: 2 },
  };
  assert.equal(isEndOfList(state), true);
});

test('isEndOfList: non-empty queue → false', () => {
  const state = {
    queuesByProfile: { p1: [], p2: ['lead-x'] },
    inFlight: new Set(),
    connectionSentCount: { p1: 1, p2: 0 },
  };
  assert.equal(isEndOfList(state), false);
});

test('isEndOfList: in-flight request → false', () => {
  const state = {
    queuesByProfile: { p1: [], p2: [] },
    inFlight: new Set(['p1:lead-x']),
    connectionSentCount: { p1: 1, p2: 1 },
  };
  assert.equal(isEndOfList(state), false);
});

test('isEndOfList: zero connection_sent across all accounts → false (campaign never really started sending)', () => {
  const state = {
    queuesByProfile: { p1: [], p2: [] },
    inFlight: new Set(),
    connectionSentCount: { p1: 0, p2: 0 },
  };
  assert.equal(isEndOfList(state), false);
});

test('isEndOfList: at least one connection_sent + queues empty + no in-flight → true', () => {
  const state = {
    queuesByProfile: { p1: [], p2: [] },
    inFlight: new Set(),
    connectionSentCount: { p1: 0, p2: 1 },
  };
  assert.equal(isEndOfList(state), true);
});
```

- [ ] **Step 2: Run tests; confirm fail**

- [ ] **Step 3: Implement helper**

```js
// src/end-of-list.js
/**
 * Returns true exactly when:
 *   - every account's lead queue is empty
 *   - no requests are in flight
 *   - AND at least one account has sent ≥1 connection request
 *     (a campaign that processed zero leads is "skipped", not "end-of-list")
 */
export function isEndOfList(state) {
  const queues = state.queuesByProfile || {};
  for (const k of Object.keys(queues)) {
    if (queues[k] && queues[k].length > 0) return false;
  }
  if (state.inFlight && state.inFlight.size > 0) return false;
  const counts = state.connectionSentCount || {};
  let total = 0;
  for (const k of Object.keys(counts)) total += counts[k] || 0;
  return total > 0;
}
```

- [ ] **Step 4: Run tests; confirm pass**

- [ ] **Step 5: Commit**

```
git add src/end-of-list.js tests/end-of-list-detection.test.js
git commit -m "feat(monitoring): add isEndOfList pure helper"
```

---

## Task 3: State machine — running → monitoring transition

**Files:**
- Modify: `src/campaign.js` (transition function + persisted fields on campaign object)
- Test: `tests/monitoring-state-transitions.test.js`

- [ ] **Step 1: Write failing tests (extract a pure transitionToMonitoring helper)**

```js
// tests/monitoring-state-transitions.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transitionToMonitoring } from '../src/campaign-state-transitions.js';

test('transitionToMonitoring: mode != connect_and_introduce → returns unchanged campaign with state=done', () => {
  const campaign = { id: 'c1', mode: 'connect_only', state: 'running', logs: [] };
  const out = transitionToMonitoring(campaign, { now: new Date('2026-05-13T01:31:45Z'), participatingProfileIds: ['p1'] });
  assert.equal(out.state, 'done');
  assert.equal(out.sendingEndedAt, undefined);
});

test('transitionToMonitoring: connect_and_introduce → state=monitoring with all fields populated', () => {
  const campaign = { id: 'c1', mode: 'connect_and_introduce', state: 'running', logs: [] };
  const now = new Date('2026-05-13T01:31:45Z');
  const out = transitionToMonitoring(campaign, { now, participatingProfileIds: ['p1', 'p2'] });
  assert.equal(out.state, 'monitoring');
  assert.equal(out.sendingEndedAt, now.toISOString());
  assert.equal(out.monitoringUntil, '2026-05-20T01:31:45.000Z');
  assert.equal(out.nextCheckAt, '2026-05-13T07:31:45.000Z');
  assert.deepEqual(out.participatingProfileIds, ['p1', 'p2']);
});

test('transitionToMonitoring is idempotent — calling twice does not advance times', () => {
  const campaign = { id: 'c1', mode: 'connect_and_introduce', state: 'running', logs: [] };
  const now1 = new Date('2026-05-13T01:31:45Z');
  const once = transitionToMonitoring(campaign, { now: now1, participatingProfileIds: ['p1'] });
  const now2 = new Date('2026-05-13T03:00:00Z');
  const twice = transitionToMonitoring(once, { now: now2, participatingProfileIds: ['p1'] });
  assert.equal(twice.sendingEndedAt, once.sendingEndedAt);
  assert.equal(twice.monitoringUntil, once.monitoringUntil);
});

test('transitionToMonitoring: empty participatingProfileIds → state=done (no accounts ever sent)', () => {
  const campaign = { id: 'c1', mode: 'connect_and_introduce', state: 'running', logs: [] };
  const out = transitionToMonitoring(campaign, { now: new Date(), participatingProfileIds: [] });
  assert.equal(out.state, 'done');
});

test('transitionToMonitoring appends a "Monitoring started" log line', () => {
  const campaign = { id: 'c1', mode: 'connect_and_introduce', state: 'running', logs: [] };
  const out = transitionToMonitoring(campaign, { now: new Date('2026-05-13T01:31:45Z'), participatingProfileIds: ['p1'] });
  const last = out.logs[out.logs.length - 1];
  assert.match(last, /Monitoring started/);
  assert.match(last, /07:31/);  // next check time
});
```

- [ ] **Step 2: Run tests; confirm fail**

- [ ] **Step 3: Implement transition helper**

```js
// src/campaign-state-transitions.js
import { computeMonitoringUntil, recomputeNextCheckAt } from './monitoring-time.js';

function _hhmm(d) {
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function _logTs(d) {
  return `[${d.toISOString()}]`;
}

export function transitionToMonitoring(campaign, { now, participatingProfileIds }) {
  // Idempotent — already transitioned
  if (campaign.state === 'monitoring' || campaign.state === 'done') return campaign;

  if (campaign.mode !== 'connect_and_introduce' || !participatingProfileIds || participatingProfileIds.length === 0) {
    return { ...campaign, state: 'done' };
  }

  const sendingEndedAt = new Date(now);
  const monitoringUntil = computeMonitoringUntil(sendingEndedAt);
  const nextCheckAt = recomputeNextCheckAt(sendingEndedAt, sendingEndedAt);
  const logs = [...(campaign.logs || []), `${_logTs(sendingEndedAt)} 🛏 Monitoring started · next check at ${_hhmm(nextCheckAt)}`];

  return {
    ...campaign,
    state: 'monitoring',
    sendingEndedAt: sendingEndedAt.toISOString(),
    monitoringUntil: monitoringUntil.toISOString(),
    nextCheckAt: nextCheckAt.toISOString(),
    participatingProfileIds: [...participatingProfileIds],
    logs,
  };
}
```

- [ ] **Step 4: Run tests; confirm pass**

- [ ] **Step 5: Commit**

```
git add src/campaign-state-transitions.js tests/monitoring-state-transitions.test.js
git commit -m "feat(monitoring): add transitionToMonitoring pure helper + state fields"
```

---

## Task 4: Wire end-of-list bulk-check + state transition into campaign.js

**Files:**
- Modify: `src/campaign.js` — at end of worker pool, fire end-of-list bulk-check then call `transitionToMonitoring`

**Note:** This task makes the only modification to `src/campaign.js`'s worker-pool body. Re-uses `runIdleBulkCheck` (already exists) and `runAutoIntros` (already exists). Off-limits files NOT touched.

- [ ] **Step 1: Read campaign.js worker pool around line 2476 (idle bulk-check) and the campaign-done path around line 2620-2660 to identify the exact insertion point**

- [ ] **Step 2: Add end-of-list trigger after worker pool exits but before campaign-done writeback**

Insertion logic (paraphrased — exact placement decided by implementer subagent after reading context):

```js
// After worker pool's await Promise.all(workers) line, before existing post-campaign-bulk-check registration:
if (mode === 'connect_and_introduce') {
  const participating = Array.from(profilesThatSentAtLeastOne);
  if (participating.length > 0) {
    log(`📡 End-of-list bulk check · ${participating.length} account(s)`);
    for (const profileId of participating) {
      const pName = profileNames[profileId] || profileId;
      try {
        await runIdleBulkCheck(profileId, pName);  // already implemented; closes browser after
      } catch (err) {
        log(`  ⚠ [${pName}] End-of-list bulk check threw: ${err.message}`);
      }
    }
  }

  // Transition to monitoring state
  const updated = transitionToMonitoring(campaign, {
    now: new Date(),
    participatingProfileIds: participating,
  });
  Object.assign(campaign, updated);
  await persistCampaignState(campaign);     // existing writer
}
```

- [ ] **Step 3: Track participating accounts**

Add a `Set<string>` named `profilesThatSentAtLeastOne` near the worker-pool init. Add `profilesThatSentAtLeastOne.add(profileId)` to the existing `result.action === 'connection_sent'` branch around line 2137.

- [ ] **Step 4: Run full test suite**

```
npm test
# Expected: all existing pass + new tests from Tasks 1-3 pass
```

- [ ] **Step 5: Commit**

```
git add src/campaign.js
git commit -m "feat(monitoring): wire end-of-list bulk-check + running→monitoring transition"
```

- [ ] **Step 6: Restart dev:app**

```
pkill -f "npm run dev:app"; sleep 1; nohup npm run dev:app > /tmp/ortus-dev-app.log 2>&1 & disown
```

---

## Task 5: Pipe scheduled-job logs into campaign.logs

**Files:**
- Modify: `src/linkedin/post-campaign-bulk-check.js`
- Modify: `src/campaign.js` (call site that registers the schedule)
- Test:   `tests/monitoring-log-append.test.js`

- [ ] **Step 1: Write failing tests**

```js
// tests/monitoring-log-append.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _testOnly_buildAppendLogger } from '../src/linkedin/post-campaign-bulk-check.js';

test('buildAppendLogger appends ISO-prefixed line to provided logs array', () => {
  const logs = [];
  const appender = _testOnly_buildAppendLogger({ logs, capLines: 100 });
  appender('hello');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^\[\d{4}-\d{2}-\d{2}T/);
  assert.match(logs[0], /hello$/);
});

test('buildAppendLogger respects ring-buffer cap', () => {
  const logs = ['old-line'];
  const appender = _testOnly_buildAppendLogger({ logs, capLines: 2 });
  appender('a');
  appender('b');
  assert.deepEqual(logs.map(l => l.replace(/^\[[^\]]+\] /, '')), ['a', 'b']);
});

test('buildAppendLogger is a no-op when logs array is null', () => {
  const appender = _testOnly_buildAppendLogger({ logs: null, capLines: 100 });
  // Must not throw
  appender('hello');
});
```

- [ ] **Step 2: Run tests; confirm fail**

- [ ] **Step 3: Extract `_testOnly_buildAppendLogger` and accept it in scheduled-job runner**

In `src/linkedin/post-campaign-bulk-check.js`:

```js
export function _testOnly_buildAppendLogger({ logs, capLines = 5000 }) {
  return function appendLog(line) {
    if (!Array.isArray(logs)) return;
    const ts = `[${new Date().toISOString()}]`;
    logs.push(`${ts} ${line}`);
    while (logs.length > capLines) logs.shift();
  };
}
```

In the existing `runScheduledBulkCheck` function (or whatever the scheduled-job entry point is named), accept an optional `onLog` callback and call it alongside the existing `console.log`. Wire `onLog` everywhere a status line is emitted:
- Start of pass
- Per-account check result
- Per-intro DM result
- End of pass + next-check time

- [ ] **Step 4: Wire at registration site in campaign.js**

In the existing post-campaign-bulk-check registration loop (around lines 2629-2648), pass `{ onLog: _testOnly_buildAppendLogger({ logs: campaign.logs, capLines: campaign._logCap || 5000 }) }`.

- [ ] **Step 5: Run tests; confirm pass**

```
npm test
```

- [ ] **Step 6: Commit + restart dev:app**

```
git add src/linkedin/post-campaign-bulk-check.js src/campaign.js tests/monitoring-log-append.test.js
git commit -m "feat(monitoring): pipe scheduled bulk-check logs into campaign.logs"
pkill -f "npm run dev:app"; sleep 1; nohup npm run dev:app > /tmp/ortus-dev-app.log 2>&1 & disown
```

---

## Task 6: Stop monitoring + T+7d auto-end

**Files:**
- Modify: `src/campaign.js` — add `stopMonitoring(campaign, { reason })` function + auto-end timer
- Modify: `src/sheets-writer.js` — re-use existing `updateSheetRow` to stamp pending leads
- Test:   `tests/stop-monitoring.test.js`

- [ ] **Step 1: Write failing tests**

```js
// tests/stop-monitoring.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStillPendingUrls, buildClosedNotConnectedUpdate } from '../src/stop-monitoring.js';

const ROWS = [
  { 'LinkedIn URL': 'https://linkedin.com/in/a', 'Connection Request Status': 'Connection Request Sent', 'Connection Accepted Status': '' },
  { 'LinkedIn URL': 'https://linkedin.com/in/b', 'Connection Request Status': 'Connection Request Sent', 'Connection Accepted Status': 'Connected' },
  { 'LinkedIn URL': 'https://linkedin.com/in/c', 'Connection Request Status': '', 'Connection Accepted Status': '' },
];

test('computeStillPendingUrls returns URLs that sent a request but never got accepted', () => {
  const pending = computeStillPendingUrls(ROWS, 'LinkedIn URL');
  assert.deepEqual(pending, ['https://linkedin.com/in/a']);
});

test('computeStillPendingUrls ignores rows that were never sent a request', () => {
  const pending = computeStillPendingUrls(ROWS, 'LinkedIn URL');
  assert.equal(pending.includes('https://linkedin.com/in/c'), false);
});

test('buildClosedNotConnectedUpdate produces a sheet-writer payload', () => {
  const u = buildClosedNotConnectedUpdate();
  assert.equal(u.connectionRequestStatus, 'Closed - Not Connected');
});
```

- [ ] **Step 2: Run tests; confirm fail**

- [ ] **Step 3: Implement helpers**

```js
// src/stop-monitoring.js
export function computeStillPendingUrls(rows, linkedinColumn) {
  const out = [];
  for (const r of rows) {
    const url = r[linkedinColumn];
    if (!url) continue;
    const sent = (r['Connection Request Status'] || '').toString().toLowerCase();
    const accepted = (r['Connection Accepted Status'] || '').toString().toLowerCase();
    if (sent.includes('connection request sent') && !accepted.includes('connected')) {
      out.push(url);
    }
  }
  return out;
}

export function buildClosedNotConnectedUpdate() {
  return { connectionRequestStatus: 'Closed - Not Connected' };
}
```

- [ ] **Step 4: Add `stopMonitoring(campaign, { reason })` in campaign.js**

Behavior:
1. Fetch sheet via `fetchSheet(sheetUrl)`
2. Compute still-pending URLs via `computeStillPendingUrls`
3. For each URL, `updateSheetRow(sheetUrl, url, buildClosedNotConnectedUpdate(), linkedinColumn)`
4. Append `🛏 Monitoring ended · N still-pending leads stamped Closed - Not Connected` to campaign.logs
5. Set `campaign.state = 'done'`
6. Persist
7. Tear down the scheduled-job timer for this campaign

- [ ] **Step 5: Add T+7d auto-end watcher**

A single setInterval (60s) inspects all monitoring campaigns; for each one where `monitoringUntil <= now`, calls `stopMonitoring(campaign, { reason: 'window-elapsed' })`. Started at app launch, paused at app quit.

- [ ] **Step 6: Run tests + commit + restart**

```
npm test
git add src/stop-monitoring.js src/campaign.js tests/stop-monitoring.test.js
git commit -m "feat(monitoring): stop-monitoring + T+7d auto-end"
pkill -f "npm run dev:app"; sleep 1; nohup npm run dev:app > /tmp/ortus-dev-app.log 2>&1 & disown
```

---

## Task 7: Restart resume

**Files:**
- Modify: `src/campaign.js` — campaign loader at app start
- Test:   `tests/monitoring-resume.test.js`

- [ ] **Step 1: Write failing tests**

```js
// tests/monitoring-resume.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideResumeAction } from '../src/monitoring-resume.js';

const FIXED_NOW = new Date('2026-05-15T10:00:00Z');

test('decideResumeAction: state=monitoring + window not expired → "resume"', () => {
  const c = { state: 'monitoring', sendingEndedAt: '2026-05-13T01:00:00Z', monitoringUntil: '2026-05-20T01:00:00Z', nextCheckAt: '2026-05-15T07:00:00Z' };
  const r = decideResumeAction(c, FIXED_NOW);
  assert.equal(r.action, 'resume');
  assert.equal(r.recomputedNextCheckAt.toISOString(), '2026-05-15T13:00:00.000Z');  // next 6h boundary after FIXED_NOW
});

test('decideResumeAction: state=monitoring + monitoringUntil <= now → "expire"', () => {
  const c = { state: 'monitoring', sendingEndedAt: '2026-05-01T01:00:00Z', monitoringUntil: '2026-05-08T01:00:00Z' };
  const r = decideResumeAction(c, FIXED_NOW);
  assert.equal(r.action, 'expire');
});

test('decideResumeAction: state=done → "noop"', () => {
  const c = { state: 'done' };
  const r = decideResumeAction(c, FIXED_NOW);
  assert.equal(r.action, 'noop');
});

test('decideResumeAction: state=running → "noop"', () => {
  const c = { state: 'running' };
  const r = decideResumeAction(c, FIXED_NOW);
  assert.equal(r.action, 'noop');
});
```

- [ ] **Step 2: Run tests; confirm fail**

- [ ] **Step 3: Implement**

```js
// src/monitoring-resume.js
import { recomputeNextCheckAt } from './monitoring-time.js';

export function decideResumeAction(campaign, now) {
  if (campaign.state !== 'monitoring') return { action: 'noop' };
  const until = new Date(campaign.monitoringUntil);
  if (until.getTime() <= new Date(now).getTime()) return { action: 'expire' };
  const recomputedNextCheckAt = recomputeNextCheckAt(campaign.sendingEndedAt, now);
  return { action: 'resume', recomputedNextCheckAt };
}
```

- [ ] **Step 4: Wire into campaign loader**

In the existing campaign-state hydration at app start (find via `grep -n "loadCampaignState\|hydrateCampaigns" src/`):

```js
for (const c of loadedCampaigns) {
  const r = decideResumeAction(c, new Date());
  if (r.action === 'expire') {
    await stopMonitoring(c, { reason: 'window-elapsed-on-restart' });
  } else if (r.action === 'resume') {
    c.nextCheckAt = r.recomputedNextCheckAt.toISOString();
    appendLog(c, `🛏 Monitoring resumed · next check at ${_hhmm(r.recomputedNextCheckAt)}`);
    registerPostCampaignSchedule(c);  // existing function
  }
}
```

- [ ] **Step 5: Run tests + commit + restart**

```
npm test
git add src/monitoring-resume.js src/campaign.js tests/monitoring-resume.test.js
git commit -m "feat(monitoring): restart resume for in-flight monitoring campaigns"
pkill -f "npm run dev:app"; sleep 1; nohup npm run dev:app > /tmp/ortus-dev-app.log 2>&1 & disown
```

---

## Task 8: Dashboard Schedules-lane card (UI)

**Files:**
- Modify: `public/js/app.js` — add `renderMonitoringCard(campaign)` + integrate with Schedules lane render
- Modify: `public/css/style.css` — add `.mon-card`, `.mon-badge`, `.mon-counts`, `.mon-log` styles (copy from the sketch)
- Modify: `public/index.html` — ensure the Schedules lane container exists (it already does — `#schedules-campaign-list`)

**Reference:** `public/sketches/monitoring-phase-sketch.html` is the visual contract. Match it pixel-for-pixel where possible.

- [ ] **Step 1: Add CSS from sketch**

Copy the `.mon-*` rules from `public/sketches/monitoring-phase-sketch.html`'s `<style>` block into `public/css/style.css`. Strip the page-level reset (already in style.css) and the `.page-title` / `.demo-row` rules (sketch-only).

- [ ] **Step 2: Add `renderMonitoringCard(campaign)` in app.js**

Render the collapsed-by-default card. Expand on click. Show:
- Title + green/red badge (`> 24h` → green, `≤ 24h` → red ENDING SOON)
- Next-check countdown
- `⚡ Check now` / `✕ Stop monitoring` buttons
- Accounts list (one row per participating account with last-check timestamp)
- Counts (pending / connected & introduced / timed out)
- Live log (scrollable, max ~200px height)

- [ ] **Step 3: Hook into existing Schedules lane render**

Wherever `#schedules-campaign-list` is populated (grep `schedules-campaign-list` in app.js), prepend monitoring campaign cards before the existing cron-schedule entries.

- [ ] **Step 4: Wire backend endpoints**

Two new IPC handlers (find existing handlers via `grep "ipcMain.handle" src/`):
- `monitoring:check-now` — payload `{ campaignId }` → triggers an immediate bulk-check pass; updates `nextCheckAt` to "next 6h boundary from now" not from `sendingEndedAt`
- `monitoring:stop` — payload `{ campaignId }` → calls `stopMonitoring(campaign, { reason: 'operator-stopped' })`

- [ ] **Step 5: Confirm visual match in browser**

Open the dev:app, force a transition to monitoring by running a small test campaign (1 lead, 1 account). Confirm the card appears in Schedules lane. Compare against the sketch.

- [ ] **Step 6: Commit + restart**

```
git add public/js/app.js public/css/style.css
git commit -m "feat(monitoring): Schedules-lane card UI (collapsed + expanded)"
pkill -f "npm run dev:app"; sleep 1; nohup npm run dev:app > /tmp/ortus-dev-app.log 2>&1 & disown
```

---

## Task 9: Daily-limit copy rename

**Files:**
- Modify: `src/campaign.js` line 2195 — `Reached daily limit (N)` → `Reached campaign limit (N)`
- Modify: `src/campaign.js` line 1014 — launch summary log: append preset name if loaded from a preset
- Scan: any other user-facing text containing "daily limit" → rename

- [ ] **Step 1: Grep for all occurrences**

```
grep -rn "daily limit\|daily_limit\|Daily limit\|Daily Limit" src/ public/ 2>/dev/null
```

For each hit:
- If user-visible → rename to "campaign limit" (or "Campaign limit per account" in fuller contexts)
- If internal/variable name → leave alone

- [ ] **Step 2: Update launch summary log line**

Around `src/campaign.js:1014`, locate the line that logs `Campaign limit per account: ${dailyLimit}`. Add the preset-source suffix when the launch came from a loaded preset:

```js
const presetSuffix = launchedFromPreset ? `   (loaded from preset "${presetName}")` : '   (configured in launch wizard)';
log(`Campaign limit per account: ${dailyLimit}${presetSuffix}`);
```

The `launchedFromPreset` + `presetName` flags must be threaded through from the launch IPC payload. If they aren't already there, add them as optional fields (default null/false).

- [ ] **Step 3: Run full test suite (no new tests for this task — pure string change, low risk)**

```
npm test
```

- [ ] **Step 4: Commit + restart**

```
git add src/campaign.js public/js/app.js public/index.html
git commit -m "fix(copy): rename 'daily limit' to 'campaign limit' in operator-facing strings"
pkill -f "npm run dev:app"; sleep 1; nohup npm run dev:app > /tmp/ortus-dev-app.log 2>&1 & disown
```

---

## Task 10: Final integration check + manual UAT scaffold

**Files:**
- None modified (verification only)

- [ ] **Step 1: Run full test suite — must be all green**

```
npm test
# Expected: ALL pass, including all new tests from Tasks 1-9
```

- [ ] **Step 2: Linting / typecheck (if configured)**

```
npm run lint 2>/dev/null || true
```

- [ ] **Step 3: Smoke test the new flow**

Manual operator-driven flow (the implementer should NOT attempt to drive Electron headless):
1. Launch a Connect + Introduce Back campaign with 1 lead, 1 account, valid intro template
2. Observe: connection request sent
3. Observe within 30s: end-of-list bulk-check fires
4. Observe: `🛏 Monitoring started · next check at HH:MM` appears in the campaign log
5. Observe: campaign disappears from the active sending area, appears in Schedules lane as `BULK CONNECTION CHECK + INTRODUCE — Monitoring`
6. Click "Show details" — verify accounts, counts, log render correctly
7. Click `⚡ Check now` — verify immediate bulk-check fires + log updates
8. Quit the dev:app
9. Relaunch — verify Monitoring card reappears, log history intact, next-check time recomputed correctly
10. Click `✕ Stop monitoring` — verify confirm dialog appears, on confirm all still-pending leads in the sheet get `Closed - Not Connected` stamp, card disappears

- [ ] **Step 4: Update PR #17 description with the new scope**

```
gh pr edit 17 --repo ortusclub/ortus-outreach-installer --body "$(cat <<'EOF'
[Existing PR body content...]

## Update 2026-05-13: Monitoring Phase

Adds new `monitoring` state for connect_and_introduce campaigns. End-of-list bulk-check fires immediately. Campaign card lives in Schedules lane during the 7-day window. Log stream unified across Phase 1 + Phase 2. Daily-limit copy renamed. Restart-resumable.

See:
- Spec: `docs/superpowers/specs/2026-05-13-monitoring-phase-design.md`
- Plan: `docs/superpowers/plans/2026-05-13-monitoring-phase.md`
- Sketch: `public/sketches/monitoring-phase-sketch.html`

7 new test files / ~30 new tests. All passing.

UAT checklist (manual):
- [ ] End-of-list bulk-check fires within 30s of last invite
- [ ] Campaign moves to Schedules lane as "BULK CONNECTION CHECK + INTRODUCE — Monitoring"
- [ ] Live log shows continuous stream across phases
- [ ] Check now button fires immediate bulk-check
- [ ] Stop monitoring stamps still-pending leads Closed - Not Connected
- [ ] Quit + relaunch app, monitoring resumes correctly
- [ ] At T+7d the card auto-disappears
- [ ] "Reached campaign limit" replaces "Reached daily limit" in all operator-facing text
EOF
)"
```

- [ ] **Step 5: Push branch**

```
git push origin connect-introduce-back-v2.14
```

- [ ] **Step 6: Hand off to operator for UAT**

Tell Antonio:
- All automated tests pass
- Code is on `connect-introduce-back-v2.14` (PR #17)
- `dev:app` is freshly relaunched
- UAT checklist is in the PR body
- Boss can pull and test, or you can drive UAT yourself

---

## Plan self-review

**1. Spec coverage:**
- §3 state machine → Task 3 (transition) + Task 7 (resume) + Task 6 (stop) ✓
- §4 end-of-list → Task 2 (detection) + Task 4 (trigger) ✓
- §5 data shape → Task 3 (persisted fields) ✓
- §6 dashboard → Task 8 ✓
- §7 unified log → Task 5 ✓
- §8 restart resume → Task 7 ✓
- §9 daily-limit rename → Task 9 ✓
- §11 testing → tests inline with each task ✓
- §12 acceptance criteria → mapped to UAT in Task 10 ✓

All spec sections have a task.

**2. Placeholder scan:** No "TBD" / "implement later" / "add error handling" — every step shows code or exact command.

**3. Type consistency:** `transitionToMonitoring` exports verified consistent in Tasks 3 + 4. `decideResumeAction` consistent in Task 7. `stopMonitoring` referenced in Tasks 6 + 7 + 8 — must be exported from same module in Task 6.

**4. Off-limits guard:** Tasks 4 + 5 + 6 + 7 modify `src/campaign.js` but NOT `outreach.js` or `actions.js`. ✓

**5. Apps Script sync rule:** No task modifies `google-apps-script.js` — rule does not trigger. ✓

**6. dev:app relaunch rule:** Every commit-touching-running-code task has an explicit relaunch step. ✓

---

## Execution

Recommend: **Subagent-Driven Development** (per durable user rule — execute continuously, no proceed prompts between tasks).
