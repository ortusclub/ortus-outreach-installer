# CC+IC Stamp Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make CC+IC campaigns survive end-of-batch (stop the `status` getter crash) and stop the runaway intro retry loop (downgrade false-positive Connected stamps + cap repeat failures).

**Architecture:** Three independent fixes layered on top of the existing CC+IC pipeline. (A) flip `enumerable` on the `status` getter so spread+Object.assign round-trips don't throw. (B) when intro fails with `compose textbox did not appear` against a `CC=Connected` row, navigate to the lead's profile, call `getConnectionStatus(page)`, and downgrade the row to `Unverified — manual review …` on `connect`/`pending`. (B+) add a sticky short-circuit in bulk-check so a downgraded row stays downgraded across passes. (C) keep an in-memory `Map<url, count>` of compose-textbox failures; once a URL hits 3, bulk-check stops pushing it into `connectedUrls`.

**Tech Stack:** Node ≥22, vanilla ESM, `node --test` (no Jest), puppeteer-core ^22 for page operations (via existing `getConnectionStatus` helper), no new dependencies.

**Off-limits files:** `src/linkedin/outreach.js` and `src/linkedin/actions.js`. Read-only for context; do NOT edit. All other files (including `src/linkedin/helpers.js`, `src/linkedin/auto-intro.js`, `src/linkedin/bulk-check-connections.js`, `src/campaign.js`) are editable.

**Spec:** `docs/superpowers/specs/2026-05-27-cc-ic-stamp-resilience-design.md`

---

## File map

| File | What changes | New / Modified |
|---|---|---|
| `src/campaign.js` | line 486 `enumerable: true → false`; line 475 add `composeAttempts: new Map()`; line 1185 add `campaign.composeAttempts = new Map()` reset | Modified |
| `src/linkedin/auto-intro.js` | Export new `_decideReverifyAction` pure helper; add `_reverifyAndDowngrade` IO helper; wire both into the failure branch around line 343; import `getConnectionStatus`; increment `campaign.composeAttempts` on compose-textbox failure | Modified |
| `src/linkedin/bulk-check-connections.js` | Add `Unverified — manual review` short-circuit at line 99-100; add `composeAttempts` cap check at line 158; thread `composeAttempts` through `computeBulkCheckUpdates` opts; pass `campaign.composeAttempts` from the wrapper; extend diag block | Modified |
| `tests/campaign-status-getter.test.js` | 2 tests: status read via getter; spread+Object.assign round-trips cleanly | NEW |
| `tests/reverify-decision.test.js` | 6 tests covering the `_decideReverifyAction` decision matrix | NEW |
| `tests/bulk-check-connections.test.js` | 3 new tests: sticky downgrade, cap blocks at 3, cap allows below 3 | Modified |

---

## Task 1 — Fix A: stop the crash on monitoring transition

**Files:**
- Modify: `src/campaign.js:485-494` (single property descriptor)
- Test: `tests/campaign-status-getter.test.js` (NEW)

- [ ] **Step 1.1: Write the failing regression test**

Create `tests/campaign-status-getter.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { campaign } from '../src/campaign.js';

test('status getter is readable via direct property access', () => {
  campaign.running = false;
  campaign._paused = false;
  campaign._pauseRequested = false;
  campaign.state = undefined;
  assert.strictEqual(campaign.status, 'idle');

  campaign.running = true;
  assert.strictEqual(campaign.status, 'running');

  campaign.running = false;
  campaign.state = 'monitoring';
  assert.strictEqual(campaign.status, 'monitoring');

  campaign._paused = true;
  assert.strictEqual(campaign.status, 'paused');

  // restore clean state
  campaign.running = false;
  campaign._paused = false;
  campaign._pauseRequested = false;
  campaign.state = undefined;
});

test('status getter is non-enumerable so spread + Object.assign round-trips do not throw', () => {
  campaign.running = true;
  const snapshot = { ...campaign, state: 'monitoring' };
  assert.ok(
    !Object.prototype.hasOwnProperty.call(snapshot, 'status'),
    'spread should not capture the status getter'
  );
  assert.doesNotThrow(
    () => Object.assign(campaign, snapshot),
    'Object.assign(campaign, snapshot) must not throw on the status property'
  );
  // restore
  campaign.running = false;
  campaign.state = undefined;
});
```

- [ ] **Step 1.2: Run the new tests to confirm they fail**

```bash
node --test tests/campaign-status-getter.test.js
```

