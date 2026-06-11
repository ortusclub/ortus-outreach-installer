# Logging Overhaul — Ops & Logs v2 + Campaign Activity v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Ortus Outreach's central logging durable and attributable — restore the frozen Operations Log as a single, overflow-proof, filterable event stream, and widen Campaign Activity into a funnel + leak scorecard — so "who did what from which account" and "where leads leak" are answerable at a glance.

**Architecture:** Three independent, separately-shippable phases. **Phase 0 (durability):** the app flushes the ops buffer on shutdown and raises an alert when flushes keep failing — so a blackout can never again go silently unnoticed. **Phase 1 (Ops Log v2):** replace the bridge's "one tab per campaign" design (which hit Google's 10M-cell ceiling and froze on 2026-06-10) with a single append-only `Events` tab plus three `QUERY`-driven view tabs; the app emits one structured event per lead outcome, classified by a new pure function. **Phase 2 (Campaign Activity v2):** a new pure tally accumulates the funnel + leak counters during a run, and the run-end row carries them into a widened sheet.

**Tech Stack:** Node ≥22, vanilla JS ES modules, `node --test` (no Jest/Vitest), Electron, Google Apps Script bridges (container-bound web apps). Off-limits files (`src/linkedin/outreach.js`, `src/linkedin/actions.js`) are **not** modified — the campaign loop already receives each lead's result and stamps the sheet; we hook telemetry at that same seam.

---

## Open decisions (defaults chosen — flag to user before Phase 2)

1. **Accepted/Replied timing.** Acceptances and replies happen *days after* a run (via monitoring sweeps), so they can't be frozen into the run-end row. **Default:** Campaign Activity stores run-end *snapshots* (usually low/zero for fresh CC); the live scorecard funnel (future/in-app or a Sheets `QUERY` view) reads current accepted/replied from the per-campaign leads sheet. This plan lands the *data*; the rendered "scorecard card" the user liked is a follow-up rendering step (Phase 3, not in this plan).
2. **Payload compatibility.** `opsLogEvent` is enriched with optional structured fields (`phase`, `outcome`, `reason`, `lead`) *alongside* the existing `severity`/`event`/`details`. The new bridge prefers the structured fields and falls back to deriving them from `event`/`severity` when absent — so during the rollout gap, an old app version still logs readable rows.
3. **Migration of old per-campaign tabs.** The new Ops Log bridge keeps the existing `Ortus Logs → Delete all log tabs` menu. Operator runs it once after deploy to free the overflowed cells; the new bridge then writes only to the single `Events` tab.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/linkedin/outcome-classify.js` | **create** | Pure `classifyOutcome({action, reason})` → `{phase, outcome, reason}`. The single mapping from the loop's action/skip taxonomy to log/funnel vocabulary. |
| `src/campaign-tally.js` | **create** | Pure `emptyTally()` + `applyOutcome(tally, classified)` → run-funnel/leak counters. |
| `src/log-writer.js` | modify | `opsLogEvent` accepts + buffers `phase`/`outcome`/`reason`/`lead`; flush-on-shutdown export; consecutive-failure alert hook. |
| `src/campaign.js` | modify | Emit one classified event per lead outcome + accumulate the tally; pass tally counters into `campaignLogAppendRun`; reach `_ops` from the per-lead seam. |
| `server.js` | modify | `gracefulShutdown` awaits `flushOpsLog()` before exit. |
| `electron/main.js` | modify | Electron quit path awaits `flushOpsLog()`. |
| `ops-log-bridge.js` | rewrite | Single `Events` tab schema + three `QUERY` view tabs; keep `deleteAllTabs`/menu. |
| `campaign-log-bridge.js` | modify | Widened `HEADERS`; `appendRun` writes new counters; idempotent header ensure for the existing sheet. |
| `tests/outcome-classify.test.js` | **create** | Unit tests for the classifier. |
| `tests/campaign-tally.test.js` | **create** | Unit tests for the tally. |
| `tests/log-writer.test.js` | modify | Tests for payload enrichment + flush-on-shutdown. |

---

## PHASE 0 — Durability (ship first; independent of the bridges)

### Task 1: Flush the ops buffer on shutdown

**Files:**
- Modify: `src/log-writer.js`
- Modify: `server.js:3756-3770` (`gracefulShutdown`)
- Modify: `electron/main.js` (quit path)
- Test: `tests/log-writer.test.js`

- [ ] **Step 1: Write the failing test**

Add to `tests/log-writer.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  opsLogEvent, flushOpsLog, _setFetchImpl, _setEnvImpl, _resetForTest, _peekBufferForTest,
} from '../src/log-writer.js';

