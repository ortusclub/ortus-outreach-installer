# Op-funnel Run-Health Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the FG sheet answer "did the last run work?" — readable run times, no permanent "Queued", a per-account-per-run Run Health tab, and Failed-is-retryable.

**Architecture:** Migrate `FG Invites` in place: keep the 13 columns in order, append `Run ID, Run At, Reason`. `queueFgInvites` stamps every row with the run's id + time. Reconcile flips sent rows to `Invited` and sweeps the rest of the run to `Failed`. A new `Run Health` tab is a pure `QUERY` over the detail — no app writes. `alreadyInvited` counts only `Invited`.

**Tech Stack:** Node ≥22 (`node --test`), vanilla JS, Google Apps Script (`fg-apps-script.js`), Google Sheets formulas.

## Global Constraints

- `FG Invites` **writes are positional** — `fg-export.js` `FG_HEADER` and `fg-apps-script.js` `FG_HEADER` MUST stay identical and in the same order; only **append** new columns.
- Existing column positions 0–12 (`Target Name`…`Month`) must NOT move (`fgMarkInvited_` uses `FG_HEADER.indexOf`; `keyOf_` uses `r[2]`/`r[1]`).
- New column indices: `Run ID` = 13, `Run At` = 14, `Reason` = 15.
- Migration runs with **no campaign active** (confirmed).
- `Run ID` = the cloud campaign id (`cloudId`).
- Failure sweep reason default: `not sent — account may be logged out or out of credits`.

---

### Task 1: Grow the schema + stamp run id/time at queue

**Files:**
- Modify: `src/connections/fg-export.js:7-11` (FG_HEADER)
- Modify: `src/connections/fg-sync.js:77-81` (queueFgInvites) + add `markFgFailed`
- Test: `tests/fg-sync-runstamp.test.js` (create)

**Interfaces:**
- Produces: `queueFgInvites(rows, { runId, runAt })` — pads each row to 16 cells `[...row.slice(0,13), runId, runAt, '']`, posts `{action:'fgQueue', rows}`.
- Produces: `markFgFailed({ runId, reason })` — posts `{action:'fgMarkFailed', runId, reason}`.

- [ ] **Step 1: Write the failing test**

```js
// tests/fg-sync-runstamp.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('queueFgInvites stamps runId/runAt and pads rows to 16', async () => {
  const calls = [];
  const fg = await import('../src/connections/fg-sync.js');
  // Inject a fake poster by monkeypatching global fetch is heavy; instead test the
  // pure row-shaping helper the module exports.
  const rows = [['Jane', 'https://x/jane', '111', 'Acme', 'CMO', '', '', 'Op', 'a@x', 'Queued', '', '', '2026-07']];
  const out = fg.stampRunCells(rows, { runId: 'cmp_1', runAt: '2026-07-17T11:40:00.000Z' });
  assert.equal(out[0].length, 16);
  assert.equal(out[0][13], 'cmp_1');
  assert.equal(out[0][14], '2026-07-17T11:40:00.000Z');
  assert.equal(out[0][15], '');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/fg-sync-runstamp.test.js`
Expected: FAIL — `stampRunCells is not a function`.

- [ ] **Step 3: Grow FG_HEADER**

`src/connections/fg-export.js` — append three names:

```js
export const FG_HEADER = [
  'Target Name', 'LinkedIn URL', 'Member ID', 'Company', 'Job Title',
  'Function Match', 'Geo', 'Invited By', 'Account', 'Status',
  'Invited At', 'FG Note', 'Month',
  'Run ID', 'Run At', 'Reason',
];
```

- [ ] **Step 4: Add stampRunCells + wire queueFgInvites + markFgFailed**

`src/connections/fg-sync.js` — replace `queueFgInvites` and add below it:

```js
// Pad each FG_HEADER-order row (13 cells) to 16 by appending the run's id + time
// + an empty Reason. Single choke point so callers never hand-build the new cols.
export function stampRunCells(rows, { runId = '', runAt = '' } = {}) {
  return (rows || []).map((r) => [...r.slice(0, 13), String(runId), String(runAt), '']);
}

// Append queued rows (FG_HEADER order). Stamps the run id + time onto every row.
export async function queueFgInvites(rows, { runId = '', runAt = '' } = {}) {
  const stamped = stampRunCells(rows, { runId, runAt });
  const r = await postFg({ action: 'fgQueue', rows: stamped }, { timeoutMs: 90000 });
  if (r?.error) throw new Error(r.error);
  return r; // { queued, skippedDuplicates }
}

// Sweep every still-'Queued' row for this run to 'Failed' + reason (post-reconcile).
export async function markFgFailed({ runId, reason }) {
  const r = await postFg({ action: 'fgMarkFailed', runId, reason }, { timeoutMs: 90000 });
  if (r?.error) throw new Error(r.error);
  return r; // { failed }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test tests/fg-sync-runstamp.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/connections/fg-export.js src/connections/fg-sync.js tests/fg-sync-runstamp.test.js
git commit -m "feat(fg): append Run ID/At/Reason schema + stamp run cells at queue"
```

---

### Task 2: Apps Script — write dates, mark failed, keep width in sync

**Files:**
- Modify: `fg-apps-script.js` (FG_HEADER, fgQueue_, fgMarkInvited_, add fgMarkFailed_, action router)

**Interfaces:**
- Produces: `fgMarkFailed_({runId, reason})` — flips `Status='Queued'` rows with matching `Run ID` to `Failed` + `Reason`.

Apps Script is not `node --test`-able. Verify manually in the Apps Script editor (Step 5).

- [ ] **Step 1: Grow the Apps Script FG_HEADER (must match fg-export.js exactly)**

`fg-apps-script.js` — find the `FG_HEADER` array and append the same three names:

```js
var FG_HEADER = [
  'Target Name', 'LinkedIn URL', 'Member ID', 'Company', 'Job Title',
  'Function Match', 'Geo', 'Invited By', 'Account', 'Status',
  'Invited At', 'FG Note', 'Month',
  'Run ID', 'Run At', 'Reason'
];
```

- [ ] **Step 2: fgQueue_ — write Run At as a real Date**

Replace the write in `fgQueue_` (around line 97) so the `Run At` cell (index 14) becomes a Date and the column shows a readable format:

```js
function fgQueue_(rows) {
  var sh = sheet_('FG Invites', FG_HEADER);
  var existing = {};
  asObjects_(sh).forEach(function (o) { existing[keyOf_(o['Member ID'], o['LinkedIn URL'])] = true; });
  var fresh = rows.filter(function (r) { return !existing[keyOf_(r[2], r[1])]; });
  if (fresh.length) {
    fresh.forEach(function (r) { if (r[14]) r[14] = new Date(r[14]); }); // Run At -> Date
    var startRow = sh.getLastRow() + 1;
    sh.getRange(startRow, 1, fresh.length, FG_HEADER.length).setValues(fresh);
    sh.getRange(startRow, 15, fresh.length, 1).setNumberFormat('dd mmm yyyy, HH:mm'); // Run At col (15th)
  }
  return { queued: fresh.length, skippedDuplicates: rows.length - fresh.length };
}
```

- [ ] **Step 3: fgMarkInvited_ — stamp Invited At as a Date + format**

Replace the stamp lines in `fgMarkInvited_` (around line 114-115):

```js
      sh.getRange(i + 2, iStatus + 1).setValue('Invited');
      sh.getRange(i + 2, iWhen + 1).setValue(new Date()).setNumberFormat('dd mmm yyyy, HH:mm');
```

- [ ] **Step 4: Add fgMarkFailed_ + route the action**

Add the handler and register it in the action router (near line 26):

```js
    else if (data.action === 'fgMarkFailed') out = fgMarkFailed_(data);
```