Expected:
- Test 1 (`status getter is readable…`) → **PASS** (getter behaviour unchanged)
- Test 2 (`status getter is non-enumerable…`) → **FAIL** with `TypeError: Cannot set property status of #<Object> which has only a getter`

- [ ] **Step 1.3: Apply the one-line fix**

In `src/campaign.js`, locate the `Object.defineProperty(campaign, 'status', { ... })` block (lines 485-494). Change `enumerable: true` to `enumerable: false`:

```js
Object.defineProperty(campaign, 'status', {
  enumerable: false,         // ← was: true
  configurable: true,
  get() {
    if (this._paused || this._pauseRequested) return 'paused';
    if (this.running) return 'running';
    if (this.state === 'monitoring') return 'monitoring';
    return 'idle';
  },
});
```

No other change in this file for this task.

- [ ] **Step 1.4: Re-run the test, confirm pass**

```bash
node --test tests/campaign-status-getter.test.js
```

Expected: both tests PASS.

- [ ] **Step 1.5: Run the full test suite, confirm nothing else broke**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 1.6: Commit**

```bash
git add src/campaign.js tests/campaign-status-getter.test.js
git commit -m "$(cat <<'EOF'
fix(campaign): non-enumerable status getter so monitoring transition doesn't crash

The transitionToMonitoring helper returns { ...campaign, state: 'monitoring' }
and the caller in campaign.js:2990 runs Object.assign(campaign, updated). With
the status getter enumerable, spread copies the getter's resolved value into the
new object as a regular data property; Object.assign then tries to write that
value back onto campaign.status, which has no setter → strict-mode TypeError.

Flipping to enumerable: false makes the getter invisible to spread / Object.keys /
JSON.stringify while keeping direct reads (campaign.status, registry.entry.status)
working. Adds a regression test that reproduces the crash and verifies the round-trip.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 1.7: Auto-relaunch dev:app per durable rule**

```bash
pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "Electron.*ortus" 2>/dev/null
npm run dev:app > /tmp/dev-app.log 2>&1 &
```

Expected: dev:app boots, `/tmp/dev-app.log` does NOT contain `Fatal: Cannot set property status`.

---

## Task 2 — Fix B (pure): `_decideReverifyAction` helper

**Files:**
- Modify: `src/linkedin/auto-intro.js` (add exported pure function near `_friendlyIntroFailure`, around line 36)
- Test: `tests/reverify-decision.test.js` (NEW)

- [ ] **Step 2.1: Write the failing tests**

Create `tests/reverify-decision.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _decideReverifyAction } from '../src/linkedin/auto-intro.js';

test('downgrade when status is connect and CC=Connected', () => {
  assert.deepStrictEqual(
    _decideReverifyAction('connect', 'Connected'),
    { action: 'downgrade' }
  );
});

test('downgrade when status is pending and CC=Connected', () => {
  assert.deepStrictEqual(
    _decideReverifyAction('pending', 'Connected'),
    { action: 'downgrade' }
  );
});

test('noop with reason genuine-1st-degree when status is message', () => {
  assert.deepStrictEqual(
    _decideReverifyAction('message', 'Connected'),
    { action: 'noop', reason: 'genuine-1st-degree' }
  );
});

test('noop with reason follow-only-restricted when status is follow', () => {
  assert.deepStrictEqual(
    _decideReverifyAction('follow', 'Connected'),
    { action: 'noop', reason: 'follow-only-restricted' }
  );
});

test('noop with reason ambiguous when status is unknown', () => {
  assert.deepStrictEqual(
    _decideReverifyAction('unknown', 'Connected'),
    { action: 'noop', reason: 'ambiguous' }
  );
});

test('noop with reason cc-not-connected when row CC is anything but Connected', () => {
  assert.deepStrictEqual(
    _decideReverifyAction('connect', ''),
    { action: 'noop', reason: 'cc-not-connected' }
  );
  assert.deepStrictEqual(
    _decideReverifyAction('connect', 'Already connected'),
    { action: 'noop', reason: 'cc-not-connected' }
  );
  assert.deepStrictEqual(
    _decideReverifyAction('connect', 'Unverified — manual review (May 27th, 2026)'),
    { action: 'noop', reason: 'cc-not-connected' }
  );
});
```

- [ ] **Step 2.2: Run to confirm failure**

```bash
node --test tests/reverify-decision.test.js
```

Expected: all 6 tests FAIL with `SyntaxError: The requested module '../src/linkedin/auto-intro.js' does not provide an export named '_decideReverifyAction'`.

- [ ] **Step 2.3: Add the pure helper to `src/linkedin/auto-intro.js`**

In `src/linkedin/auto-intro.js`, just above the `_friendlyIntroFailure` definition (which starts with `// v2.57.x — Translate raw sendIntroMessage error strings into operator-friendly` around line 36), add:

```js
// v2.61.0: pure decision helper for reverify-and-downgrade (spec
// 2026-05-27-cc-ic-stamp-resilience). Given the result of
// getConnectionStatus(page) and the row's current `Connection Accepted Status`
// value, decide whether to downgrade the row. Strict mode: only clear-negative
// signals ('connect', 'pending') downgrade; 'message' / 'follow' / 'unknown' /
// 'error' all return noop so a flaky DOM read never clobbers a real connection.
export function _decideReverifyAction(connectionStatus, currentCc) {
  if (currentCc !== 'Connected') {
    return { action: 'noop', reason: 'cc-not-connected' };
  }
  if (connectionStatus === 'connect' || connectionStatus === 'pending') {
    return { action: 'downgrade' };
  }
  if (connectionStatus === 'message') {
    return { action: 'noop', reason: 'genuine-1st-degree' };
  }
  if (connectionStatus === 'follow') {
    return { action: 'noop', reason: 'follow-only-restricted' };
  }
  return { action: 'noop', reason: 'ambiguous' };
}
```

- [ ] **Step 2.4: Re-run tests, confirm pass**

```bash
node --test tests/reverify-decision.test.js
```

Expected: all 6 tests PASS.

- [ ] **Step 2.5: Commit**

```bash
git add src/linkedin/auto-intro.js tests/reverify-decision.test.js
git commit -m "$(cat <<'EOF'
feat(auto-intro): add _decideReverifyAction pure helper

Pure decision matrix used by the upcoming reverify-and-downgrade flow.
Maps getConnectionStatus(page) results × current `Connection Accepted Status`
to either { action: 'downgrade' } or { action: 'noop', reason }.

Strict semantics: only 'connect' or 'pending' against CC='Connected' returns
downgrade. 'message' (real 1st-degree), 'follow' (InMail-restricted), and
'unknown' all return noop — a flaky DOM read must never clobber a real
connection stamp.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3 — Fix B (IO): `_reverifyAndDowngrade` + wiring

**Files:**
- Modify: `src/linkedin/auto-intro.js` (add import of `getConnectionStatus`; add `_reverifyAndDowngrade` IO helper; call from the existing failure branch around line 343)

- [ ] **Step 3.1: Add import**

In `src/linkedin/auto-intro.js`, modify line 22 (the existing `import { personalizeTemplate } from './helpers.js';`) to also import `getConnectionStatus`:

```js
import { personalizeTemplate, getConnectionStatus } from './helpers.js';
```

- [ ] **Step 3.2: Add the IO helper**

Below the `_decideReverifyAction` block added in Task 2, add `_reverifyAndDowngrade`:

```js
// v2.61.0: navigate to the lead profile and call getConnectionStatus to
// confirm whether the row's `Connection Accepted Status = Connected` stamp
// is genuine. Used when sendIntroMessage throws compose-textbox-did-not-appear
// on a row stamped Connected — that combination is impossible for a real
// 1st-degree connection (LinkedIn loads compose for them).
//
// On clear-negative ('connect' or 'pending'), writes back
// `Connection Accepted Status = 'Unverified — manual review (<date>)'` so
// the next bulk-check pass leaves the row alone (bulk-check has a sticky
// short-circuit for that exact prefix).
async function _reverifyAndDowngrade({
  page, url, profileName, sheetUrl, linkedinColumn, currentCc, log,
}) {
  if (currentCc !== 'Connected') return { reverified: false };

  let connectionStatus;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await new Promise((r) => setTimeout(r, 1500));
    connectionStatus = await getConnectionStatus(page);
  } catch (err) {
    log(`  ⚠ [${profileName}] ${url}: reverify navigation failed (${err.message}) — keeping stamp`);
    return { reverified: false, status: 'error' };
  }

  const decision = _decideReverifyAction(connectionStatus, currentCc);
  if (decision.action !== 'downgrade') {
    log(`  ↻ [${profileName}] ${url}: reverify='${connectionStatus}' — keeping stamp (${decision.reason})`);
    return { reverified: true, status: connectionStatus, downgraded: false };
  }

  const stamp = `Unverified — manual review (${_formatLocalDate(new Date())})`;
  try {
    await updateSheetRow(sheetUrl, url, {
      cc: stamp,
      checkStatus: stamp,
      auditAction: `Reverify after compose-textbox failure: not connected (getConnectionStatus='${connectionStatus}')`,
    }, linkedinColumn);
    log(`  ⤓ [${profileName}] ${url}: downgraded — getConnectionStatus='${connectionStatus}'`);
    return { reverified: true, status: connectionStatus, downgraded: true };
  } catch (err) {
    log(`  ⚠ [${profileName}] ${url}: downgrade write failed (${err.message})`);
    return { reverified: true, status: connectionStatus, downgraded: false };
  }
}
```

- [ ] **Step 3.3: Wire the call into the existing failure branch**

In `src/linkedin/auto-intro.js`, locate the `while (attempt < 2) { ... }` block that wraps `sendIntroMessage` (around line 321-345). Immediately after that loop closes and BEFORE the `const interrupted = ...` line, add the reverify hook:

```js
    // v2.61.0: if intro failed with compose-textbox-did-not-appear AND the row's
    // Connection Accepted Status reads "Connected", that combination is impossible
    // for a real 1st-degree connection (LinkedIn loads compose for them). Reverify
    // via profile visit and downgrade the row if not actually connected.
    if (!ok && !alreadyMade && errMsg.includes('MESSAGE_SEND_FAILED: compose textbox did not appear')) {
      const currentCc = (row['Connection Accepted Status'] || row['connection accepted status'] || '').toString().trim();
      if (currentCc === 'Connected') {
        await _reverifyAndDowngrade({
          page, url, profileName,
          sheetUrl, linkedinColumn,
          currentCc, log,
        });
      }
    }