test('flushOpsLog drains the buffer in one POST (shutdown path)', async () => {
  _resetForTest();
  _setEnvImpl(() => ({ OPS_LOG_WEBAPP_URL: 'https://example.test/ops', CAMPAIGN_LOG_WEBAPP_URL: '' }));
  const calls = [];
  _setFetchImpl(async (url, opts) => {
    calls.push(JSON.parse(opts.body));
    return { status: 200, text: async () => JSON.stringify({ success: true }) };
  });
  opsLogEvent({ name: 'C', startedAt: 't', operator: 'op' }, { event: 'X' });
  assert.equal(_peekBufferForTest().length, 1);
  const r = await flushOpsLog();
  assert.equal(r.ok, true);
  assert.equal(_peekBufferForTest().length, 0);
  assert.equal(calls[0].action, 'appendEvents');
  _resetForTest();
});
```

- [ ] **Step 2: Run it — expect PASS already** (flushOpsLog exists). This test pins current behavior so the next steps don't regress it.

Run: `node --test tests/log-writer.test.js`
Expected: PASS.

- [ ] **Step 3: Wire flush into `gracefulShutdown`**

In `server.js`, add the import near the other `src/` imports:

```js
import { flushOpsLog } from './src/log-writer.js';
```

In `gracefulShutdown` (server.js:3756), insert before `process.exit(0)` (line 3770):

```js
  // Drain the central Operations Log buffer before exit — otherwise the last
  // 0–30s of events (the ones not yet auto-flushed) are lost on every quit/
  // relaunch. Timeout-guarded so a dead network can't hang shutdown.
  try {
    await Promise.race([
      flushOpsLog(),
      new Promise((r) => setTimeout(r, 4000)),
    ]);
  } catch (_) { /* fire-and-forget */ }
```

- [ ] **Step 4: Wire flush into the Electron quit path**

In `electron/main.js`, locate `app.on('window-all-closed', ...)` (line 239) and the app-quit flow. Add a `before-quit` handler that drains via the running server's function. Since `electron/main.js` spawns/owns the Node server in-process, import and call:

```js
// At top with other requires/imports:
import { flushOpsLog } from '../src/log-writer.js';

let _flushedOnQuit = false;
app.on('before-quit', async (e) => {
  if (_flushedOnQuit) return;
  e.preventDefault();
  _flushedOnQuit = true;
  try { await Promise.race([flushOpsLog(), new Promise((r) => setTimeout(r, 4000))]); } catch (_) {}
  app.quit();
});
```

(If `electron/main.js` uses CommonJS `require`, use `const { flushOpsLog } = require('../src/log-writer.js')` — match the file's existing module style. Verify by reading the top of `electron/main.js` first.)

- [ ] **Step 5: Run the test suite**

Run: `node --test tests/log-writer.test.js`
Expected: PASS, no warnings.

- [ ] **Step 6: Commit**

```bash
git add src/log-writer.js server.js electron/main.js tests/log-writer.test.js
git commit -m "fix(logs): flush ops buffer on shutdown so events aren't lost on relaunch"
```

### Task 2: Alert when flushes keep failing (no more silent 33h blackouts)

**Files:**
- Modify: `src/log-writer.js`
- Test: `tests/log-writer.test.js`

- [ ] **Step 1: Write the failing test**

```js
test('repeated flush failures invoke the alert hook once past the threshold', async () => {
  _resetForTest();
  _setEnvImpl(() => ({ OPS_LOG_WEBAPP_URL: 'https://example.test/ops', CAMPAIGN_LOG_WEBAPP_URL: '' }));
  const alerts = [];
  _setAlertImpl((msg) => alerts.push(msg));
  _setFetchImpl(async () => ({ status: 200, text: async () => JSON.stringify({ error: 'boom' }) }));
  for (let i = 0; i < 3; i++) {
    opsLogEvent({ name: 'C', startedAt: 't', operator: 'op' }, { event: 'X' });
    await flushOpsLog();
  }
  assert.equal(alerts.length, 1, 'alert fires once after consecutive failures cross the threshold');
  _resetForTest();
});
```

- [ ] **Step 2: Run it — expect FAIL** (`_setAlertImpl` undefined).

Run: `node --test tests/log-writer.test.js`
Expected: FAIL with "_setAlertImpl is not a function".

- [ ] **Step 3: Implement the alert hook in `src/log-writer.js`**

Add near the other test seams (after `_setEnvImpl`):

```js
// Alert seam: invoked when ops flushes fail repeatedly so a logging outage
// surfaces instead of dying silently (the 2026-06-10 → 06-11 blackout).
let _alertImpl = null;
let _consecutiveFlushFailures = 0;
const FLUSH_FAILURE_ALERT_THRESHOLD = 3;
let _flushAlerted = false;
export function _setAlertImpl(fn) { _alertImpl = fn; }
```

Extend `_resetForTest()` to reset the new state:

```js
export function _resetForTest() {
  _opsBuffer = [];
  if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
  _fetchImpl = (...args) => globalThis.fetch(...args);
  _envImpl = null;
  _alertImpl = null;
  _consecutiveFlushFailures = 0;
  _flushAlerted = false;
}
```

In `flushOpsLog`, on the two failure branches (after `_opsBuffer.unshift(...batch); _scheduleFlush();`) add:

```js
    _consecutiveFlushFailures++;
    if (_consecutiveFlushFailures >= FLUSH_FAILURE_ALERT_THRESHOLD && !_flushAlerted) {
      _flushAlerted = true;
      try { (_alertImpl || (() => {}))('Operations Log is not writing — check the OPS AND LOGS sheet (likely full or auth expired).'); } catch (_) {}
    }