```js
// Flip still-'Queued' rows for a run to 'Failed' + reason. Runs post-reconcile,
// so whatever is still Queued for this Run ID was genuinely never sent.
function fgMarkFailed_(data) {
  var runId = String(data.runId || '');
  var reason = String(data.reason || 'not sent');
  if (!runId) return { error: 'fgMarkFailed: runId required' };
  var sh = sheet_('FG Invites', FG_HEADER);
  var r = rows_(sh);
  var iStatus = FG_HEADER.indexOf('Status');
  var iRun = FG_HEADER.indexOf('Run ID');
  var iReason = FG_HEADER.indexOf('Reason');
  var n = 0;
  for (var i = 0; i < r.data.length; i++) {
    if (String(r.data[i][iRun]) === runId && r.data[i][iStatus] === 'Queued') {
      sh.getRange(i + 2, iStatus + 1).setValue('Failed');
      sh.getRange(i + 2, iReason + 1).setValue(reason);
      n++;
    }
  }
  return { failed: n };
}
```

- [ ] **Step 5: Manual verify + deploy**

1. Paste the full `fg-apps-script.js` into the FG Apps Script editor, Deploy → Manage deployments → edit → new version.
2. In the editor run a scratch: `fgMarkFailed_({runId:'nope', reason:'x'})` → returns `{failed:0}`, no throw.
3. Confirm the `FG Invites` header row now ends with `Run ID | Run At | Reason` (add them by hand if `sheet_` didn't, then re-run).

- [ ] **Step 6: Commit**

```bash
git add fg-apps-script.js
git commit -m "feat(fg-script): Run At/Invited At as dates + fgMarkFailed_ sweep"
```

---

### Task 3: Dispatch stamps run id/time; reconcile sweeps failures

**Files:**
- Modify: `src/connections/fg-cloud-launch.js:140-173` (startTeamLaunchCloud), `:113-131` (reconcileCloudRun)
- Modify: `server.js:2390-2405` (reconcile deps wiring)
- Test: `tests/fg-cloud-runstamp.test.js` (create)

**Interfaces:**
- Consumes: `queueFgInvites(rows, {runId, runAt})`, `markFgFailed({runId, reason})` from Task 1.
- Produces: `reconcileCloudRun` calls `deps.markFailed({ runId: record.cloudId, reason })` after `deps.markInvited`.

- [ ] **Step 1: Write the failing test**

```js
// tests/fg-cloud-runstamp.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTeamLaunchCloud, reconcileCloudRun } from '../src/connections/fg-cloud-launch.js';

test('startTeamLaunchCloud stamps runId=cloudId + runAt onto queued rows', async () => {
  let queuedOpts = null;
  const deps = {
    buildTargets: () => ({ rows: [['J','u','1','','','','','Op','a@x','Queued','','','2026-07']], count: 1, reason: '' }),
    startCloud: async () => ({ id: 'cmp_ABC' }),
    queueInvites: async (rows, opts) => { queuedOpts = opts; },
    runStore: { add: () => {} },
    now: () => '2026-07-17T11:40:00.000Z',
    log: () => {}, month: '2026-07', owner: '', name: 'x', inviteUrl: 'u', monthlyBudget: 30,
  };
  const out = await startTeamLaunchCloud([{ profileId: 'p1', account: 'a@x', operator: 'Op' }], deps);
  assert.equal(out.cloudId, 'cmp_ABC');
  assert.equal(queuedOpts.runId, 'cmp_ABC');
  assert.equal(queuedOpts.runAt, '2026-07-17T11:40:00.000Z');
});

test('reconcileCloudRun sweeps failures with runId=cloudId after marking invited', async () => {
  const calls = [];
  const deps = {
    getCampaign: async () => ({ status: 'done' }),
    getLeads: async () => ({ leads: [] }),
    markInvited: async () => { calls.push('invited'); },
    markFailed: async (a) => { calls.push('failed:' + a.runId); },
    log: () => {},
  };
  const out = await reconcileCloudRun({ cloudId: 'cmp_ABC', perAccount: [] }, deps);
  assert.equal(out.reconciled, true);
  assert.deepEqual(calls, ['failed:cmp_ABC']); // no invited groups, but sweep still runs
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/fg-cloud-runstamp.test.js`
Expected: FAIL — `queueInvites` called with one arg / `markFailed` not called.

- [ ] **Step 3: Stamp at dispatch**

`src/connections/fg-cloud-launch.js` — in `startTeamLaunchCloud`, after `const cloudId = resp.id;`, change the queue call:

```js
  const runAt = deps.now();
  const allRows = perAccount.flatMap((a) => a.rows);
  try { if (allRows.length) await deps.queueInvites(allRows, { runId: cloudId, runAt }); }
  catch (e) { deps.log(`⚠ FG-sheet Queue write failed at launch (${e.message}) — invites still dispatched; reconcile will still flip Invited.`); }
```

(Remove the old `await deps.queueInvites(allRows)` line.)

- [ ] **Step 4: Sweep failures at reconcile**

`src/connections/fg-cloud-launch.js` — in `reconcileCloudRun`, after the `for (const g of groups)` invited loop and before `return { reconciled: true, ... }`, add:

```js
  // Whatever is still 'Queued' for this run was never sent — flip it to Failed so
  // the sheet shows a red line + reason instead of permanent limbo. Best-effort.
  if (deps.markFailed) {
    try { await deps.markFailed({ runId: record.cloudId, reason: 'not sent — account may be logged out or out of credits' }); }
    catch (e) { deps.log(`⚠ FG failure-sweep write failed (${e.message})`); }
  }
```

- [ ] **Step 5: Wire markFailed into the reconcile deps**

`server.js` around line 2396 (where `markInvited` is wired), add to the same deps object:

```js
      markFailed: (args) => markFgFailed(args),
```

And extend the import at `server.js:95`:

```js
import { markFgInvited, markFgFailed, observeFgCredits } from './src/connections/fg-sync.js';
```

(Adjust to match the existing import line — add `markFgFailed` to it.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test tests/fg-cloud-runstamp.test.js tests/fg-roster-autopilot.test.js`
Expected: PASS (all).

- [ ] **Step 7: Commit**

```bash
git add src/connections/fg-cloud-launch.js server.js tests/fg-cloud-runstamp.test.js
git commit -m "feat(fg): stamp runId/runAt at dispatch + sweep failures at reconcile"
```

---

### Task 4: Failed is retryable — alreadyInvited counts only Invited

**Files:**
- Modify: `services/fg-roster/autopilot.js:42-46` (alreadyInvited build)
- Modify: `server.js:2447-2449` (manual team-launch alreadyInvited build)
- Test: `tests/fg-already-invited-status.test.js` (create)

**Interfaces:**
- Consumes: `getFgState().invites` rows now carry `Status`.
- Produces: `alreadyInvited` includes a person only when their row `Status === 'Invited'`.

- [ ] **Step 1: Write the failing test**

```js
// tests/fg-already-invited-status.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Pure helper extracted in Step 3.
import { invitedKeysFromState } from '../src/connections/fg-sync.js';

test('only Invited rows count as already-invited (Failed is retryable)', () => {
  const invites = [
    { 'Member ID': '111', 'Status': 'Invited' },
    { 'Member ID': '222', 'Status': 'Failed' },
    { 'Member ID': '',    'LinkedIn URL': 'https://x/z', 'Status': 'Queued' },
    { 'Member ID': '333', 'LinkedIn URL': 'https://x/y', 'Status': 'Invited' },
  ];
  assert.deepEqual(invitedKeysFromState(invites), ['111', '333']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/fg-already-invited-status.test.js`
Expected: FAIL — `invitedKeysFromState is not a function`.

- [ ] **Step 3: Add the shared helper**

`src/connections/fg-sync.js` — add (used by both dispatch paths so the rule lives in one place):

```js
// Skip-list keys (Member ID, else LinkedIn URL) for people ALREADY invited —
// Status === 'Invited' only. A 'Failed' or in-flight 'Queued' row is NOT skipped,
// so a failed person is retried next run.
export function invitedKeysFromState(invites) {
  return (invites || [])
    .filter((r) => r && r.Status === 'Invited')
    .map((r) => String(r['Member ID'] || '') || (r['LinkedIn URL'] || ''))
    .filter(Boolean);
}
```

- [ ] **Step 4: Use it in the autopilot path**

`services/fg-roster/autopilot.js` — replace the `alreadyInvited = (snap.invites || []).map(...)` line (≈45) with:

```js
        const { invitedKeysFromState } = await import('../../src/connections/fg-sync.js');
        alreadyInvited = invitedKeysFromState(snap.invites);
```

- [ ] **Step 5: Use it in the manual team-launch path**

`server.js` ≈2447 — where `alreadyInvited` is built from `snap.invites`, replace with:

```js
      const alreadyInvited = invitedKeysFromState(snap.invites);
```

Add `invitedKeysFromState` to the existing `fg-sync.js` import.

- [ ] **Step 6: Run tests**

Run: `node --test tests/fg-already-invited-status.test.js tests/fg-roster-autopilot.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/connections/fg-sync.js services/fg-roster/autopilot.js server.js tests/fg-already-invited-status.test.js
git commit -m "feat(fg): Failed invites are retryable — alreadyInvited counts Invited only"
```

---

### Task 5: Run Health tab + one-time migration (Apps Script)

**Files:**
- Modify: `fg-apps-script.js` (add `fgMigrateRunHealth_()` run-once helper)

Not `node --test`-able — run once from the editor, verify in the sheet.

- [ ] **Step 1: Add the migration helper**

`fg-apps-script.js` — add. It: ensures the 3 columns exist, backfills `Run At` from `Invited At`, tags legacy `Run ID`, relabels stuck `Queued`→`Failed`, adds Sent/Stuck flag helper columns, and (re)builds the `Run Health` tab with a single QUERY + Result/Credits/Note formulas.

```js
function fgMigrateRunHealth_() {
  var ss = SpreadsheetApp.getActive();
  var sh = sheet_('FG Invites', FG_HEADER); // ensures the 3 new headers exist
  var last = sh.getLastRow();
  if (last > 1) {
    var iWhen = FG_HEADER.indexOf('Invited At');   // 10
    var iRun = FG_HEADER.indexOf('Run ID');        // 13
    var iRunAt = FG_HEADER.indexOf('Run At');      // 14
    var iStatus = FG_HEADER.indexOf('Status');     // 9
    var rng = sh.getRange(2, 1, last - 1, FG_HEADER.length);
    var vals = rng.getValues();
    for (var i = 0; i < vals.length; i++) {
      if (!vals[i][iRun]) vals[i][iRun] = 'legacy';
      if (!vals[i][iRunAt] && vals[i][iWhen]) vals[i][iRunAt] = new Date(vals[i][iWhen]);
      if (vals[i][iStatus] === 'Queued') { vals[i][iStatus] = 'Failed'; vals[i][FG_HEADER.indexOf('Reason')] = 'legacy — never confirmed'; }
    }
    rng.setValues(vals);
    sh.getRange(2, iRunAt + 1, last - 1, 1).setNumberFormat('dd mmm yyyy, HH:mm');
    sh.getRange(2, iWhen + 1, last - 1, 1).setNumberFormat('dd mmm yyyy, HH:mm');
  }
  // Sent/Stuck flag helper columns (Q, R) as whole-column array formulas.
  sh.getRange('Q1').setValue('Sent1');
  sh.getRange('R1').setValue('Stuck1');
  sh.getRange('Q2').setFormula('=ARRAYFORMULA(IF(J2:J="Invited",1,0))');
  sh.getRange('R2').setFormula('=ARRAYFORMULA(IF(J2:J="Failed",1,0))');

  // Run Health tab.
  var rh = ss.getSheetByName('Run Health') || ss.insertSheet('Run Health', 0);
  rh.clear();
  rh.getRange('A1').setValue('Run Health · one row per account × run · newest first').setFontWeight('bold');
  // The QUERY: group by Run At, Account, Operator; count targeted; sum sent/stuck.
  rh.getRange('A3').setFormula(
    "=QUERY('FG Invites'!A2:R, \"select O, I, H, count(A), sum(Q), sum(R) " +
    "where N is not null group by O, I, H order by O desc " +
    "label O 'Run At', I 'Account', H 'Operator', count(A) 'Targeted', sum(Q) 'Sent', sum(R) 'Stuck'\", 0)"
  );
  // Derived Result / Credits left / Note next to the QUERY block.
  rh.getRange('G3').setValue('Result');
  rh.getRange('H3').setValue('Credits left');
  rh.getRange('I3').setValue('Note');
  rh.getRange('G4').setFormula(
    '=ARRAYFORMULA(IF(LEN(A4:A)=0,,IF(E4:E>=D4:D,"✓ All sent",IF(E4:E=0,"✗ Nothing sent","◑ Partial"))))'
  );
  rh.getRange('H4').setFormula('=ARRAYFORMULA(IF(LEN(A4:A)=0,,MAX(0,30-E4:E)&" / 30"))');
  rh.getRange('I4').setFormula(
    "=ARRAYFORMULA(IF(LEN(A4:A)=0,,IF(F4:F=0,\"\",IFERROR(VLOOKUP(1,{'FG Invites'!R2:R,'FG Invites'!P2:P},2,FALSE),\"\"))))"
  );
  // Conditional formatting on Result (col G).
  var rules = rh.getConditionalFormatRules();
  var mk = function (text, bg, fg) {
    return SpreadsheetApp.newConditionalFormatRule()
      .whenTextContains(text).setBackground(bg).setFontColor(fg)
      .setRanges([rh.getRange('G4:G1000')]).build();
  };
  rules.push(mk('✓', '#e6f4ea', '#137333'));
  rules.push(mk('◑', '#fef7e0', '#b06000'));
  rules.push(mk('✗', '#fce8e6', '#c5221f'));
  rh.setConditionalFormatRules(rules);
  rh.setFrozenRows(3);
  return 'migrated';
}
```

- [ ] **Step 2: Run it once**

In the Apps Script editor: Run → `fgMigrateRunHealth_`. Grant permissions if prompted.

- [ ] **Step 3: Verify in the sheet**

1. `FG Invites`: header ends `Run ID | Run At | Reason`; old stuck `Queued` rows now `Failed` + `legacy — never confirmed`; `Run At`/`Invited At` render as `17 Jul 2026, 12:40`.
2. `Run Health`: newest run on top, one row per account, `Result` green/amber/red, `Credits left` like `0 / 30`.

- [ ] **Step 4: Commit**

```bash
git add fg-apps-script.js
git commit -m "feat(fg-script): Run Health tab + one-time run-health migration"
```

---

## Self-Review

**Spec coverage:**
- Two tabs (detail migrated + Run Health formula) → Tasks 1,2,5. ✓
- Append `Run ID/Run At/Reason`, keep order → Task 1 (both FG_HEADER) + constraint. ✓
- Status Invited/Failed, no permanent Queued → Task 2 (`fgMarkFailed_`) + Task 3 (reconcile sweep) + Task 5 (legacy relabel). ✓
- Readable dates → Task 2 (new writes) + Task 5 (backfill/format). ✓
- Account always real → already handled by `fgtlPairs()` fallback (existing); no new task needed. ✓
- Run Health auto-formula → Task 5 QUERY. ✓
- Failed retryable / alreadyInvited=Invited only → Task 4. ✓
- Constraints (positional writes, appended cols) → Global Constraints + Task 1. ✓

**Placeholder scan:** none — every step has concrete code/commands.

**Type consistency:** `queueFgInvites(rows, {runId, runAt})`, `markFgFailed({runId, reason})`, `invitedKeysFromState(invites)`, `stampRunCells(rows,{runId,runAt})` — names identical across Tasks 1/3/4. Reconcile uses `deps.markFailed({runId, reason})` wired to `markFgFailed` in Task 3 Step 5. ✓

**Out of scope:** live-card "who's sending now" label — separate follow-up, not in this plan.