```

The existing `const interrupted = ...` line and everything below stay unchanged. The reverify happens BEFORE the abort/browser-dead reclassification because: if browser dies during reverify, the catch in `_reverifyAndDowngrade` swallows it; the subsequent `_browserAlive()` check then reclassifies the row as `Skipped — browser closed`.

- [ ] **Step 3.4: Sanity check — re-run the test suite**

```bash
npm test
```

Expected: all tests pass. No new tests for this step (the IO helper is integration-level; pure logic is covered by Task 2).

- [ ] **Step 3.5: Commit**

```bash
git add src/linkedin/auto-intro.js
git commit -m "$(cat <<'EOF'
feat(auto-intro): reverify-and-downgrade on compose-textbox failure

When sendIntroMessage throws MESSAGE_SEND_FAILED: compose textbox did not
appear against a row stamped CC='Connected', navigate to the lead profile,
call getConnectionStatus(page), and downgrade the row to 'Unverified —
manual review (<date>)' on 'connect'/'pending'. Other statuses (including
'message', 'follow', 'unknown', and navigation errors) keep the stamp —
a flaky DOM read must never clobber a real connection.

Pairs with the upcoming sticky short-circuit in bulk-check-connections.js
so downgraded rows stay downgraded across subsequent passes.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4 — Fix B+: sticky short-circuit in bulk-check

**Files:**
- Modify: `src/linkedin/bulk-check-connections.js` (add `if (cs.startsWith('Unverified — manual review'))` skip at line 99-100; add `dbgAlreadyUnverified` counter + diag wiring)
- Test: `tests/bulk-check-connections.test.js` (add 1 new test)

- [ ] **Step 4.1: Write the failing test**

Append to `tests/bulk-check-connections.test.js` (after the existing tests):

```js
test('sticky downgrade: row with CC starting with "Unverified — manual review" is skipped before isMatch', () => {
  const downgradedRow = baseRow({
    'First Name': 'Jane',
    'Last Name': 'Doe',
    'LinkedIn URL': 'https://linkedin.com/in/jane-doe',
    'Connection Request Status': 'Connection Request Sent',
    'Connection Accepted Status': 'Unverified — manual review (May 27th, 2026)',
  });
  const { updates, connectedUrls, diag } = computeBulkCheckUpdates(
    [downgradedRow], baseConns, linkedinColumn, stillPendingLabel, {}
  );
  assert.ok(
    !connectedUrls.includes('https://linkedin.com/in/jane-doe'),
    'downgraded row must NOT be queued for auto-intro'
  );
  assert.ok(
    !updates.some((u) => u.linkedinUrl === 'https://linkedin.com/in/jane-doe'),
    'downgraded row must NOT receive any stamp write this pass'
  );
  assert.equal(diag.alreadyUnverified, 1, 'diag counter should record the skip');
});
```

- [ ] **Step 4.2: Run, confirm failure**