```

On the success branch (`if (res && res.success)`) reset the counter before returning:

```js
    _consecutiveFlushFailures = 0;
    _flushAlerted = false;
    return { ok: true, sent: batch.length };
```

- [ ] **Step 4: Run the test — expect PASS**

Run: `node --test tests/log-writer.test.js`
Expected: PASS.

- [ ] **Step 5: Wire a real alert in production**

In `server.js`, after importing log-writer, register a desktop/email alert (reuse `src/notifier.js`'s existing notification path; default to a single `console.error` + the in-app campaign log if notifier isn't configured):

```js
import { _setAlertImpl } from './src/log-writer.js';
_setAlertImpl((msg) => {
  console.error(`[log-writer][ALERT] ${msg}`);
  try { appendFatalErrorSync?.(`[log-writer] ${msg}`); } catch (_) {}
});
```

(Match the actual exported notifier/append API — read `server.js` imports first; if `appendFatalErrorSync` isn't in scope, use the existing in-app log broadcaster.)

- [ ] **Step 6: Commit**

```bash
git add src/log-writer.js tests/log-writer.test.js server.js
git commit -m "feat(logs): alert when ops-log flushes fail repeatedly"
```

---

## PHASE 1 — Ops Log v2 (single Events tab + views)

### Task 3: Pure outcome classifier

**Files:**
- Create: `src/linkedin/outcome-classify.js`
- Test: `tests/outcome-classify.test.js`

- [ ] **Step 1: Write the failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyOutcome } from '../src/linkedin/outcome-classify.js';

test('connection_sent → Request / sent', () => {
  assert.deepEqual(classifyOutcome({ action: 'connection_sent' }),
    { phase: 'Request', outcome: 'sent', reason: '' });
});
test('status_accepted → Accept / accepted', () => {
  assert.deepEqual(classifyOutcome({ action: 'status_accepted' }),
    { phase: 'Accept', outcome: 'accepted', reason: '' });
});
test('message_sent (introduce_back) → Intro / sent', () => {
  assert.deepEqual(classifyOutcome({ action: 'message_sent', mode: 'introduce_back' }),
    { phase: 'Intro', outcome: 'sent', reason: '' });
});
test('message_sent (message_only) → DM / sent', () => {
  assert.deepEqual(classifyOutcome({ action: 'message_sent', mode: 'message_only' }),
    { phase: 'DM', outcome: 'sent', reason: '' });
});
test('skip with HTTP 429 reason → rate_limited', () => {
  assert.deepEqual(classifyOutcome({ action: 'skip', reason: 'Rate-limited (HTTP 429) — confirming…' }),
    { phase: 'Request', outcome: 'rate_limited', reason: 'Rate-limited (HTTP 429)' });
});
test('skip Weekly limit reached → parked', () => {
  assert.deepEqual(classifyOutcome({ action: 'skip', reason: 'Weekly limit reached' }),
    { phase: 'Account', outcome: 'parked', reason: 'Weekly limit reached' });
});
test('skip with other reason → skipped, reason preserved', () => {
  assert.deepEqual(classifyOutcome({ action: 'skip', reason: 'Connect modal opened for wrong person' }),
    { phase: 'Request', outcome: 'skipped', reason: 'Connect modal opened for wrong person' });
});
test('error → error', () => {
  assert.deepEqual(classifyOutcome({ action: 'error', reason: 'Failed — Primary not in your connections' }),
    { phase: 'Intro', outcome: 'error', reason: 'Failed — Primary not in your connections' });
});
test('unknown action → skipped/unknown, never throws', () => {
  const r = classifyOutcome({ action: 'totally_new' });
  assert.equal(r.outcome, 'skipped');
});
```

- [ ] **Step 2: Run it — expect FAIL** (module missing).

Run: `node --test tests/outcome-classify.test.js`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement `src/linkedin/outcome-classify.js`**