```bash
node --test tests/bulk-check-connections.test.js
```

Expected: the new test FAILS — `connectedUrls` does contain the URL, and `diag.alreadyUnverified` is `undefined`.

- [ ] **Step 4.3: Apply the short-circuit in `src/linkedin/bulk-check-connections.js`**

Step 4.3a — locate the counter init block around line 77-79:
```js
let dbgRowsScanned = 0, dbgWithUrl = 0, dbgWithCRS = 0;
let dbgAlreadyConnected = 0, dbgAlreadyDeclined = 0, dbgPidMatched = 0;
let dbgAlreadyIntroduced = 0;
```

Add a new counter:
```js
let dbgAlreadyUnverified = 0;
```

(Place it directly below `let dbgAlreadyIntroduced = 0;` so all `dbg*` counters stay grouped.)

Step 4.3b — locate the `Connection Declined` skip at line 99:
```js
if (cs === 'Connection Declined') { dbgAlreadyDeclined++; continue; }
```

Add the sticky-downgrade skip immediately AFTER it:
```js
if (cs === 'Connection Declined') { dbgAlreadyDeclined++; continue; }
// v2.61.0: sticky downgrade — auto-intro.js writes this exact prefix when
// reverify confirms a Connected stamp was a false positive. Leaving the
// row alone means subsequent bulk-check passes can't restamp Connected
// even if Voyager still returns the URN. Operator clears the cell to retry.
if (cs.startsWith('Unverified — manual review')) {
  dbgAlreadyUnverified++;
  continue;
}
```

Step 4.3c — extend the diag block (around line 240-256). Add `alreadyUnverified: dbgAlreadyUnverified,` next to `alreadyIntroduced`:
```js
    diag: {
      rowsScanned: dbgRowsScanned,
      withUrl: dbgWithUrl,
      withCRS: dbgWithCRS,
      alreadyConnected: dbgAlreadyConnected,
      alreadyDeclined: dbgAlreadyDeclined,
      alreadyIntroduced: dbgAlreadyIntroduced,
      alreadyUnverified: dbgAlreadyUnverified,
      pidMatched: dbgPidMatched,
      slugs: connectedSlugs.size,
      // … rest unchanged …
```

Step 4.3d — extend the `diagSummary` string at line ~357. Find:
```js
const diagSummary = `scanned=${diag.rowsScanned}, withUrl=${diag.withUrl}, slugs=${diag.slugs}, memberIds=${diag.memberIds}, names=${diag.names}, pidMatched=${diag.pidMatched}, alreadyConnected=${diag.alreadyConnected}, alreadyIntroduced=${diag.alreadyIntroduced}, alreadyDeclined=${diag.alreadyDeclined}, stamped=${diag.withCRS}\n  ↳ sampleSheetSlugs=${diag.sampleSheetSlugs.join(' | ') || '(none)'}\n  ↳ sampleSheetMemberIds=${diag.sampleSheetMemberIds.join(' | ') || '(none)'}\n  ↳ sampleConnectedSlugs=${diag.sampleConnectedSlugs.join(' | ') || '(none)'}\n  ↳ sampleConnectedMemberIds=${diag.sampleConnectedMemberIds.join(' | ') || '(none)'}\n  ↳ sampleConnectedNames=${diag.sampleConnectedNames.join(' | ') || '(none)'}\n  ↳ sampleCRS=${[...diag.sampleCRSValues].join(' | ') || '(none)'}`;
```

Insert `alreadyUnverified=${diag.alreadyUnverified}, ` immediately before `alreadyDeclined=`:
```js
const diagSummary = `scanned=${diag.rowsScanned}, withUrl=${diag.withUrl}, slugs=${diag.slugs}, memberIds=${diag.memberIds}, names=${diag.names}, pidMatched=${diag.pidMatched}, alreadyConnected=${diag.alreadyConnected}, alreadyIntroduced=${diag.alreadyIntroduced}, alreadyUnverified=${diag.alreadyUnverified}, alreadyDeclined=${diag.alreadyDeclined}, stamped=${diag.withCRS}\n  ↳ sampleSheetSlugs=${diag.sampleSheetSlugs.join(' | ') || '(none)'}\n  ↳ sampleSheetMemberIds=${diag.sampleSheetMemberIds.join(' | ') || '(none)'}\n  ↳ sampleConnectedSlugs=${diag.sampleConnectedSlugs.join(' | ') || '(none)'}\n  ↳ sampleConnectedMemberIds=${diag.sampleConnectedMemberIds.join(' | ') || '(none)'}\n  ↳ sampleConnectedNames=${diag.sampleConnectedNames.join(' | ') || '(none)'}\n  ↳ sampleCRS=${[...diag.sampleCRSValues].join(' | ') || '(none)'}`;
```