```js
/**
 * src/linkedin/outcome-classify.js — net-new, pure. Maps the campaign loop's
 * per-lead result ({action, reason, mode}) to the logging/funnel vocabulary
 * used by the Operations Log and the Campaign Activity scorecard. Never throws;
 * unknown inputs fall through to a safe { skipped, unknown } classification so
 * a new action name can't crash the loop. Mirrors the action set in
 * campaign.js buildSheetDataForAction + SUCCESS_ACTIONS.
 */

const SENT_BY_ACTION = {
  connection_sent: 'Request',
  op_message_sent: 'OpenProfile',
  inmail_sent:     'InMail',
};

// Reason → { outcome, phase override } for skip/error results. Order matters:
// the first substring match wins.
const REASON_RULES = [
  { match: /429|rate.?limit/i,                 outcome: 'rate_limited', phase: 'Request', label: 'Rate-limited (HTTP 429)' },
  { match: /weekly limit|invitation limit/i,   outcome: 'parked',       phase: 'Account', label: 'Weekly limit reached' },
  { match: /session expired/i,                 outcome: 'skipped',      phase: 'Account', label: 'Session expired' },
  { match: /inmail credits/i,                  outcome: 'skipped',      phase: 'InMail',  label: 'InMail credits exhausted' },
  { match: /legacy sales nav|sales nav link/i, outcome: 'skipped',      phase: 'Request', label: 'Legacy Sales Nav URL' },
];

function phaseForMessage(mode) {
  if (mode === 'introduce_back' || mode === 'connect_and_introduce') return 'Intro';
  return 'DM';
}

export function classifyOutcome({ action = '', reason = '', mode = '' } = {}) {
  const a = String(action);
  const r = String(reason || '').trim();

  // Successes
  if (a === 'connection_sent') return { phase: 'Request', outcome: 'sent', reason: '' };
  if (a === 'message_sent')    return { phase: phaseForMessage(mode), outcome: 'sent', reason: '' };
  if (SENT_BY_ACTION[a])       return { phase: SENT_BY_ACTION[a], outcome: 'sent', reason: '' };
  if (a === 'status_accepted' || a === 'already_connected')
    return { phase: 'Accept', outcome: 'accepted', reason: '' };
  if (a === 'status_pending')  return { phase: 'Accept', outcome: 'pending', reason: '' };
  if (a === 'already_processed') return { phase: 'Request', outcome: 'sent', reason: '' };

  // Failures / skips — classify by reason
  if (a === 'error' || a === 'skip' || a === 'status_declined' || r) {
    for (const rule of REASON_RULES) {
      if (rule.match.test(r)) return { phase: rule.phase, outcome: rule.outcome, reason: rule.label };
    }
    if (a === 'error') return { phase: mode === 'connect_and_introduce' ? 'Intro' : 'Request', outcome: 'error', reason: r };
    return { phase: 'Request', outcome: 'skipped', reason: r };
  }

  return { phase: 'Request', outcome: 'skipped', reason: r || 'unknown' };
}
```

- [ ] **Step 4: Run the test — expect PASS**

Run: `node --test tests/outcome-classify.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/linkedin/outcome-classify.js tests/outcome-classify.test.js
git commit -m "feat(logs): pure outcome classifier for ops-log + funnel"
```

### Task 4: Enrich `opsLogEvent` payload with structured fields

**Files:**
- Modify: `src/log-writer.js` (`opsLogEvent` push shape)
- Test: `tests/log-writer.test.js`

- [ ] **Step 1: Write the failing test**

```js
test('opsLogEvent buffers structured phase/outcome/reason/lead fields', () => {
  _resetForTest();
  _setEnvImpl(() => ({ OPS_LOG_WEBAPP_URL: 'https://example.test/ops', CAMPAIGN_LOG_WEBAPP_URL: '' }));
  opsLogEvent(
    { name: 'C', startedAt: 't', operator: 'op' },
    { event: 'Outcome', account: 'kyra', phase: 'DM', outcome: 'sent', reason: '', leadUrl: '/in/x' },
  );
  const row = _peekBufferForTest()[0];
  assert.equal(row.phase, 'DM');
  assert.equal(row.outcome, 'sent');
  assert.equal(row.account, 'kyra');
  assert.equal(row.leadUrl, '/in/x');
  _resetForTest();
});
```

- [ ] **Step 2: Run it — expect FAIL** (`row.phase` undefined).

Run: `node --test tests/log-writer.test.js`
Expected: FAIL.

- [ ] **Step 3: Add the fields to the buffered row in `opsLogEvent`**

In `src/log-writer.js`, in the `_opsBuffer.push({ ... })` object, add three fields after `details`:

```js
      details: evt.details || '',
      phase: evt.phase || '',
      outcome: evt.outcome || '',
      reason: evt.reason || '',
```

(`leadUrl` and `account` already exist.)

- [ ] **Step 4: Run the test — expect PASS**

Run: `node --test tests/log-writer.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/log-writer.js tests/log-writer.test.js
git commit -m "feat(logs): carry phase/outcome/reason on ops events"
```

### Task 5: Rewrite the Ops Log bridge — single Events tab + view tabs

**Files:**
- Rewrite: `ops-log-bridge.js`

- [ ] **Step 1: Replace the schema + append handler**

Replace `EVENT_HEADERS` and `handleAppendEvents`/`ensureCampaignTab`/`buildTabName`/`upsertIndexRow`/`ensureIndexTab` with a single-tab model. New constants:

```js
var EVENTS_SHEET_NAME = 'Events';
var EVENT_HEADERS = [
  'Timestamp', 'Operator', 'Ortus Account', 'Campaign',
  'Phase', 'Outcome', 'Reason', 'Lead URL', 'Severity'
];
```

New `handleAppendEvents` (append to one tab; derive phase/outcome when absent for old-app compatibility):

```js
function handleAppendEvents(data) {
  var events = Array.isArray(data.events) ? data.events : [];
  if (events.length === 0) return jsonResponse({ success: true, appended: 0 });

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ensureEventsTab(ss);

  var rows = events.map(function (evt) {
    var sev = evt.severity || (evt.outcome === 'error' ? 'ERROR'
              : (evt.outcome === 'skipped' || evt.outcome === 'rate_limited' || evt.outcome === 'parked') ? 'WARN'
              : 'INFO');
    return [
      evt.ts || '',
      evt.operator || '',
      evt.account || '',
      evt.campaign || '',
      evt.phase || '',
      evt.outcome || (evt.event || ''),
      evt.reason || evt.details || '',
      evt.leadUrl || '',
      sev
    ];
  });

  var startRow = sheet.getLastRow() + 1;
  sheet.getRange(startRow, 1, rows.length, EVENT_HEADERS.length).setValues(rows);
  ensureViewTabs(ss);
  return jsonResponse({ success: true, appended: rows.length });
}

function ensureEventsTab(ss) {
  var sheet = ss.getSheetByName(EVENTS_SHEET_NAME);
  if (sheet) return sheet;
  sheet = ss.insertSheet(EVENTS_SHEET_NAME, 0);
  sheet.getRange(1, 1, 1, EVENT_HEADERS.length).setValues([EVENT_HEADERS])
    .setFontWeight('bold').setBackground('#f1f3f4');
  sheet.setFrozenRows(1);
  var widths = [150, 150, 170, 160, 90, 110, 280, 200, 80];
  for (var i = 0; i < widths.length; i++) sheet.setColumnWidth(i + 1, widths[i]);
  // Outcome-tinted conditional formatting on the whole row.
  var rng = sheet.getRange(2, 1, Math.max(sheet.getMaxRows() - 1, 1000), EVENT_HEADERS.length);
  var rule = function (val, bg, fg) {
    return SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=$F2="' + val + '"').setBackground(bg).setFontColor(fg).setRanges([rng]).build();
  };
  sheet.setConditionalFormatRules([
    rule('error', '#fce4e4', '#a1252b'),
    rule('parked', '#f4d3d5', '#a1252b'),
    rule('rate_limited', '#fbe8cf', '#8a5a00'),
    rule('skipped', '#fff4d6', '#8a5a00'),
    rule('accepted', '#d6ecdf', '#1f6b3e'),
    rule('sent', '#e6f4ea', '#2f7d4f'),
  ]);
  return sheet;
}
```

- [ ] **Step 2: Add the three view tabs (live `QUERY` formulas)**

```js
function ensureViewTabs(ss) {
  ensureFormulaTab(ss, 'Attribution', [
    ['Ortus Account', 'Operator', 'Sent', 'Errors', 'Last activity'],
  ], "=IFERROR(QUERY(Events!A:I, \"select C, B, count(A), sum(if(I='ERROR',1,0)), max(A) where A is not null group by C, B order by count(A) desc label count(A) '', sum(if(I='ERROR',1,0)) '', max(A) ''\", 1), \"\")");

  ensureFormulaTab(ss, 'Where it''s leaking', [
    ['Reason', 'Count', 'Phase'],
  ], "=IFERROR(QUERY(Events!A:I, \"select G, count(A), E where F='skipped' or F='rate_limited' or F='parked' or F='error' group by G, E order by count(A) desc label count(A) ''\", 1), \"\")");

  ensureFormulaTab(ss, 'Account health', [
    ['Ortus Account', 'Sent', 'Rate-limited', 'Parked', 'Last active'],
  ], "=IFERROR(QUERY(Events!A:I, \"select C, sum(if(F='sent',1,0)), sum(if(F='rate_limited',1,0)), sum(if(F='parked',1,0)), max(A) where C is not null group by C order by sum(if(F='sent',1,0)) desc label sum(if(F='sent',1,0)) '', sum(if(F='rate_limited',1,0)) '', sum(if(F='parked',1,0)) '', max(A) ''\", 1), \"\")");
}

// Create a view tab once: header row in row 1, a single QUERY in A2 that the
// sheet keeps live. Idempotent — if the tab exists, leave it (operator may
// have tweaked it).
function ensureFormulaTab(ss, name, header, queryA2) {
  if (ss.getSheetByName(name)) return;
  var sheet = ss.insertSheet(name);
  sheet.getRange(1, 1, 1, header[0].length).setValues(header).setFontWeight('bold').setBackground('#f1f3f4');
  sheet.setFrozenRows(1);
  sheet.getRange(2, 1).setFormula(queryA2);
}
```