- [ ] **Step 4.4: Re-run, confirm pass**

```bash
node --test tests/bulk-check-connections.test.js
```

Expected: the new test plus all existing tests in the file PASS.

- [ ] **Step 4.5: Run full suite**

```bash
npm test
```

Expected: all PASS.

- [ ] **Step 4.6: Commit**

```bash
git add src/linkedin/bulk-check-connections.js tests/bulk-check-connections.test.js
git commit -m "$(cat <<'EOF'
fix(bulk-check): sticky short-circuit for downgraded rows

Adds a skip at line 99-100 for rows whose Connection Accepted Status starts
with 'Unverified — manual review'. Without this, a row downgraded by
auto-intro.js's reverify-and-downgrade flow would be re-stamped 'Connected'
on the next bulk-check pass whenever Voyager still returned the URN — making
the downgrade non-sticky and the runaway retry loop continue.

New diag counter alreadyUnverified surfaces in the per-pass summary line.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5 — Fix C: composeAttempts state on `campaign`

**Files:**
- Modify: `src/campaign.js` line 475 (add field to literal); line 1185 area (add reset in startCampaign)

- [ ] **Step 5.1: Add field to the `campaign` object literal**

In `src/campaign.js` immediately AFTER the `introducedInRun: new Set(),` line (line 475), add:

```js
  // v2.61.0: count of MESSAGE_SEND_FAILED: compose-textbox failures per URL
  // within this process. Bulk-check uses it to stop re-queueing leads that
  // fail repeatedly even when reverify-and-downgrade (auto-intro.js) was
  // inconclusive (e.g. getConnectionStatus returned 'unknown'). Resets on
  // each new campaign run.
  composeAttempts: new Map(),
```

- [ ] **Step 5.2: Add the reset in `startCampaign`**

In `src/campaign.js`, locate line 1185 (`campaign.introducedInRun = new Set();`). Immediately AFTER it, add:

```js
  campaign.composeAttempts = new Map();
```

- [ ] **Step 5.3: Verify by reading the symbol back**

```bash
node -e "import('./src/campaign.js').then(({ campaign }) => { console.log('composeAttempts:', campaign.composeAttempts instanceof Map ? 'OK Map' : 'WRONG'); });"
```

Expected output: `composeAttempts: OK Map`

- [ ] **Step 5.4: Run full suite**

```bash
npm test
```

Expected: all tests still pass (no new tests yet — they come in Task 6 alongside the consumer code).

- [ ] **Step 5.5: Commit**

```bash
git add src/campaign.js
git commit -m "$(cat <<'EOF'
feat(campaign): add composeAttempts in-memory Map for intro retry cap

Tracks MESSAGE_SEND_FAILED: compose-textbox failures per URL within the
process. Reset in startCampaign so each run starts clean. Mirrors the
existing introducedInRun Set pattern.

Bulk-check consumer (Task 6) reads this Map to skip leads that have hit
the cap. No behaviour change yet — purely state-introduction.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6 — Fix C: wire increment + cap check

**Files:**
- Modify: `src/linkedin/auto-intro.js` (increment `campaign.composeAttempts` next to the reverify call from Task 3)
- Modify: `src/linkedin/bulk-check-connections.js` (read `composeAttempts` from opts; skip on count ≥ 3; thread through wrapper)
- Test: `tests/bulk-check-connections.test.js` (add 2 new tests)

- [ ] **Step 6.1: Write the two failing cap tests**

Append to `tests/bulk-check-connections.test.js` (after the sticky-downgrade test from Task 4):