(Keep the existing `doGet`, `jsonResponse`, `deleteAllTabs`, `onOpen`, `menuDeleteAllTabs`, and `menuCopyDiagnosticSnippet` functions — update `menuCopyDiagnosticSnippet` to read the `Events` tab and treat column F `outcome` of `error`/`parked` as flagged instead of the old severity column C.)

- [ ] **Step 3: Manual verification** (Apps Script has no local harness)

1. In *"OPS AND LOGS — ORTUS OUTREACH — DO NOT DELETE"* → Extensions → Apps Script, paste the rewritten file over Code.gs.
2. Run `Ortus Logs → Delete all log tabs` to clear the overflowed per-campaign tabs.
3. Deploy → Manage deployments → edit the existing deployment → Version: New version → Deploy (URL stays the same).
4. From a terminal, POST a sample event and confirm a row lands on `Events` and the view tabs populate:

```bash
curl -sL -X POST -H 'Content-Type: application/json' \
  -d '{"action":"appendEvents","events":[{"ts":"2026-06-11T18:00:00Z","operator":"antonio@ortusclub.com","account":"tony.otto","campaign":"smoke","phase":"Request","outcome":"sent","reason":"","leadUrl":"/in/x"}]}' \
  "$OPS_LOG_WEBAPP_URL"
```
Expected: `{"success":true,"appended":1}` and a green `sent` row on the `Events` tab.

- [ ] **Step 4: Commit**

```bash
git add ops-log-bridge.js
git commit -m "feat(ops-log): single Events tab + Attribution/leaks/health views (replaces per-campaign tabs)"
```

### Task 6: Emit one classified event per lead outcome from the loop

**Files:**
- Modify: `src/campaign.js` (per-lead seam where `buildSheetDataForAction` is called / status is stamped)

- [ ] **Step 1: Read the seam.** In `src/campaign.js`, find the call site of `buildSheetDataForAction(...)` and the surrounding place where `result.action` and any skip `reason`/`message` are known per lead (near the per-lead processing in the 2490–2660 region and the status-mapping at 1089+). Confirm the variables in scope: the lead URL, the active `mode`, the profile/account name, and the result object.

- [ ] **Step 2: Add the emit at that seam**

Right after the per-lead status is determined (where `buildSheetDataForAction` result is used to stamp the sheet), add:

```js
// Mirror every lead outcome into the central Operations Log as one
// structured, attributable event. Pure classification; fire-and-forget.
try {
  const _cls = classifyOutcome({ action: result.action, reason: result.reason || result.message || '', mode });
  _ops(
    _cls.outcome === 'error' ? 'ERROR'
      : (_cls.outcome === 'skipped' || _cls.outcome === 'rate_limited' || _cls.outcome === 'parked') ? 'WARN'
      : 'INFO',
    'Outcome',
    { account: pName, leadUrl: url, details: _cls.reason,
      phase: _cls.phase, outcome: _cls.outcome, reason: _cls.reason },
  );
} catch (_) { /* never block the loop */ }
```

Add the import at the top of `campaign.js`:

```js
import { classifyOutcome } from './linkedin/outcome-classify.js';
```

Extend `_ops` (campaign.js:646) to forward the new fields — change its `opsLogEvent(... , { severity, event, account, leadUrl, details })` call to also pass `phase: e.phase || '', outcome: e.outcome || '', reason: e.reason || ''`.

- [ ] **Step 3: Verify nothing else broke**

Run: `node --test tests/*.test.js`
Expected: PASS (no test covers the loop directly; this confirms imports resolve and pure tests still pass).

- [ ] **Step 4: Bump version + relaunch (operator rule), then smoke-test live**

```bash
# bump package.json patch version first (e.g. 2.92.0 -> 2.93.0), then:
pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "Electron.*ortus" 2>/dev/null
npm run dev:app > /tmp/dev-app.log 2>&1 &
```
Run a tiny campaign; confirm `Events` rows appear with the right Phase/Outcome.

- [ ] **Step 5: Commit**

```bash
git add src/campaign.js package.json
git commit -m "feat(ops-log): emit a classified outcome event per lead"
```