```js
test('cap: URL with composeAttempts >= 3 is excluded from connectedUrls', () => {
  const matchingRow = baseRow();
  const composeAttempts = new Map([['https://linkedin.com/in/jane-doe', 3]]);
  const { connectedUrls, diag } = computeBulkCheckUpdates(
    [matchingRow], baseConns, linkedinColumn, stillPendingLabel, { composeAttempts }
  );
  assert.ok(
    !connectedUrls.includes('https://linkedin.com/in/jane-doe'),
    'URL with 3+ compose-textbox failures must not re-enter the intro queue'
  );
  assert.equal(diag.composeCapped, 1, 'diag counter should record the cap skip');
});

test('cap: URL with composeAttempts < 3 still flows through to connectedUrls', () => {
  const matchingRow = baseRow();
  const composeAttempts = new Map([['https://linkedin.com/in/jane-doe', 2]]);
  const { connectedUrls } = computeBulkCheckUpdates(
    [matchingRow], baseConns, linkedinColumn, stillPendingLabel, { composeAttempts }
  );
  assert.ok(
    connectedUrls.includes('https://linkedin.com/in/jane-doe'),
    'URL below the cap must still be queued for auto-intro retry'
  );
});

test('cap: no composeAttempts opt (undefined) defaults to allow', () => {
  const matchingRow = baseRow();
  const { connectedUrls } = computeBulkCheckUpdates(
    [matchingRow], baseConns, linkedinColumn, stillPendingLabel, {}
  );
  assert.ok(
    connectedUrls.includes('https://linkedin.com/in/jane-doe'),
    'omitted composeAttempts must not block any URL (back-compat)'
  );
});
```

- [ ] **Step 6.2: Run, confirm failures**

```bash
node --test tests/bulk-check-connections.test.js
```

Expected:
- `cap: URL with composeAttempts >= 3 is excluded…` → FAIL (URL still in connectedUrls)
- `cap: URL with composeAttempts < 3 still flows through…` → PASS (no change yet)
- `cap: no composeAttempts opt (undefined) defaults to allow` → PASS (no change yet)

- [ ] **Step 6.3: Add the cap check in `src/linkedin/bulk-check-connections.js`**

Step 6.3a — extract `composeAttempts` from opts in `computeBulkCheckUpdates`. Locate the function signature line 54-55:
```js
export function computeBulkCheckUpdates(rows, conns, linkedinColumn, stillPendingLabel, opts = {}) {
  const { suppressAcceptedStamp = false, profileName = '', introducedInRun = null } = opts;
```

Add `composeAttempts = null` to the destructure:
```js
export function computeBulkCheckUpdates(rows, conns, linkedinColumn, stillPendingLabel, opts = {}) {
  const { suppressAcceptedStamp = false, profileName = '', introducedInRun = null, composeAttempts = null } = opts;
```

Step 6.3b — add a counter. Right next to the `dbgAlreadyUnverified` counter you added in Task 4:
```js
let dbgComposeCapped = 0;
```

Step 6.3c — add the cap check next to the existing `introducedInRun.has(url)` check at line 155-158:
```js
      if (introducedInRun && introducedInRun.has(url)) {
        dbgAlreadyIntroduced++;
        continue;
      }
      // v2.61.0: per-URL compose-textbox failure cap. If reverify-and-downgrade
      // didn't resolve the row (e.g. getConnectionStatus returned 'unknown'),
      // this caps repeat attempts so a single false-positive doesn't produce a
      // 30+ retry storm over a single process lifetime.
      if (composeAttempts && (composeAttempts.get(url) || 0) >= 3) {
        dbgComposeCapped++;
        continue;
      }
```

Step 6.3d — extend the diag block. Add `composeCapped: dbgComposeCapped,` next to `alreadyUnverified`:
```js
      alreadyUnverified: dbgAlreadyUnverified,
      composeCapped: dbgComposeCapped,
```

Step 6.3e — extend the `diagSummary` string. Find the existing line (already extended in Task 4):
```js
… alreadyIntroduced=${diag.alreadyIntroduced}, alreadyUnverified=${diag.alreadyUnverified}, alreadyDeclined=${diag.alreadyDeclined}, …
```

Insert `composeCapped=${diag.composeCapped}, ` immediately before `alreadyDeclined=`:
```js
… alreadyIntroduced=${diag.alreadyIntroduced}, alreadyUnverified=${diag.alreadyUnverified}, composeCapped=${diag.composeCapped}, alreadyDeclined=${diag.alreadyDeclined}, …
```

Step 6.3f — pass `composeAttempts` from the wrapper. Locate the `bulkCheckConnections` wrapper around line 341-355 where it calls `computeBulkCheckUpdates`. The current opts block is:
```js
    {
      suppressAcceptedStamp: opts.suppressAcceptedStamp === true,
      profileName: pName || '',
      introducedInRun: opts.introducedInRun || campaign.introducedInRun,
    }
```

Add `composeAttempts`:
```js
    {
      suppressAcceptedStamp: opts.suppressAcceptedStamp === true,
      profileName: pName || '',
      introducedInRun: opts.introducedInRun || campaign.introducedInRun,
      composeAttempts: opts.composeAttempts || campaign.composeAttempts,
    }
```