---

## PHASE 2 — Campaign Activity v2 (funnel + leaks)

### Task 7: Pure run-tally

**Files:**
- Create: `src/campaign-tally.js`
- Test: `tests/campaign-tally.test.js`

- [ ] **Step 1: Write the failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyTally, applyOutcome } from '../src/campaign-tally.js';

test('emptyTally starts at zero', () => {
  const t = emptyTally();
  assert.deepEqual(t, { sent: 0, accepted: 0, intro: 0, dm: 0, replied: 0,
    rateLimited: 0, parked: 0, skipped: 0, errors: 0, byReason: {} });
});
test('applyOutcome counts sent + phase', () => {
  let t = emptyTally();
  t = applyOutcome(t, { phase: 'Request', outcome: 'sent', reason: '' });
  t = applyOutcome(t, { phase: 'Intro', outcome: 'sent', reason: '' });
  t = applyOutcome(t, { phase: 'DM', outcome: 'sent', reason: '' });
  assert.equal(t.sent, 1); assert.equal(t.intro, 1); assert.equal(t.dm, 1);
});
test('applyOutcome tracks leaks + byReason', () => {
  let t = emptyTally();
  t = applyOutcome(t, { phase: 'Request', outcome: 'rate_limited', reason: 'Rate-limited (HTTP 429)' });
  t = applyOutcome(t, { phase: 'Account', outcome: 'parked', reason: 'Weekly limit reached' });
  t = applyOutcome(t, { phase: 'Request', outcome: 'skipped', reason: 'Session expired' });
  assert.equal(t.rateLimited, 1); assert.equal(t.parked, 1); assert.equal(t.skipped, 1);
  assert.equal(t.byReason['Rate-limited (HTTP 429)'], 1);
});
```

- [ ] **Step 2: Run it — expect FAIL** (module missing).

Run: `node --test tests/campaign-tally.test.js`
Expected: FAIL "Cannot find module".

- [ ] **Step 3: Implement `src/campaign-tally.js`**

```js
/**
 * src/campaign-tally.js — net-new, pure. Accumulates a run's funnel + leak
 * counters from classified lead outcomes (see outcome-classify.js). Returned
 * object is JSON-serialisable and shipped in the Campaign Activity row.
 */
export function emptyTally() {
  return { sent: 0, accepted: 0, intro: 0, dm: 0, replied: 0,
    rateLimited: 0, parked: 0, skipped: 0, errors: 0, byReason: {} };
}

export function applyOutcome(t, cls) {
  const n = { ...t, byReason: { ...t.byReason } };
  const { phase = '', outcome = '', reason = '' } = cls || {};
  if (outcome === 'sent') {
    n.sent += 1;
    if (phase === 'Intro') n.intro += 1;
    if (phase === 'DM') n.dm += 1;
  } else if (outcome === 'accepted') { n.accepted += 1; }
  else if (outcome === 'rate_limited') { n.rateLimited += 1; }
  else if (outcome === 'parked') { n.parked += 1; }
  else if (outcome === 'error') { n.errors += 1; }
  else if (outcome === 'skipped') { n.skipped += 1; }
  if (reason && (outcome === 'skipped' || outcome === 'rate_limited' || outcome === 'parked' || outcome === 'error')) {
    n.byReason[reason] = (n.byReason[reason] || 0) + 1;
  }
  return n;
}
```

- [ ] **Step 4: Run the test — expect PASS**

Run: `node --test tests/campaign-tally.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/campaign-tally.js tests/campaign-tally.test.js
git commit -m "feat(activity): pure run-tally for funnel + leak counters"
```

### Task 8: Accumulate the tally during a run + widen the Campaign Activity row

**Files:**
- Modify: `src/campaign.js` (init tally on campaign start; apply at the per-lead seam; include in `campaignLogAppendRun`)
- Modify: `campaign-log-bridge.js` (widened headers + row)

- [ ] **Step 1: Initialise the tally on campaign start**

Where `campaign` run-state is reset (near `campaign.errors = []`, campaign.js:1454), add:

```js
campaign.tally = emptyTally();
```

Add imports at top of `campaign.js`:

```js
import { emptyTally, applyOutcome } from './campaign-tally.js';
```

- [ ] **Step 2: Apply the tally at the per-lead seam**

In the same `try` block added in Task 6 Step 2 (right after computing `_cls`):

```js
  campaign.tally = applyOutcome(campaign.tally || emptyTally(), _cls);
```

- [ ] **Step 3: Ship the counters in the run-end row**

In the `campaignLogAppendRun({ ... })` call (campaign.js:3656), add after `errors`:

```js
        sent: campaign.tally?.sent || 0,
        accepted: campaign.tally?.accepted || 0,
        intro: campaign.tally?.intro || 0,
        dm: campaign.tally?.dm || 0,
        replied: campaign.tally?.replied || 0,
        rateLimited: campaign.tally?.rateLimited || 0,
        parked: campaign.tally?.parked || 0,
        skipped: campaign.tally?.skipped || 0,
```

- [ ] **Step 4: Widen `campaign-log-bridge.js`**

Replace `HEADERS` and make header-ensure idempotent so the existing sheet gains the new columns:

```js
var HEADERS = [
  'Started', 'Operator', 'Campaign Name', 'Mode', 'Profiles Used',
  'Total Leads', 'Requests Sent', 'Accepted', 'Intro/DM', 'Replied',
  'Rate-limited', 'Parked', 'Skipped', 'Errors',
  'Duration', 'End Reason', 'Templates Used', 'Sheet URL'
];
```

Update the `row` array in `handleAppendRun` to match the new order:

```js
  var intro = Number(entry.intro || 0) + Number(entry.dm || 0);
  var row = [
    entry.ts || '', entry.operator || '', entry.name || '', entry.mode || '',
    Array.isArray(entry.profiles) ? entry.profiles.join(', ') : (entry.profiles || ''),
    Number(entry.totalLeads || 0),
    Number(entry.sent || entry.processed || 0),
    Number(entry.accepted || 0),
    intro,
    Number(entry.replied || 0),
    Number(entry.rateLimited || 0),
    Number(entry.parked || 0),
    Number(entry.skipped || 0),
    Number(entry.errors || 0),
    formatDuration(entry.durationSec || 0),
    entry.endReason || '', entry.templatePreview || '', entry.sheetUrl || ''
  ];
```

In `ensureTab`, after getting/creating the sheet, idempotently (re)write the header row so an existing sheet picks up the wider schema:

```js
  sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS])
    .setFontWeight('bold').setBackground('#f1f3f4');
  sheet.setFrozenRows(1);
```

- [ ] **Step 5: Run unit tests + manual bridge verification**

Run: `node --test tests/*.test.js` → PASS.
Then paste + redeploy `campaign-log-bridge.js`; finish a tiny run; confirm the new columns populate.

- [ ] **Step 6: Commit**

```bash
git add src/campaign.js campaign-log-bridge.js package.json
git commit -m "feat(activity): funnel + leak counters in Campaign Activity v2"
```

---

## PHASE 3 — Rollout

### Task 9: Ship + deploy + verify

- [ ] **Step 1: Bump version** in `package.json` (e.g. `2.92.0` → `2.93.0`).
- [ ] **Step 2: Build the DMGs** — `npm run electron:build:mac` (verify both arm64 + intel produced).
- [ ] **Step 3: Publish** — `node scripts/release-mac.js` (needs the `ortusclub` gh account).
- [ ] **Step 4: Deploy both bridges** — paste each rewritten bridge into its sheet's Apps Script editor, run `Delete all log tabs` on the Ops Log sheet once, redeploy each as a New Version of the existing deployment (URLs unchanged).
- [ ] **Step 5: Verify end-to-end** — run a small live campaign; confirm: `Events` rows with correct Phase/Outcome; the three view tabs populate; Campaign Activity row shows funnel + leak counts; quit the app and confirm the last events still flushed (durability).
- [ ] **Step 6: Commit any version bump** and tag the release.

---

## Self-Review

**Spec coverage:** Ops Log restored as single Events tab (Tasks 3–5) ✓; attribution/leaks/health views (Task 5) ✓; per-event attribution operator+account (Tasks 4,6) ✓; durability flush + alert (Tasks 1,2) ✓; Campaign Activity funnel + leaks (Tasks 7,8) ✓; "where it leaks" taxonomy from real reasons (Task 3) ✓. The rendered scorecard *card* is explicitly deferred (Open Decision 1) — data lands, visual is Phase 3+.

**Placeholder scan:** No TBD/TODO; each code step shows complete code. Apps Script tasks note "no local harness → manual verification" with exact curl checks rather than fake unit tests.

**Type consistency:** `classifyOutcome` returns `{phase, outcome, reason}` used identically in Tasks 4/6/7/8. `outcome` vocabulary (`sent|accepted|pending|rate_limited|parked|skipped|error`) is consistent across the classifier, the tally, the bridge severity derivation, and the conditional-format rules. Tally keys (`sent/accepted/intro/dm/replied/rateLimited/parked/skipped/errors/byReason`) match between `campaign-tally.js`, the `campaignLogAppendRun` entry, and the `campaign-log-bridge.js` row order.

**Note for executor:** confirm the exact per-lead result variable names (`result.action`, `result.reason`/`result.message`, `pName`, `url`, `mode`) by reading the seam in `campaign.js` before Task 6 Step 2 — adjust the emit to the real locals.