- [ ] **Step 6.4: Wire the increment in `src/linkedin/auto-intro.js`**

In `src/linkedin/auto-intro.js`, modify the reverify hook block added in Task 3 (Step 3.3). Add the increment INSIDE the compose-textbox condition (BEFORE the reverify call):

```js
    // v2.61.0: if intro failed with compose-textbox-did-not-appear AND the row's
    // Connection Accepted Status reads "Connected", that combination is impossible
    // for a real 1st-degree connection. Reverify via profile visit and downgrade
    // the row if not actually connected. Also increment the per-URL cap counter
    // so bulk-check can stop re-queueing this URL after 3 attempts.
    if (!ok && !alreadyMade && errMsg.includes('MESSAGE_SEND_FAILED: compose textbox did not appear')) {
      const prev = campaign.composeAttempts?.get?.(url) || 0;
      campaign.composeAttempts?.set?.(url, prev + 1);

      const currentCc = (row['Connection Accepted Status'] || row['connection accepted status'] || '').toString().trim();
      if (currentCc === 'Connected') {
        await _reverifyAndDowngrade({
          page, url, profileName,
          sheetUrl, linkedinColumn,
          currentCc, log,
        });
      }
    }
```

- [ ] **Step 6.5: Re-run targeted + full suite**

```bash
node --test tests/bulk-check-connections.test.js
```

Expected: all 3 new cap tests PASS.

```bash
npm test
```

Expected: full suite PASS.

- [ ] **Step 6.6: Commit**

```bash
git add src/linkedin/auto-intro.js src/linkedin/bulk-check-connections.js tests/bulk-check-connections.test.js
git commit -m "$(cat <<'EOF'
feat(bulk-check, auto-intro): retry cap on compose-textbox failures

auto-intro.js increments campaign.composeAttempts.set(url, n+1) every time
sendIntroMessage throws MESSAGE_SEND_FAILED: compose textbox did not appear.

bulk-check-connections.js (computeBulkCheckUpdates + bulkCheckConnections
wrapper) reads campaign.composeAttempts via the opts.composeAttempts hatch.
URLs with 3 or more attempts are skipped before reaching connectedUrls.
New diag counter composeCapped surfaces in the per-pass summary.

Safety net for cases where the reverify-and-downgrade flow couldn't make
a determination (getConnectionStatus returned 'unknown', navigation failed,
etc.). Single false-positive Connected stamp can no longer produce a 30+
retry storm over a process lifetime.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7 — Final verification

- [ ] **Step 7.1: Run the full suite**

```bash
npm test
```

Expected: all tests PASS, including the 11 new ones (2 status-getter + 6 reverify-decision + 3 bulk-check additions).

- [ ] **Step 7.2: Sanity-check the patches don't leak into off-limits files**

```bash
git log --oneline --since="1 day ago" -- src/linkedin/actions.js src/linkedin/outreach.js
```

Expected output: empty (or no commits from this branch).

```bash
git diff drafts-isolation-v2.60.1~10..HEAD -- src/linkedin/actions.js src/linkedin/outreach.js | wc -l
```

Expected output: `0` — these files are untouched on this branch's recent work.

- [ ] **Step 7.3: Auto-relaunch dev:app**

```bash
pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "Electron.*ortus" 2>/dev/null
npm run dev:app > /tmp/dev-app.log 2>&1 &
sleep 8
```

Then:
```bash
grep -E "Fatal: Cannot set property status|^Error" /tmp/dev-app.log
```

Expected: no matches. App boots cleanly.

- [ ] **Step 7.4: Stop dev:app**

```bash
pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "Electron.*ortus" 2>/dev/null
```

- [ ] **Step 7.5: Hand-off summary**

At completion, the branch should have 6 new commits (Task 1 fix + 5 feature commits in Tasks 2-6) plus the existing spec commit (`36aacc5`). Sam can run a CC+IC campaign and observe:
- No `Fatal: Cannot set property status` in the log
- Compose-textbox failures on `CC=Connected` rows trigger a reverify (look for `⤓ ... downgraded` or `↻ ... reverify=...` log lines)
- Repeated compose-textbox failures on the same URL stop after 3 attempts (look for `composeCapped=N` in the bulk-check diag summary)
- Downgraded rows show `Unverified — manual review (May 27th, 2026)` in the `Connection Accepted Status` column

End-to-end CC+IC verification on a live LinkedIn account is operator-side (Sam's next live run); this plan covers everything achievable in the local test+dev:app sandbox.
